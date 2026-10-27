'use strict';
// «Цвета под музыку»: берём обложку трека, который сейчас играет (Spotify, Яндекс Музыка, браузер),
// и вытаскиваем из неё 3 самых ярких и непохожих цвета — подсветка меняется вместе с песней.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'media.ps1');
const POLL_MS = 3000;

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function hsvToHex(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// px — пиксели RGBA (или BGRA, если bgr=true). Возвращает 1–3 цвета для светодиодов.
function coverPalette(px, { bgr = false } = {}) {
  const bins = new Map();
  for (let i = 0; i + 3 < px.length; i += 4) {
    const r = px[i + (bgr ? 2 : 0)], g = px[i + 1], b = px[i + (bgr ? 0 : 2)], a = px[i + 3];
    if (a < 128) continue;
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.12) continue; // почти чёрное светодиоды всё равно не покажут
    const hb = s < 0.18 ? 'g' : Math.round(h / 15) % 24; // оттенки по 15°, серые отдельно
    const e = bins.get(hb) || { n: 0, h: 0, s: 0, v: 0, sx: 0, sy: 0 };
    e.n++; e.s += s; e.v += v;
    e.sx += Math.cos((h * Math.PI) / 180); e.sy += Math.sin((h * Math.PI) / 180);
    bins.set(hb, e);
  }
  const groups = [...bins.entries()].map(([k, e]) => {
    const h = (Math.atan2(e.sy / e.n, e.sx / e.n) * 180) / Math.PI;
    const s = e.s / e.n, v = e.v / e.n;
    // вес: сколько пикселей и насколько цвет насыщенный
    return { gray: k === 'g', h: (h + 360) % 360, s, v, w: e.n * (k === 'g' ? 0.15 : 0.4 + s * 1.6) };
  }).sort((a, b) => b.w - a.w);
  const picked = [];
  for (const g of groups) {
    if (picked.length >= 3) break;
    if (g.gray && picked.length) continue;
    if (picked.some((p) => !p.gray && !g.gray && Math.min(Math.abs(p.h - g.h), 360 - Math.abs(p.h - g.h)) < 35)) continue;
    picked.push(g);
  }
  if (!picked.length) return ['#ffffff'];
  // для светодиодов: полная яркость, насыщенность чуть выше, серый — мягкий белый
  return picked.map((g) => (g.gray ? '#f0f0ff' : hsvToHex(g.h, Math.min(1, Math.max(0.55, g.s * 1.25)), 1)));
}

class MediaWatcher extends EventEmitter {
  // decode(buf) -> { data: RGBA/BGRA, bgr } — переводит обложку в пиксели (в приложении это Electron)
  constructor({ dataDir, decode, Helper, platform = process.platform } = {}) {
    super();
    this.dataDir = dataDir;
    this.decode = decode || null;
    this.Helper = Helper || null;
    this.platform = platform;
    this.helper = null;
    this.timer = null;
    this.key = '';
    this.track = { playing: false, colors: null, app: '', title: '', artist: '', cover: '' };
    this.status = { state: 'off', message: '' };
  }

  get available() { return this.platform === 'win32' && !!this.decode && !!this.Helper; }

  _set(state, message = '') {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit('status', this.status);
  }

  _script() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'media.ps1');
    const text = '﻿' + fs.readFileSync(SCRIPT, 'utf8').replace(/^﻿/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch (_) { /* нет */ }
    if (cur !== text) fs.writeFileSync(dest, text, 'utf8');
    return dest;
  }

  start() {
    if (this.timer || !this.available) return;
    this._set('working', '');
    const tick = async () => { await this.poll(); if (this.timer) { this.timer = setTimeout(tick, POLL_MS); if (this.timer.unref) this.timer.unref(); } };
    this.timer = setTimeout(tick, 200);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.helper) { this.helper.close(); this.helper = null; }
    this.key = '';
    this._update({ playing: false, colors: null, app: '', title: '', artist: '', cover: '' });
    this._set('off');
  }

  _update(t) {
    const before = JSON.stringify(this.track);
    this.track = { ...this.track, ...t };
    if (JSON.stringify(this.track) !== before) this.emit('track', this.track);
  }

  // Пауза/продолжить, следующий, предыдущий трек. Опрос сразу после — чтобы кнопки откликались быстро.
  async control(what) {
    if (!['play', 'next', 'prev'].includes(what) || !this.available) return false;
    try {
      if (!this.helper || this.helper.dead) this.helper = new this.Helper(this._script());
      const r = JSON.parse(await this.helper.cmd('ctl ' + what, 8000));
      setTimeout(() => this.poll(), 400);
      return !!r.ok;
    } catch (_) { return false; }
  }

  async poll() {
    try {
      if (!this.helper || this.helper.dead) this.helper = new this.Helper(this._script());
      const line = await this.helper.cmd('poll ' + this.key, 10000);
      const r = JSON.parse(line);
      if (!r.ok) throw new Error(r.error || 'нет ответа');
      // ничего не открыто — пусто; на паузе — оставляем трек, чтобы его можно было продолжить кнопкой
      if (!r.key) { this._update({ playing: false, title: '', artist: '', cover: '' }); this._set('ok'); return; }
      let colors = this.track.colors, cover = this.track.cover || '';
      if (r.key !== this.key) {
        this.key = r.key;
        colors = null;
        cover = '';
        if (r.img) {
          try { const img = this.decode(Buffer.from(r.img, 'base64')); if (img && img.data && img.data.length) colors = coverPalette(img.data, { bgr: !!img.bgr }); } catch (_) { /* не картинка */ }
          if (r.img.length < 900000) cover = 'data:image/jpeg;base64,' + r.img; // обложка для виджета (браузер сам узнает PNG)
        }
      }
      this._update({ playing: !!r.playing, colors, app: r.app || '', title: String(r.title || '').slice(0, 120), artist: String(r.artist || '').slice(0, 120), cover, pos: Math.max(0, Number(r.pos) || 0), dur: Math.max(0, Number(r.dur) || 0), at: Date.now() });
      this._set('ok');
    } catch (e) {
      this._set('error', 'Не получилось узнать, что играет: ' + e.message);
      if (this.helper) { this.helper.close(); this.helper = null; }
    }
  }
}

module.exports = { MediaWatcher, coverPalette };
