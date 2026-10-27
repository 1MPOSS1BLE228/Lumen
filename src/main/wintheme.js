'use strict';
// Цвет оформления Windows: акцентный цвет (панель задач, заголовки окон, «Пуск») под текущую тему подсветки.
// Меняет только настройки текущего пользователя. Перед первым изменением сохраняет резервную копию
// и умеет вернуть всё как было.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'wintheme.ps1');
const DEBOUNCE_MS = 1500;
const TIMEOUT_MS = 20000;

function defaultRunner(scriptPath) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows не ответила вовремя')); }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error((err.trim().split('\n')[0] || `Код выхода ${code}`)));
    });
  });
}

class WinTheme extends EventEmitter {
  // runner(args) -> Promise<stdout>; platform — для тестов
  constructor({ dataDir, runner, platform = process.platform } = {}) {
    super();
    this.dataDir = dataDir;
    this.platform = platform;
    this.runner = runner || null;
    this.backupFile = path.join(dataDir, 'wintheme-backup.json');
    this.cfg = { enabled: false, forceDark: false };
    this.accent = null;
    this.applied = null;
    this.timer = null;
    this.chain = Promise.resolve();
    this.status = { state: 'off', message: '' };
  }

  get available() { return !!this.runner || this.platform === 'win32'; }

  _runner() {
    if (this.runner) return this.runner;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'wintheme.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет файла */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    this.runner = defaultRunner(dest);
    return this.runner;
  }

  _set(state, message = '') { this.status = { state, message }; this.emit('status', this.status); }
  _queue(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }

  hasBackup() { return fs.existsSync(this.backupFile); }
  _readBackup() { try { return JSON.parse(fs.readFileSync(this.backupFile, 'utf8')); } catch (_) { return null; } }

  async _ensureBackup() {
    if (this.hasBackup()) return;
    const out = await this._runner()(['-Action', 'Read']);
    const json = JSON.parse(out.trim());
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.backupFile, JSON.stringify(json));
  }

  // Вызывается при изменении настроек
  configure({ enabled, forceDark }) {
    if (!this.available) return Promise.resolve();
    const wasEnabled = this.cfg.enabled;
    const dark = !!forceDark;
    const changed = enabled !== wasEnabled || dark !== this.cfg.forceDark;
    this.cfg = { enabled: !!enabled, forceDark: dark };
    if (!changed) return Promise.resolve();
    if (!enabled) return this.restore();
    this.applied = null;
    return this._schedule(0);
  }

  setAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    this.accent = hex.toLowerCase();
    if (this.cfg.enabled && this.accent !== this.applied) this._schedule(DEBOUNCE_MS);
  }

  _schedule(delay) {
    clearTimeout(this.timer);
    return new Promise((resolve) => {
      this.timer = setTimeout(() => { this.timer = null; this._apply().then(resolve, resolve); }, delay);
      if (this.timer.unref) this.timer.unref();
    });
  }

  _apply() {
    return this._queue(async () => {
      if (!this.cfg.enabled || !this.accent) return;
      const hex = this.accent;
      try {
        this._set('working', '');
        await this._ensureBackup();
        const args = ['-Action', 'Apply', '-Accent', hex.slice(1)];
        if (this.cfg.forceDark) args.push('-Dark', '1');
        await this._runner()(args);
        this.applied = hex;
        this._set('ok', '');
      } catch (e) {
        this._set('error', 'Не удалось изменить цвет Windows: ' + e.message);
      }
    });
  }

  restore() {
    clearTimeout(this.timer);
    this.timer = null;
    return this._queue(async () => {
      const backup = this._readBackup();
      if (!backup) { this._set('off', ''); return; }
      try {
        await this._runner()(['-Action', 'Restore', '-Backup', Buffer.from(JSON.stringify(backup), 'utf8').toString('base64')]);
        fs.unlinkSync(this.backupFile);
        this.applied = null;
        this._set('off', '');
      } catch (e) {
        this._set('error', 'Не удалось вернуть прежний цвет Windows: ' + e.message);
      }
    });
  }

  // При выходе: вернуть оформление, если так настроено
  async shutdown({ restore }) {
    clearTimeout(this.timer);
    this.timer = null;
    if (restore && this.hasBackup()) await this.restore();
    else await this.chain;
  }
}

module.exports = { WinTheme };
