'use strict';
// Строчка из текста песни для виджета «Сейчас играет».
// Тексты — из открытой базы LRCLIB (lrclib.net, без ключа). Берём синхронизированный текст
// (с отметками времени), чтобы показывать ту строчку, которая звучит сейчас.
const UA = 'Lumen (https://github.com/1MPOSS1BLE228/Lumen)';

// «[01:23.45] строка» -> [{ t: мс, text }]
function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const times = [];
    let rest = raw;
    let m;
    while ((m = /^\s*\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      times.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
      rest = rest.slice(m[0].length);
    }
    const text = rest.trim();
    for (const t of times) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Убрать из названия трека приписки вроде «(Remastered 2011)», «- Live», «feat. …»
function cleanTitle(s) {
  return String(s || '').replace(/\s*[([][^)\]]*(remaster|live|version|edit|mix|feat|ft\.|radio|mono|stereo|deluxe|bonus)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|live|version|edit|mix).*$/i, '').replace(/\s+(feat|ft)\.?\s.*$/i, '').trim();
}

class Lyrics {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.cache = new Map(); // ключ трека -> строки (или [] — текста нет)
  }

  async _json(url) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('LRCLIB ответил ' + r.status);
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  // Строки с отметками времени или [] (текста нет / песня без слов). null — не удалось спросить (нет сети).
  async get({ artist, title, dur }) {
    artist = String(artist || '').trim();
    const t = cleanTitle(title);
    if (!artist || !t) return [];
    const key = (artist + '|' + t).toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    let lines = [];
    try {
      const q = `artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(t)}` + (dur > 0 ? `&duration=${Math.round(dur / 1000)}` : '');
      let rec = await this._json('https://lrclib.net/api/get?' + q);
      if (!rec || !rec.syncedLyrics) {
        // точного совпадения нет — ищем похожее и берём первое с синхронным текстом
        const list = await this._json(`https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(t)}`);
        rec = Array.isArray(list) ? list.find((x) => x && x.syncedLyrics && (!dur || !x.duration || Math.abs(x.duration * 1000 - dur) < 8000)) : null;
      }
      if (rec && rec.syncedLyrics && !rec.instrumental) lines = parseLrc(rec.syncedLyrics);
    } catch (_) {
      return null; // в кэш не кладём — попробуем в следующий раз
    }
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, lines);
    return lines;
  }
}

module.exports = { Lyrics, parseLrc, cleanTitle };
