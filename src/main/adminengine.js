'use strict';
// Движок с правами администратора — нужен для оперативной памяти (и части плат): к ним движок
// достучится только через драйвер PawnIO и только с правами администратора.
// setup() один раз спрашивает у Windows разрешение, ставит PawnIO и задачу планировщика «Lumen Engine».
// Дальше start() запускает движок через эту задачу без вопросов, stop() его останавливает.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const TASK = 'Lumen Engine';

class AdminEngine extends EventEmitter {
  // engineDir — папка встроенного OpenRGB; pawnio — путь к PawnIO_setup.exe
  constructor({ dataDir, engineDir, pawnio, platform = process.platform, programFiles = process.env.ProgramFiles || 'C:\\Program Files' } = {}) {
    super();
    this.dataDir = dataDir;
    this.engineDir = engineDir;
    this.pawnio = pawnio;
    this.platform = platform;
    this.dest = path.join(programFiles, 'Lumen Engine');
    this.status = { state: 'off', message: '' };
  }

  get available() { return this.platform === 'win32' && !!this.engineDir && fs.existsSync(this.engineDir) && !!this.pawnio && fs.existsSync(this.pawnio); }
  // Уже настроено (движок лежит в Program Files)
  installed() { return this.platform === 'win32' && fs.existsSync(path.join(this.dest, 'engine-run.ps1')) && fs.existsSync(path.join(this.dest, 'OpenRGB', 'OpenRGB.exe')); }

  _set(state, message = '') { this.status = { state, message }; this.emit('status', this.status); }

  _copy(name) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, name);
    fs.writeFileSync(dest, '\ufeff' + fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/^\ufeff/, ''), 'utf8');
    return dest;
  }

  setup() {
    if (!this.available) return Promise.resolve({ ok: false, message: 'Недоступно на этом компьютере' });
    this._set('working', 'Подтверди в окне Windows «Разрешить этому приложению вносить изменения»…');
    const setup = this._copy('engine-setup.ps1');
    const run = this._copy('engine-run.ps1');
    const result = path.join(this.dataDir, 'engine-setup-result.json');
    try { fs.unlinkSync(result); } catch (_) { /* нет */ }
    const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
    const q = (s) => `"${String(s).replace(/"/g, '')}"`;
    const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', q(setup), '-Source', q(this.engineDir), '-PawnIO', q(this.pawnio), '-RunScript', q(run), '-User', q(user), '-Result', q(result)].join(' ');
    const cmd = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${inner.replace(/'/g, "''")}'`;
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* уже */ } }, 5 * 60000);
      const finish = () => {
        clearTimeout(timer);
        let r = null;
        try { r = JSON.parse(fs.readFileSync(result, 'utf8').replace(/^\ufeff/, '')); } catch (_) { /* нет результата */ }
        if (!r) {
          const cancelled = /отмен|cancel/i.test(err);
          r = { ok: false, message: cancelled ? 'Ты отменил разрешение в окне Windows' : (err.trim().split('\n')[0] || 'Не получилось получить права администратора') };
        }
        if (r.ok) this._set('ok', r.pawnio === 'installed' ? 'Драйвер PawnIO установлен' : '');
        else this._set('error', r.message);
        resolve(r);
      };
      child.on('exit', finish);
      child.on('error', (e) => { err = e.message; finish(); });
    });
  }

  // Запустить движок через задачу (без окна «Разрешить?»). Возвращает Promise<boolean>.
  start(port) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      try { fs.unlinkSync(path.join(this.dataDir, 'engine-stop')); } catch (_) { /* нет */ }
      fs.writeFileSync(path.join(this.dataDir, 'engine-request.json'), JSON.stringify({ pid: process.pid, port: Number(port) || 6742 }));
    } catch (_) { return Promise.resolve(false); }
    return new Promise((resolve) => {
      execFile('schtasks.exe', ['/run', '/tn', TASK], { windowsHide: true, timeout: 10000 }, (e) => resolve(!e));
    });
  }

  stop() {
    try { fs.writeFileSync(path.join(this.dataDir, 'engine-stop'), '1'); } catch (_) { /* папки нет */ }
  }
}

module.exports = { AdminEngine };
