'use strict';
// Датчики: температура и загрузка видеокарты NVIDIA через nvidia-smi (ставится вместе с драйвером).
const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

const POLL_MS = 2000;

function parseNvidiaSmi(out) {
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d/.test(l));
  if (!line) return null;
  const [t, u, mu, mt, pw] = line.split(',').map((x) => Number(String(x).trim()));
  if (!Number.isFinite(t)) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  return { gpuTemp: t, gpuLoad: n(u), vramUsed: n(mu), vramTotal: n(mt), gpuPower: n(pw) == null ? null : Math.round(pw) };
}

class Sensors extends EventEmitter {
  // command — для тестов; platform — для тестов
  constructor({ command, args, platform = process.platform } = {}) {
    super();
    this.command = command || null;
    this.args = args || null;
    this.platform = platform;
    this.data = { gpuTemp: null, gpuLoad: null, ok: false, message: '' };
    this.timer = null;
    this.busy = false;
  }

  _cmd() {
    if (this.command) return [this.command, this.args || []];
    const q = ['--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw', '--format=csv,noheader,nounits'];
    const alt = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe';
    return [this.platform === 'win32' && fs.existsSync(alt) ? alt : 'nvidia-smi', q];
  }

  // Один постоянный процесс nvidia-smi, который сам печатает значения раз в N секунд (-l), —
  // намного дешевле, чем запускать программу заново каждые 2 секунды.
  start(periodSec = POLL_MS / 1000) {
    if (this.timer) return;
    const period = Math.max(1, Math.round(periodSec));
    this.timer = { period };
    const [cmd, args] = this._cmd();
    const loopArgs = this.command ? args : [...args, '-l', String(period)];
    let child;
    try { child = spawn(cmd, loopArgs, { windowsHide: true }); } catch (_) { this._fail(); return; }
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const r = parseNvidiaSmi(line);
        if (r) this._emit({ ...r, ok: true, message: '' });
      }
    });
    child.on('error', () => { if (this.child === child) this._fail(); });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      const r = parseNvidiaSmi(buf);
      if (r) this._emit({ ...r, ok: true, message: '' });
      else if (!this.data.ok) this._emit({ gpuTemp: null, gpuLoad: null, ok: false, message: 'Не удалось прочитать температуру видеокарты' });
      // для тестовой команды (печатает один раз) — перезапуск по таймеру
      if (this.timer) this.timer.retry = setTimeout(() => { const p0 = this.timer && this.timer.period; this.timer = null; if (p0) this.start(p0); }, period * 1000);
    });
  }

  _fail() { this._emit({ gpuTemp: null, gpuLoad: null, ok: false, message: 'Не нашёл nvidia-smi: температура доступна только для видеокарт NVIDIA' }); }

  _emit(data) {
    if (data.ok !== this.data.ok || data.message !== this.data.message) this.emit('log', `Датчик видеокарты: ${data.ok ? `${data.gpuTemp} °C` : data.message}`);
    this.data = data;
    this.emit('data', data);
  }

  stop() {
    if (this.timer && this.timer.retry) clearTimeout(this.timer.retry);
    this.timer = null;
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch (_) { /* уже */ } }
  }

  // Разовый опрос (для диагностики и тестов)
  poll() {
    if (this.busy) return Promise.resolve(this.data);
    this.busy = true;
    const [cmd, args] = this._cmd();
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (data) => { if (done) return; done = true; this.busy = false; this._emit(data); resolve(data); };
      let child;
      try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { this._fail(); resolve(this.data); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* уже завершён */ } finish({ ...this.data, ok: false, message: 'Видеокарта не ответила вовремя' }); }, 5000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { clearTimeout(timer); finish({ gpuTemp: null, gpuLoad: null, ok: false, message: 'Не нашёл nvidia-smi: температура доступна только для видеокарт NVIDIA' }); });
      child.on('exit', () => {
        clearTimeout(timer);
        const r = parseNvidiaSmi(out);
        finish(r ? { ...r, ok: true, message: '' } : { gpuTemp: null, gpuLoad: null, ok: false, message: 'Не удалось прочитать температуру видеокарты' });
      });
    });
  }
}

module.exports = { Sensors, parseNvidiaSmi };
