'use strict';
// Слой рабочего стола: окно Lumen, спрятанное за значки. Показывает живые волны (на всех мониторах)
// или обычную картинку обоев с виджетами (только на основном мониторе).
// Окно рисует renderer/live.html, а «спрятать за значки» делает помощник desktop.ps1.
// Когда рабочий стол закрыт игрой или развёрнутым окном, экран заблокирован или компьютер спит — всё на паузе.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'desktop.ps1');
const ROOT = path.join(__dirname, '..', '..');

// Помощник: один процесс PowerShell, команды по строкам, ответы по строкам по очереди
class DesktopHelper {
  constructor(scriptPath) {
    this.queue = [];
    this.buf = '';
    this.dead = false;
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.err = '';
    this.child.stderr.on('data', (d) => { this.err = (this.err + d).slice(-500); });
    this.ready = new Promise((resolve, reject) => {
      this._ready = resolve;
      this._fail = reject;
    });
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === 'ready' && this._ready) { this._ready(); this._ready = null; continue; }
        const q = this.queue.shift();
        if (q) { clearTimeout(q.t); q.resolve(line); }
      }
    });
    const die = (why) => {
      if (this.dead) return;
      this.dead = true;
      const e = new Error(why || this.err.trim().split('\n')[0] || 'помощник закрылся');
      if (this._fail) this._fail(e);
      for (const q of this.queue.splice(0)) { clearTimeout(q.t); q.reject(e); }
    };
    this.child.on('exit', () => die());
    this.child.on('error', (e) => die(e.message));
    this.ready.catch(() => {});
  }

  async cmd(line, timeout = 8000) {
    await this.ready;
    if (this.dead) throw new Error('помощник закрылся');
    return new Promise((resolve, reject) => {
      const q = { resolve, reject, t: setTimeout(() => { const k = this.queue.indexOf(q); if (k >= 0) this.queue.splice(k, 1); reject(new Error('помощник не ответил')); }, timeout) };
      this.queue.push(q);
      this.child.stdin.write(line + '\n');
    });
  }

  close() {
    if (this.dead) return;
    try { this.child.stdin.write('quit\n'); } catch (_) { /* уже закрыт */ }
    setTimeout(() => { try { this.child.kill(); } catch (_) { /* уже */ } }, 1500).unref();
  }
}

const { DeskInput } = require('./deskinput');

class LiveWallpaper extends EventEmitter {
  // electron: { BrowserWindow, screen } — передаётся из main.js
  constructor({ electron, dataDir, platform = process.platform } = {}) {
    super();
    this.electron = electron;
    this.dataDir = dataDir;
    this.platform = platform;
    this.enabled = false;
    this.mode = { waves: false, widgets: null, image: null };
    this.suspended = false;
    this.lang = 'ru';
    this.cover = false;
    this.theme = { colors: ['#8b5cff', '#00e5ff'], effect: 'wave', speed: 50 };
    this.windows = []; // { win, rect }
    this.helper = null;
    this.paused = false;
    this.poll = null;
    this.restartTimer = null;
    this.status = { state: 'off', message: '' };
    // Кнопки виджетов («назад / пауза / вперёд»): клики по рабочему столу в этих местах
    this.input = new DeskInput({ dataDir, platform });
    this.input.on('click', (id) => {
      this.emit('action', id);
      for (const w of this.windows) if (w.primary) this._send(w.win, 'live:press', id);
    });
    this.input.on('hover', (id) => { for (const w of this.windows) if (w.primary) this._send(w.win, 'live:hover', id); });
    this.input.on('log', (m) => this.emit('log', m));
    if (electron && electron.ipcMain) {
      electron.ipcMain.on('live:buttons', (e, buttons) => {
        const w = this.windows.find((x) => x.primary && !x.win.isDestroyed() && x.win.webContents === e.sender);
        if (w) this.input.setButtons(Array.isArray(buttons) ? buttons.slice(0, 8) : [], w.rect);
      });
    }
  }

  get available() { return this.platform === 'win32' && !!this.electron; }

  _set(state, message = '') {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit('status', this.status);
  }

  _script() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'desktop.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет файла */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    return dest;
  }

  setTheme({ colors, effect, speed }) {
    this.theme = { colors: (colors || []).slice(0, 6), effect, speed: Number(speed) || 50 };
    for (const w of this.windows) this._send(w.win, 'live:theme', this.theme);
  }

  // Старый вызов: только живые волны
  configure(enabled) { this.update({ ...this.mode, waves: !!enabled }); }

  // waves — живые волны; widgets — настройки виджетов или null; image — файл обоев под виджетами
  update({ waves = false, widgets = null, image = null } = {}) {
    if (!this.available) return;
    const prev = this.mode;
    this.mode = { waves: !!waves, widgets: widgets && widgets.enabled ? widgets : null, image: image || null };
    const enabled = this.mode.waves || !!this.mode.widgets;
    // окна пересоздаём, только если поменялось, на каких мониторах они нужны
    const layoutChanged = prev.waves !== this.mode.waves || !prev.widgets !== !this.mode.widgets;
    if (!enabled) { if (this.enabled) { this.enabled = false; this._stop(); } return; }
    if (!this.enabled || layoutChanged) { this.enabled = true; this._start(); return; }
    for (const w of this.windows) this._sendMode(w);
    if (prev.image !== this.mode.image) {
      for (const w of this.windows) this._sendImage(w);
      // Windows только что сменила обои — сразу проверяем, не накрыл ли Проводник наше окно
      setTimeout(() => this._tick(), 1200).unref();
      setTimeout(() => this._tick(), 3500).unref();
    }
  }

  _imageFile() {
    if (this.mode.image && fs.existsSync(this.mode.image)) return this.mode.image;
    // текущие обои Windows (их копия, которую Windows держит у себя)
    const t = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    return fs.existsSync(t) ? t : '';
  }

  _sendMode(w) {
    this._send(w.win, 'live:mode', { waves: this.mode.waves, widgets: w.primary ? this.mode.widgets : null });
  }

  _sendImage(w) {
    if (this.mode.waves) return;
    const f = this._imageFile();
    if (!f) return;
    fs.readFile(f, (e, buf) => { if (!e) this._send(w.win, 'live:image', buf); });
  }

  // Счётчики сети (для виджета): { id: [принято, отправлено] } или null
  async netCounters() {
    if (!this.helper || this.helper.dead || !this.windows.length) return null;
    try {
      const line = await this.helper.cmd('net', 4000);
      if (!line || line === '-' || line.startsWith('fail')) return null;
      const out = {};
      for (const part of line.split(';')) {
        const [id, r, s] = part.split(':');
        if (id && r) out[id] = [Number(r), Number(s)];
      }
      return out;
    } catch (_) { return null; }
  }

  setLang(lang) {
    this.lang = lang || 'ru';
    for (const w of this.windows) this._send(w.win, 'live:lang', this.lang);
  }

  setWidgetData(d) {
    for (const w of this.windows) if (w.primary) this._send(w.win, 'live:data', d);
  }

  // Экран заблокирован / компьютер спит — замираем
  setSuspended(on) {
    this.suspended = !!on;
    this._applyPause();
  }

  _applyPause() {
    const p = this.cover || this.suspended;
    if (p === this.paused) return;
    this.paused = p;
    this.input.setPaused(p); // рабочий стол закрыт — за мышью не следим вовсе
    for (const w of this.windows) this._send(w.win, 'live:pause', p);
    this.emit('paused', p);
  }

  _send(win, ch, data) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(ch, data);
  }

  async _start() {
    this._stop(true);
    this._set('working', 'Запускаю живые обои…');
    try {
      if (!this.helper || this.helper.dead) this.helper = new DesktopHelper(this._script());
      await this.helper.ready;
      const { BrowserWindow, screen } = this.electron;
      const modes = [];
      const primaryId = screen.getPrimaryDisplay().id;
      // виджеты без волн — только основной монитор, на остальных остаются обычные обои
      const displays = this.mode.waves ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
      for (const d of displays) {
        const rect = screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
        const win = new BrowserWindow({
          x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
          show: false, frame: false, skipTaskbar: true, focusable: false, resizable: false, movable: false,
          minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, thickFrame: false,
          backgroundColor: '#06060b', title: 'Lumen Live',
          webPreferences: { preload: path.join(__dirname, 'live-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
        });
        const entry = { win, rect, primary: d.id === primaryId };
        this.windows.push(entry);
        win.on('closed', () => {
          this.windows = this.windows.filter((x) => x !== entry);
          // Проводник перезапустился и забрал окно с собой — поднимем заново
          if (this.enabled && !this.stopping) this._restartSoon('окно обоев закрылось');
        });
        await win.loadFile(path.join(ROOT, 'src', 'renderer', 'live.html'));
        this._send(win, 'live:lang', this.lang);
        this._sendMode(entry);
        this._send(win, 'live:theme', this.theme);
        this._sendImage(entry);
        if (this.paused) this._send(win, 'live:pause', true);
        const hwnd = win.getNativeWindowHandle();
        const id = hwnd.length >= 8 ? hwnd.readBigUInt64LE(0).toString() : String(hwnd.readUInt32LE(0));
        entry.id = id;
        const r = `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
        const mode = await this.helper.cmd(`attach ${id} ${r}`);
        if (mode.startsWith('fail')) throw new Error(mode.slice(5));
        modes.push(mode);
        win.showInactive();
        await this.helper.cmd(`place ${id} ${r}`);
      }
      this._applyPause();
      this._set('ok', '');
      this.emit('log', `Живые обои: за значками (${modes.join(', ')})`);
      this.poll = setInterval(() => this._tick(), 2000);
      if (this.poll.unref) this.poll.unref();
    } catch (e) {
      this._stop(true);
      this._set('error', 'Живые обои не запустились: ' + e.message + '. Стоят обычные волны.');
    }
  }

  async _tick() {
    if (!this.helper || this.helper.dead) { this._restartSoon('помощник закрылся'); return; }
    try {
      for (const w of this.windows) {
        const r = w.id ? await this.helper.cmd(`check ${w.id}`) : 'ok';
        if (r === 'lost') { this._restartSoon('Проводник перезапустился'); return; }
        if (r === 'fixed' && !w.fixedLogged) { w.fixedLogged = true; this.emit('log', 'Живые обои: Проводник поднял свой слой обоев выше — вернул наше окно под значки'); }
      }
      this.cover = (await this.helper.cmd('cover')) === '1';
      this._applyPause();
    } catch (_) { /* следующая попытка через 2 с */ }
  }

  _restartSoon(why) {
    if (this.restartTimer || !this.enabled) return;
    this.emit('log', `Живые обои: перезапуск (${why})`);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.enabled) this._start(); }, 3000);
  }

  _stop(keepHelper = false) {
    clearInterval(this.poll);
    this.poll = null;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopping = true;
    for (const w of this.windows.splice(0)) { try { if (!w.win.isDestroyed()) w.win.destroy(); } catch (_) { /* уже */ } }
    this.stopping = false;
    this.paused = false;
    this.cover = false;
    if (!keepHelper && this.helper) { this.helper.close(); this.helper = null; }
    this.input.stop();
    if (!keepHelper) this._set('off', '');
  }

  shutdown() {
    this.enabled = false;
    this._stop();
  }
}

module.exports = { LiveWallpaper, DesktopHelper };
