'use strict';
// Автообновление: смотрим последний выпуск Lumen на GitHub, скачиваем установщик в фоне,
// проверяем контрольную сумму SHA-256 и по кнопке ставим (установщик сам перезапустит Lumen).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const CHECK_EVERY_MS = 6 * 3600000;

// 2.10.0 > 2.9.3; 'v2.9.0' -> [2,9,0]
function parseVer(v) { return String(v || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0); }
function newer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

class Updater extends EventEmitter {
  // repo: 'owner/name'; fetchImpl — сеть (в приложении net.fetch, учитывает прокси)
  constructor({ repo, version, dataDir, fetchImpl, platform = process.platform } = {}) {
    super();
    this.repo = repo || '';
    this.version = version;
    this.dir = path.join(dataDir, 'updates');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.platform = platform;
    this.timer = null;
    this.release = null;
    this.status = { state: 'idle', message: '', version: '', notes: '', progress: 0, url: '' };
  }

  get available() { return !!this.repo && this.platform === 'win32'; }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  start(auto) {
    clearInterval(this.timer);
    this.timer = null;
    if (!auto || !this.available) return;
    setTimeout(() => this.check({ download: true }), 45000).unref();
    this.timer = setInterval(() => this.check({ download: true }), CHECK_EVERY_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async _json(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Lumen-updater' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async check({ download = false } = {}) {
    if (!this.available) return this.status;
    if (['downloading', 'installing'].includes(this.status.state)) return this.status;
    this._set({ state: 'checking', message: '' });
    try {
      const rel = await this._json(`https://api.github.com/repos/${this.repo}/releases/latest`);
      if (!rel || !rel.tag_name) { this._set({ state: 'latest', message: '' }); return this.status; }
      const ver = rel.tag_name.replace(/^v/i, '');
      const exe = (rel.assets || []).find((a) => /^Lumen-Setup-.*\.exe$/i.test(a.name));
      if (!newer(ver, this.version) || !exe) { this._set({ state: 'latest', version: ver, message: '' }); return this.status; }
      // контрольная сумма: поле digest у GitHub или файл .sha256 рядом с установщиком
      let sha = /^sha256:([0-9a-f]{64})$/i.exec(exe.digest || '');
      sha = sha ? sha[1].toLowerCase() : '';
      if (!sha) {
        const sumAsset = (rel.assets || []).find((a) => a.name === exe.name + '.sha256');
        if (sumAsset) {
          const r = await this.fetch(sumAsset.browser_download_url, { headers: { 'User-Agent': 'Lumen-updater' } });
          const m = /([0-9a-f]{64})/i.exec(await r.text());
          if (m) sha = m[1].toLowerCase();
        }
      }
      if (!sha) throw new Error('у выпуска нет контрольной суммы — не скачиваю');
      if (!/^https:\/\/github\.com\//.test(exe.browser_download_url)) throw new Error('странная ссылка на установщик');
      this.release = { version: ver, url: exe.browser_download_url, name: exe.name, size: exe.size, sha, notes: String(rel.body || '').slice(0, 3000), page: rel.html_url };
      this._set({ state: 'available', version: ver, notes: this.release.notes, url: rel.html_url, message: '', progress: 0 });
      if (download) await this.download();
    } catch (e) {
      this._set({ state: 'error', message: e.name === 'AbortError' ? 'GitHub не ответил' : /fetch failed|ENOTFOUND|net::/i.test(e.message) ? 'нет интернета' : e.message });
    }
    return this.status;
  }

  async download() {
    const rel = this.release;
    if (!rel) return this.status;
    const file = path.join(this.dir, rel.name);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // уже скачан и цел — не качаем заново
      if (fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === rel.sha) {
        this.file = file;
        this._set({ state: 'ready', progress: 100 });
        return this.status;
      }
      this._set({ state: 'downloading', progress: 0, message: '' });
      const r = await this.fetch(rel.url, { headers: { 'User-Agent': 'Lumen-updater' } });
      if (!r.ok || !r.body) throw new Error(`не скачался (${r.status})`);
      const total = Number(r.headers.get('content-length')) || rel.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file + '.part');
      let got = 0, lastPct = -1;
      for await (const chunk of r.body) {
        const b = Buffer.from(chunk);
        hash.update(b);
        got += b.length;
        if (!out.write(b)) await new Promise((res) => out.once('drain', res));
        const pct = total ? Math.floor((got * 100) / total) : 0;
        if (pct !== lastPct) { lastPct = pct; this._set({ progress: pct }); }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (hash.digest('hex') !== rel.sha) { fs.rmSync(file + '.part', { force: true }); throw new Error('контрольная сумма не совпала — файл испорчен, удалил'); }
      fs.renameSync(file + '.part', file);
      // старые установщики не копим
      for (const f of fs.readdirSync(this.dir)) if (f !== rel.name) { try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch (_) { /* занят */ } }
      this.file = file;
      this._set({ state: 'ready', progress: 100 });
    } catch (e) {
      this._set({ state: 'error', message: 'Обновление не скачалось: ' + e.message });
    }
    return this.status;
  }

  // Запустить установщик тихо; он закроет старый Lumen, поставит новый и запустит его
  install() {
    if (this.status.state !== 'ready' || !this.file) return false;
    this._set({ state: 'installing' });
    const child = spawn(this.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
}

module.exports = { Updater, newer, parseVer };
