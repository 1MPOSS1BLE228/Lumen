'use strict';
// Встроенное управление подсветкой средствами Windows 11 (Dynamic Lighting / LampArray).
// Работает без сторонних программ: Lumen запускает невидимый мост PowerShell (lampbridge.ps1),
// находит все совместимые устройства и посылает им цвета.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'lampbridge.ps1');
const POLL_MS = 6000;
const LIST_TIMEOUT_MS = 20000;

const KINDS = { 1: 'keyboard', 2: 'mouse', 3: 'gamepad', 4: 'peripheral', 5: 'light', 6: 'light', 7: 'case', 8: 'wearable', 9: 'light', 10: 'light' };

// Положение ламп (в метрах) -> раскладка 0..1 для превью и пространственных эффектов
function layoutFromBridge(dev) {
  const n = dev.count;
  const pos = Array.isArray(dev.pos) ? dev.pos : [];
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) { xs.push(Number(pos[i * 3]) || 0); ys.push(Number(pos[i * 3 + 1]) || 0); }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const rx = maxX - minX, ry = maxY - minY;
  const eps = 1e-6;
  const leds = xs.map((x, i) => ({
    x: rx > eps ? (x - minX) / rx : 0.5,
    y: ry > eps ? (ys[i] - minY) / ry : 0.5,
  }));
  const linear = ry <= eps || ry < rx * 0.2;
  let aspect;
  if (linear) aspect = 6;
  else aspect = Math.max(0.5, Math.min(6, (rx > eps ? rx : 1) / ry));
  return { leds, aspect, linear };
}

function describe(dev) {
  const lay = layoutFromBridge(dev);
  const kind = KINDS[dev.kind] || 'unknown';
  const hash = crypto.createHash('md5').update(String(dev.id)).digest('hex').slice(0, 8);
  return {
    id: `native:${hash}`, bridgeHandle: dev.handle, name: dev.name || 'Устройство Windows', kind, vendor: 'Windows',
    source: 'native', leds: lay.leds, aspect: lay.aspect, linear: lay.linear,
    plate: kind === 'keyboard' || kind === 'mouse', available: dev.available !== false,
    minInterval: Math.max(16, Number(dev.minInterval) || 0), connected: dev.connected !== false, enabled: dev.enabled !== false,
  };
}

class NativeBackend extends EventEmitter {
  // command/args — для тестов (подмена моста); platform — для тестов
  constructor({ dataDir, command, args, platform = process.platform } = {}) {
    super();
    this.dataDir = dataDir;
    this.command = command || null;
    this.args = args || [];
    this.platform = platform;
    this.status = { state: 'idle', message: '', count: 0 };
    this.devices = [];
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.reqId = 0;
    this.stopping = false;
    this.pollTimer = null;
    this.restartTimer = null;
    this.restartDelay = 3000;
    this.sig = '';
    this.lastSent = new Map();
    this.lastErr = 0;
    this.stderr = '';
  }

  _set(state, message = '') {
    this.status = { state, message, count: this.devices.length };
    this.emit('status', this.status);
  }

  start() {
    this.stopping = false;
    if (this.child) return;
    if (!this.command && this.platform !== 'win32') { this._set('unsupported', 'Встроенное управление работает только в Windows 11'); return; }
    this._set('starting', 'Ищу устройства…');
    this._spawn();
  }

  _scriptPath() {
    // PowerShell не умеет читать файлы из asar-архива, поэтому кладём копию рядом с настройками.
    // Файл пишем с BOM, иначе Windows PowerShell 5.1 неверно прочитает кириллицу.
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'lampbridge.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет файла */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    return dest;
  }

  _spawn() {
    let cmd = this.command, args = this.args;
    if (!cmd) {
      let script;
      try { script = this._scriptPath(); } catch (e) { this._set('error', 'Не удалось подготовить мост: ' + e.message); return; }
      cmd = 'powershell.exe';
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { this._set('error', 'Не удалось запустить PowerShell: ' + e.message); this._scheduleRestart(); return; }
    this.child = child;
    this.buf = '';
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-600); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { if (this.child === child) this._onExit(child, 'Не удалось запустить PowerShell: ' + e.message); });
    child.on('exit', (code) => this._onExit(child, `Мост подсветки остановился (код ${code}). ${this.stderr.trim()}`.trim()));
  }

  _onExit(child, message) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.pollTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Мост остановлен')); }
    this.pending.clear();
    this.lastSent.clear();
    if (this.devices.length) { this.devices = []; this.sig = ''; this.emit('devices', []); }
    if (this.stopping) return;
    this._set('error', message);
    this._scheduleRestart();
  }

  _scheduleRestart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { if (!this.stopping && !this.child) { this._set('starting', 'Перезапускаю…'); this._spawn(); } }, this.restartDelay);
    this.restartDelay = Math.min(30000, this.restartDelay * 2);
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/^﻿/, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.event === 'ready') {
      this.restartDelay = 3000;
      this._refresh();
    } else if (msg.event === 'fatal') {
      this.stopping = true; // перезапуск не поможет
      this._set('error', msg.message || 'Ошибка моста подсветки');
      if (this.child) this.child.kill();
    } else if (msg.event === 'error') {
      const now = Date.now();
      if (now - this.lastErr > 5000) { this.lastErr = now; this.emit('log', 'Ошибка отправки цвета: ' + msg.message); }
    } else if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'Ошибка'));
    }
  }

  _request(obj) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('Мост не запущен')); return; }
      const id = ++this.reqId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Windows не ответила на запрос списка устройств')); }, LIST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
    });
  }

  async _refresh() {
    clearTimeout(this.pollTimer);
    const child = this.child;
    if (!child) return;
    try {
      const res = await this._request({ cmd: 'list' });
      if (this.child !== child) return;
      const raw = Array.isArray(res.devices) ? res.devices : (res.devices ? [res.devices] : []);
      const list = raw.filter((d) => d && d.count > 0 && d.connected !== false).map(describe);
      const sig = list.map((d) => `${d.id}:${d.leds.length}:${d.enabled}:${d.available}`).join('|');
      if (sig !== this.sig) {
        this.sig = sig;
        this.devices = list;
        this.lastSent.clear();
        this._set('ready', '');
        this.emit('devices', list);
      } else if (this.status.state !== 'ready') {
        this._set('ready', '');
      }
    } catch (e) {
      if (this.child === child && this.status.state !== 'ready') this._set('error', e.message);
    }
    if (this.child === child) this.pollTimer = setTimeout(() => this._refresh(), POLL_MS);
  }

  rescan() { if (this.child) this._refresh(); else if (!this.stopping) this.start(); }

  // rgb — Uint8Array из троек r,g,b. Возвращает false, если кадр пропущен (слишком часто или мост занят).
  setLeds(devId, rgb) {
    const d = this.devices.find((x) => x.id === devId);
    if (!d || !this.child || this.status.state !== 'ready') return false;
    const now = Date.now();
    if (now - (this.lastSent.get(devId) || 0) < d.minInterval) return false;
    if (this.child.stdin.writableLength > 256 * 1024) return false;
    this.lastSent.set(devId, now);
    this.child.stdin.write(`S\t${d.bridgeHandle}\t${Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length).toString('base64')}\n`);
    return true;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Остановлено')); }
    this.pending.clear();
    if (child) {
      // Когда мост закрывается, Windows возвращает устройствам их обычную подсветку
      try { child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); child.stdin.end(); } catch (_) { /* уже закрыт */ }
      setTimeout(() => { try { child.kill(); } catch (_) { /* уже завершён */ } }, 800).unref();
    }
    if (this.devices.length) { this.devices = []; this.sig = ''; this.emit('devices', []); }
    this._set('idle', '');
  }
}

module.exports = { NativeBackend, layoutFromBridge, describe };
