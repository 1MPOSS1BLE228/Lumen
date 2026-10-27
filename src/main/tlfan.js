'use strict';
// Вентиляторы Lian Li UNI FAN TL через их собственный контроллер (USB 0416:7372).
// OpenRGB этот контроллер не знает, поэтому у Lumen свой маленький мост (tlfan.ps1):
// он опрашивает, сколько вентиляторов на каждом порту, и красит каждый вентилятор своим цветом.
// Один вентилятор = одна «точка» в Lumen (контроллер принимает цвет на весь вентилятор).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'tlfan.ps1');
const SEND_MS = 66; // ~15 кадров в секунду — контроллеру больше не нужно

// Порты с вентиляторами -> устройства Lumen (по одному на порт)
function portDevices(ports) {
  const list = [];
  (ports || []).forEach((n, port) => {
    n = Math.max(0, Math.min(15, Number(n) || 0));
    if (!n) return;
    list.push({
      id: `lianli:tl:${port}`, port, fans: n,
      name: `Lian Li UNI FAN TL · порт ${port + 1}`, kind: 'fan', vendor: 'Lian Li', source: 'lianli',
      leds: Array.from({ length: n }, (_, i) => ({ x: n === 1 ? 0.5 : i / (n - 1), y: 0.5 })),
      aspect: Math.max(1, n), linear: true, available: true,
    });
  });
  return list;
}

// Цвета всех вентиляторов (по порядку портов) -> строка hex для моста
function colorLine(devices, colors) {
  let hex = '';
  for (const d of devices) {
    const c = colors.get(d.id);
    for (let i = 0; i < d.fans; i++) {
      for (let k = 0; k < 3; k++) hex += ((c && c[i * 3 + k]) || 0).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

class LianLiTL extends EventEmitter {
  constructor({ dataDir, command, args, platform = process.platform } = {}) {
    super();
    this.dataDir = dataDir;
    this.command = command || null;
    this.args = args || [];
    this.platform = platform;
    this.status = { state: 'off', message: '', count: 0 };
    this.devices = [];
    this.colors = new Map();
    this.child = null;
    this.buf = '';
    this.timer = null;
    this.lastLine = '';
    this.lastErr = 0;
  }

  _set(state, message = '') {
    this.status = { state, message, count: this.devices.reduce((s, d) => s + d.fans, 0) };
    this.emit('status', this.status);
  }

  _script() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'tlfan.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    return dest;
  }

  // Запускаем только когда контроллер действительно подключён (Lumen видит его в списке USB)
  start() {
    if (this.child) return;
    if (!this.command && this.platform !== 'win32') return;
    let cmd = this.command, args = this.args;
    if (!cmd) {
      try { args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this._script()]; } catch (e) { this._set('error', e.message); return; }
      cmd = 'powershell.exe';
    }
    this._set('starting', 'Подключаюсь к контроллеру Lian Li…');
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { this._set('error', e.message); return; }
    this.child = child;
    this.buf = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => this._onExit(child, 'error', e.message));
    child.on('exit', (code) => this._onExit(child, code === 0 ? 'off' : 'error', code === 0 ? this.status.message : `мост остановился (код ${code}) ${stderr.trim()}`.trim()));
  }

  _onExit(child, state, message) {
    if (this.child !== child) return;
    this.child = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.devices.length) { this.devices = []; this.emit('devices', []); }
    if (this.status.state !== 'off' || state === 'error') this._set(state, message);
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/^﻿/, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      this._onMessage(m);
    }
  }

  _onMessage(m) {
    if (m.event === 'ports') {
      const ports = Array.isArray(m.ports) ? m.ports : [];
      this.devices = portDevices(ports);
      this.lastLine = '';
      this._set(this.devices.length ? 'ready' : 'empty', this.devices.length ? '' : 'Контроллер Lian Li найден, но вентиляторов на нём не видно');
      this.emit('log', `Lian Li UNI FAN TL: вентиляторов по портам ${ports.join(', ')}`);
      this.emit('devices', this.devices);
    } else if (m.event === 'none' || m.event === 'fatal') {
      this.status = { ...this.status, message: m.message || '' };
      if (m.event === 'fatal') this._set('error', m.message || 'Ошибка моста Lian Li');
      this.emit('log', 'Lian Li UNI FAN TL: ' + (m.message || m.event));
    } else if (m.event === 'error') {
      const now = Date.now();
      if (now - this.lastErr > 10000) { this.lastErr = now; this.emit('log', 'Lian Li UNI FAN TL: ' + m.message); }
    }
  }

  // rgb — тройки r,g,b, по одной на вентилятор. Отправка пачкой не чаще SEND_MS.
  setLeds(devId, rgb) {
    if (!this.child || this.status.state !== 'ready') return false;
    if (!this.devices.some((d) => d.id === devId)) return false;
    this.colors.set(devId, Uint8Array.from(rgb));
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.child) return;
        const line = colorLine(this.devices, this.colors);
        if (line && line !== this.lastLine) { this.lastLine = line; this.child.stdin.write('C ' + line + '\n'); }
      }, SEND_MS);
    }
    return true;
  }

  rescan() { if (this.child) this.child.stdin.write('R\n'); }

  stop() {
    const child = this.child;
    this.child = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (child) {
      try { child.stdin.write('Q\n'); child.stdin.end(); } catch (_) { /* уже закрыт */ }
      setTimeout(() => { try { child.kill(); } catch (_) { /* уже */ } }, 800).unref();
    }
    if (this.devices.length) { this.devices = []; this.emit('devices', []); }
    this._set('off', '');
  }
}

module.exports = { LianLiTL, portDevices, colorLine };
