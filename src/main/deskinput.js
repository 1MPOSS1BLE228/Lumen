'use strict';
// Кнопки виджетов на рабочем столе: помощник deskinput.ps1 сообщает, что щёлкнули по кнопке.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'deskinput.ps1');

// Кнопки в долях окна обоев + прямоугольник окна в пикселях экрана -> строка для помощника
function rectsLine(buttons, win) {
  const out = [];
  for (const b of buttons || []) {
    if (!b || !/^[a-z]{2,12}$/.test(String(b.id))) continue;
    const l = Math.round(win.x + b.x * win.width), t = Math.round(win.y + b.y * win.height);
    const r = Math.round(win.x + (b.x + b.w) * win.width), btm = Math.round(win.y + (b.y + b.h) * win.height);
    if (r - l < 4 || btm - t < 4) continue;
    out.push(`${b.id} ${l} ${t} ${r} ${btm}`);
  }
  return 'R ' + out.join(';');
}

class DeskInput extends EventEmitter {
  constructor({ dataDir, command, args, platform = process.platform } = {}) {
    super();
    this.dataDir = dataDir;
    this.command = command || null;
    this.args = args || [];
    this.platform = platform;
    this.child = null;
    this.buf = '';
    this.line = 'R ';
    this.paused = false;
    this.failed = 0;
  }

  _script() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'deskinput.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    return dest;
  }

  _spawn() {
    if (this.child || (!this.command && this.platform !== 'win32') || this.failed > 3) return;
    let cmd = this.command, args = this.args;
    if (!cmd) { cmd = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this._script()]; }
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (_) { this.failed++; return; }
    this.child = child;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', (code) => { if (this.child === child) { this.child = null; if (code) this.failed++; } });
    this._write(this.line);
    if (this.paused) this._write('P');
  }

  _write(s) { if (this.child) try { this.child.stdin.write(s + '\n'); } catch (_) { /* закрыт */ } }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/^﻿/, '').trim();
      this.buf = this.buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.event === 'click' && m.id) this.emit('click', m.id);
      else if (m.event === 'hover') this.emit('hover', m.id || '');
      else if (m.event === 'fatal') { this.failed = 99; this.emit('log', 'Кнопки виджетов: помощник не запустился'); }
    }
  }

  // buttons: [{id, x, y, w, h}] в долях окна; win — окно обоев в пикселях экрана
  setButtons(buttons, win) {
    const line = buttons && buttons.length && win ? rectsLine(buttons, win) : 'R ';
    if (line === this.line) return;
    this.line = line;
    if (line === 'R ') { this._write(line); return; }
    if (!this.child) this._spawn(); else this._write(line);
  }

  setPaused(p) {
    if (this.paused === !!p) return;
    this.paused = !!p;
    this._write(this.paused ? 'P' : 'U');
  }

  stop() {
    const c = this.child;
    this.child = null;
    this.line = 'R ';
    if (c) { try { c.stdin.write('Q\n'); c.stdin.end(); } catch (_) { /* уже */ } setTimeout(() => { try { c.kill(); } catch (_) { /* уже */ } }, 800).unref(); }
  }
}

module.exports = { DeskInput, rectsLine };
