'use strict';
// Фото-обои под тему из открытого каталога Wallhaven (wallhaven.cc, бесплатный API без ключа).
// Ищем картинки по цвету темы, только «безопасные» (SFW), только «общие» (без аниме и людей),
// не меньше разрешения монитора и похожих пропорций. Превью и оригиналы кэшируются на диске.
const fs = require('fs');
const path = require('path');

const API = 'https://wallhaven.cc/api/v1/search';
// Wallhaven ищет только по своей палитре — подбираем ближайший цвет к цвету темы
const PALETTE = ['660000', '990000', 'cc0000', 'cc3333', 'ea4c88', '993399', '663399', '333399', '0066cc', '0099cc', '66cccc', '77cc33', '669900', '336600', '666600', '999900', 'cccc33', 'ffff00', 'ffcc33', 'ff9900', 'ff6600', 'cc6633', '996633', '663300', '000000', '999999', 'cccccc', 'ffffff', '424153'];
const PER_PAGE = 8;

const hexRgb = (h) => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

// Ближайший цвет палитры: для насыщенных цветов главное — оттенок, серые — только к серым
function nearestColor(hex) {
  const [h, s, l] = hsl(hexRgb(hex));
  let best = PALETTE[0], bd = Infinity;
  for (const p of PALETTE) {
    const [ph, ps, pl] = hsl(hexRgb(p));
    let d;
    if (s < 0.15) d = ps * 4 + Math.abs(pl - l);
    else {
      if (ps < 0.2) continue;
      const dh = Math.min(Math.abs(ph - h), 360 - Math.abs(ph - h)) / 180;
      d = dh * 6 + Math.abs(ps - s) * 0.6 + Math.abs(pl - Math.min(l, 0.5)) * 1.2;
    }
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function ratioParam(w, h) {
  const r = w / h;
  if (r > 3) return '32x9';
  if (r > 2.1) return '21x9';
  if (r < 1.7) return '16x10';
  return '16x9';
}

class PhotoSource {
  constructor({ dataDir, fetchImpl, getSize } = {}) {
    this.dir = path.join(dataDir, 'wallpapers', 'photos');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.getSize = getSize || (() => ({ width: 1920, height: 1080 }));
    this.cache = new Map(); // запрос -> { items, last }
  }

  async _json(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Lumen' } });
      if (!res.ok) throw new Error(`каталог ответил ${res.status}`);
      return await res.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'каталог не ответил' : e.message.includes('fetch failed') ? 'нет связи с каталогом обоев' : e.message);
    } finally { clearTimeout(t); }
  }

  // Варианты для цвета темы: страница page (с 1). Возвращает { color, items, hasMore }
  async search(accentHex, page = 1) {
    const color = nearestColor(accentHex);
    const { width, height } = this.getSize();
    const W = Math.round(width), H = Math.round(height);
    const key = `${color}|${W}x${H}|${page}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const base = `${API}?colors=${color}&categories=100&purity=100&sorting=favorites&order=desc`;
    // сначала — точные пропорции монитора; если мало, любые не меньше по размеру (Windows обрежет края)
    let j = await this._json(`${base}&atleast=${W}x${H}&ratios=${ratioParam(W, H)}&page=${page}`);
    if (page === 1 && (j.data || []).length < PER_PAGE) j = await this._json(`${base}&atleast=${W}x${H}&page=${page}`);
    const items = (j.data || []).filter((d) => /^https:\/\/w\.wallhaven\.cc\//.test(d.path) && /^https:\/\/th\.wallhaven\.cc\//.test(d.thumbs && d.thumbs.small))
      .slice(0, PER_PAGE * 3)
      .map((d) => ({ id: String(d.id).replace(/[^a-z0-9]/gi, ''), url: d.path, thumb: d.thumbs.small, res: d.resolution, page: d.url }));
    const out = { color, items, hasMore: (j.meta && j.meta.current_page < j.meta.last_page) || false };
    this.cache.set(key, out);
    return out;
  }

  async _download(url, file) {
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Lumen' } });
      if (!res.ok) throw new Error(`каталог ответил ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return file;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'картинка грузилась слишком долго' : e.message.includes('fetch failed') ? 'нет связи с каталогом обоев' : e.message);
    } finally { clearTimeout(t); }
  }

  // Превью как data: URL — интерфейсу не нужен доступ в интернет
  async thumb(item) {
    const file = path.join(this.dir, 'thumbs', `${item.id}.jpg`);
    await this._download(item.thumb, file);
    return 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
  }

  // Оригинал в полном разрешении
  async full(item) {
    const ext = /\.png$/i.test(item.url) ? '.png' : '.jpg';
    const file = await this._download(item.url, path.join(this.dir, `${item.id}${ext}`));
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch (_) { /* не страшно */ }
    this._trim();
    return file;
  }

  // Храним не больше 40 оригиналов
  _trim() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => /\.(jpg|png)$/i.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const x of files.slice(40)) fs.unlinkSync(path.join(this.dir, x.f));
    } catch (_) { /* не страшно */ }
  }
}

module.exports = { PhotoSource, nearestColor, ratioParam };
