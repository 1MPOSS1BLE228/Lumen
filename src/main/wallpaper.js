'use strict';
// Обои Windows в цветах темы: Lumen рисует картинку сам (без библиотек) и ставит её на рабочий стол.
// Перед первой заменой сохраняет прежние обои и умеет вернуть их.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'wallpaper.ps1');
const { STYLES, makeShader } = require('./wallstyles');
const { PhotoSource } = require('./photos');
const DEBOUNCE_MS = 2500;

// --- PNG ---------------------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgbRows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // RGB, 8 бит
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rgbRows, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const RAINBOW = ['#ff2a2a', '#ffb000', '#9dff00', '#00e5a0', '#00a2ff', '#8b3dff', '#ff2bd6'];

// Тёмный фон и мягкие цветные «сияния» в цветах темы, без полос (с лёгким шумом)
function renderWallpaper(opts) {
  const job = wallpaperJob(opts);
  while (!job.step(Infinity)) { /* всё сразу */ }
  return { png: encodePNG(job.W, job.H, job.rows), width: job.W, height: job.H };
}

// То же, но порциями с паузами: главный процесс не замирает, подсветка не дёргается
async function renderWallpaperAsync(opts) {
  const job = wallpaperJob(opts);
  while (!job.step(48)) await new Promise((r) => setImmediate(r));
  const data = await new Promise((res, rej) => zlib.deflate(job.rows, { level: 6 }, (e, d) => (e ? rej(e) : res(d))));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(job.W, 0); ihdr.writeUInt32BE(job.H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0))]);
  return { png, width: job.W, height: job.H };
}

function wallpaperJob({ colors, effect, width = 1920, height = 1080, style = 'waves' }) {
  const pal = (effect === 'rainbow' ? RAINBOW : colors && colors.length ? colors : ['#8b5cff']).slice(0, 6).map(hexRgb);
  const W = Math.max(64, Math.min(7680, Math.round(width))), H = Math.max(64, Math.min(4320, Math.round(height)));
  // Абстрактные стили считаются по каждому пикселю
  const shader = makeShader(style, pal.length > 1 ? pal : [pal[0], pal[0].map((v) => v * 0.55)], W, H);
  if (shader) {
    const rows = Buffer.alloc((W * 3 + 1) * H);
    let seed = 777, y = 0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const step = (maxRows) => {
      for (const yEnd = Math.min(H, y + maxRows); y < yEnd; y++) {
        const ro = y * (W * 3 + 1);
        rows[ro] = 0;
        for (let x = 0; x < W; x++) {
          const c = shader(x + 0.5, y + 0.5);
          const n = (rnd() - 0.5) * 2;
          rows[ro + 1 + x * 3] = Math.max(0, Math.min(255, Math.round(c[0] + n)));
          rows[ro + 2 + x * 3] = Math.max(0, Math.min(255, Math.round(c[1] + n)));
          rows[ro + 3 + x * 3] = Math.max(0, Math.min(255, Math.round(c[2] + n)));
        }
      }
      return y >= H;
    };
    return { W, H, rows, step };
  }
  // Сияния: позиции подобраны для гармоничной композиции
  const spots = [[0.12, 0.18, 0.75], [0.88, 0.85, 0.8], [0.78, 0.15, 0.55], [0.25, 0.92, 0.55], [0.55, 0.5, 0.5], [0.5, 0.05, 0.45]];
  const blobs = pal.map((c, i) => ({ c, x: spots[i % spots.length][0], y: spots[i % spots.length][1], r: spots[i % spots.length][2] }));
  if (blobs.length === 1) blobs.push({ c: blobs[0].c.map((v) => v * 0.6), x: 0.85, y: 0.8, r: 0.6 });
  // Считаем на сетке 1/8 и сглаженно растягиваем — быстро и без ступенек
  const gw = Math.ceil(W / 8) + 2, gh = Math.ceil(H / 8) + 2;
  const aspect = W / H;
  const grid = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = (gx * 8) / W, y = (gy * 8) / H;
      let r = 7, g = 7, b = 12; // почти чёрный с холодным оттенком
      for (const bl of blobs) {
        const dx = (x - bl.x) * aspect, dy = y - bl.y;
        const k = Math.exp(-(dx * dx + dy * dy) / (bl.r * bl.r * 0.35)) * 0.62;
        r += bl.c[0] * k; g += bl.c[1] * k; b += bl.c[2] * k;
      }
      // лёгкая диагональная волна для глубины
      const wave = 0.9 + 0.1 * Math.sin((x * 1.3 + y * 0.9) * Math.PI);
      const o = (gy * gw + gx) * 3;
      grid[o] = r * wave; grid[o + 1] = g * wave; grid[o + 2] = b * wave;
    }
  }
  const rows = Buffer.alloc((W * 3 + 1) * H);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let y = 0;
  const step = (maxRows) => {
  for (const yEnd = Math.min(H, y + maxRows); y < yEnd; y++) {
    const fy = y / 8, y0 = Math.floor(fy), ty = fy - y0;
    const ro = y * (W * 3 + 1);
    rows[ro] = 0;
    for (let x = 0; x < W; x++) {
      const fx = x / 8, x0 = Math.floor(fx), tx = fx - x0;
      const i00 = (y0 * gw + x0) * 3, i10 = i00 + 3, i01 = i00 + gw * 3, i11 = i01 + 3;
      const n = (rnd() - 0.5) * 2.2;
      for (let ch = 0; ch < 3; ch++) {
        const v = (grid[i00 + ch] * (1 - tx) + grid[i10 + ch] * tx) * (1 - ty) + (grid[i01 + ch] * (1 - tx) + grid[i11 + ch] * tx) * ty;
        rows[ro + 1 + x * 3 + ch] = Math.max(0, Math.min(255, Math.round(v + n)));
      }
    }
  }
  return y >= H;
  };
  return { W, H, rows, step };
}

function defaultRunner(scriptPath) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows не ответила вовремя')); }, 20000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(err.trim().split('\n')[0] || `Код выхода ${code}`)); });
  });
}

class Wallpaper extends EventEmitter {
  // getSize() -> {width,height}; runner(args) -> Promise<stdout> — для тестов
  constructor({ dataDir, runner, getSize, platform = process.platform, photos } = {}) {
    super();
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'wallpapers');
    this.backupFile = path.join(dataDir, 'wallpaper-backup.json');
    this.runner = runner || null;
    this.getSize = getSize || (() => ({ width: 1920, height: 1080 }));
    this.platform = platform;
    this.photos = photos || new PhotoSource({ dataDir, getSize: this.getSize });
    this.enabled = false;
    this.want = null;
    this.appliedKey = '';
    this.timer = null;
    this.chain = Promise.resolve();
    this.status = { state: 'off', message: '' };
  }

  get available() { return !!this.runner || this.platform === 'win32'; }

  _runner() {
    if (this.runner) return this.runner;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'wallpaper.ps1');
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

  // photo — выбранная фотография для темы (для стиля «Фото под тему»), accent — главный цвет темы
  setTheme({ colors, effect, style, photo = null, accent = '' }) {
    this.want = { colors: colors.slice(), effect, style: STYLES[style] ? style : 'waves', photo, accent: accent || colors[0] };
    if (this.enabled && this._key() !== this.appliedKey) this._schedule(DEBOUNCE_MS);
  }

  _key() { return this.want ? `${this.want.style}|${this.want.effect === 'rainbow' ? 'rainbow' : this.want.colors.join()}|${this.want.style === 'photo' && this.want.photo ? this.want.photo.id : ''}` : ''; }

  configure(enabled) {
    if (!this.available) return Promise.resolve();
    if (!!enabled === this.enabled) return Promise.resolve();
    this.enabled = !!enabled;
    if (!enabled) return this.restore();
    this.appliedKey = '';
    return this._schedule(0);
  }

  _schedule(delay) {
    clearTimeout(this.timer);
    return new Promise((resolve) => {
      this.timer = setTimeout(() => { this.timer = null; this._apply().then(resolve, resolve); }, delay);
      if (this.timer.unref) this.timer.unref();
    });
  }

  async _ensureBackup() {
    if (this.hasBackup()) return;
    const info = JSON.parse((await this._runner()(['-Action', 'Read'])).trim());
    // Windows перезаписывает свою копию обоев при смене, поэтому сохраняем её заранее
    let copy = '';
    const src = info.path && fs.existsSync(info.path) && !/TranscodedWallpaper$/i.test(info.path) ? '' : info.transcoded;
    if (src && fs.existsSync(src)) {
      fs.mkdirSync(this.dir, { recursive: true });
      copy = path.join(this.dir, 'original-wallpaper.jpg');
      fs.copyFileSync(src, copy);
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.backupFile, JSON.stringify({ ...info, copy }));
  }

  _apply() {
    return this._queue(async () => {
      if (!this.enabled || !this.want) return;
      const key = this._key();
      try {
        this._set('working', '');
        await this._ensureBackup();
        const size = this.getSize();
        fs.mkdirSync(this.dir, { recursive: true });
        let file = null, note = '';
        if (this.want.style === 'photo') {
          try {
            let item = this.want.photo;
            if (!item) {
              this._set('working', 'Подбираю фото под тему…');
              const r = await this.photos.search(this.want.accent, 1);
              item = r.items[0];
              if (!item) throw new Error('под этот цвет ничего не нашлось');
            }
            this._set('working', 'Загружаю фото…');
            file = await this.photos.full(item);
          } catch (e) { note = `Фото не загрузилось (${e.message}), поставил «Волны»`; }
          if (this.want && this._key() !== key) return; // пока грузили, тема сменилась
        }
        if (!file) {
          const { png } = await renderWallpaperAsync({ ...this.want, style: this.want.style === 'photo' ? 'waves' : this.want.style, width: size.width, height: size.height });
          if (this.want && this._key() !== key) return; // пока рисовали, тема сменилась — нарисуем новую
          // Новое имя каждый раз — иначе Windows может показать старую картинку из кэша
          file = path.join(this.dir, `lumen-${Date.now().toString(36)}.png`);
          fs.writeFileSync(file, png);
        }
        await this._runner()(['-Action', 'Set', '-Path', file]);
        for (const f of fs.readdirSync(this.dir)) {
          if (/^lumen-.*\.png$/.test(f) && path.join(this.dir, f) !== file) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) { /* занят */ } }
        }
        this.appliedKey = key;
        this.lastFile = file;
        this.emit('applied', file);
        this._set(note ? 'warn' : 'ok', note);
      } catch (e) {
        this._set('error', 'Не удалось поменять обои: ' + e.message);
      }
    });
  }

  restore() {
    clearTimeout(this.timer);
    this.timer = null;
    return this._queue(async () => {
      let b = null;
      try { b = JSON.parse(fs.readFileSync(this.backupFile, 'utf8')); } catch (_) { /* нет копии */ }
      if (!b) { this._set('off', ''); return; }
      try {
        const target = b.path && fs.existsSync(b.path) && !/TranscodedWallpaper$/i.test(b.path) ? b.path : b.copy;
        if (target) await this._runner()(['-Action', 'Restore', '-Path', target, '-Style', b.style || '10', '-Tile', b.tile || '0', '-Jpeg', String(Number.isInteger(b.jpeg) ? b.jpeg : -1)]);
        fs.unlinkSync(this.backupFile);
        this.appliedKey = '';
        this.lastFile = null;
        this.emit('applied', null);
        this._set('off', '');
      } catch (e) {
        this._set('error', 'Не удалось вернуть прежние обои: ' + e.message);
      }
    });
  }

  async shutdown({ restore }) {
    clearTimeout(this.timer);
    this.timer = null;
    if (restore && this.hasBackup()) await this.restore();
    else await this.chain;
  }
}

module.exports = { Wallpaper, renderWallpaper, renderWallpaperAsync, encodePNG, STYLES };
