'use strict';
// Маленький генератор QR-кодов (байтовый режим, уровень коррекции M, версии 1–10).
// Нужен, чтобы показать ссылку для телефона без сторонних библиотек.

// Для уровня M: [кодовых слов коррекции на блок, [[кол-во блоков, данных в блоке], ...]]
const EC_M = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// --- Поле Галуа GF(256) и Рид-Соломон ---------------------------------------
const EXP = new Array(512), LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsRemainder(data, n) {
  const gen = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const d of data) {
    const factor = d ^ res.shift();
    res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

// --- Данные -----------------------------------------------------------------
function encodeData(bytes, version) {
  const [ecPer, groups] = EC_M[version];
  const dataTotal = groups.reduce((a, [c, n]) => a + c * n, 0);
  const bits = [];
  const put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4); // байтовый режим
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataTotal * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; cw.length < dataTotal; pad++) cw.push(pad % 2 ? 0x11 : 0xec);
  // делим на блоки, считаем коррекцию, перемежаем
  const blocks = [];
  let k = 0;
  for (const [count, n] of groups) for (let c = 0; c < count; c++) { const d = cw.slice(k, k + n); k += n; blocks.push({ d, e: rsRemainder(d, ecPer) }); }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecPer; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// --- Матрица ----------------------------------------------------------------
function bch(value, poly, polyBits) {
  let v = value << (polyBits - 1);
  for (let i = 31; i >= polyBits - 1; i--) if ((v >>> i) & 1) v ^= poly << (i - polyBits + 1);
  return v;
}

function makeMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v ? 1 : 0; fixed[r][c] = true; };
  // искатели и разделители
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const on = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // синхронизация
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // выравнивание
  const al = ALIGN[version];
  const last = al.length - 1;
  for (let i = 0; i <= last; i++) for (let j = 0; j <= last; j++) {
    // пропускаем только три угла, где стоят искатели
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    const r = al[i], c = al[j];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // тёмный модуль и места под служебную информацию
  set(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, 0); if (!fixed[i][8]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, 0); if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, 0); }
  if (version >= 7) {
    const vi = (version << 12) | bch(version, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const bit = (vi >>> i) & 1;
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
    }
  }
  // данные зигзагом снизу справа
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let bi = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (let j = 0; j < 2; j++) {
        const c = col - j;
        if (fixed[r][c]) continue;
        m[r][c] = bi < bits.length ? bits[bi++] : 0;
      }
    }
    up = !up;
  }
  // маска
  const MASKS = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
  // служебная информация: уровень M = 00
  const fi = ((((0 << 3) | mask) << 10) | bch((0 << 3) | mask, 0x537, 11)) ^ 0x5412;
  const fbit = (i) => (fi >>> i) & 1;
  // первая копия — вокруг левого верхнего искателя
  for (let i = 0; i <= 5; i++) m[i][8] = fbit(i);
  m[7][8] = fbit(6); m[8][8] = fbit(7); m[8][7] = fbit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = fbit(i);
  // вторая копия — у правого верхнего и левого нижнего
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = fbit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = fbit(i);
  m[size - 8][8] = 1;
  return m;
}

// Штрафы за неудобные для сканера узоры — выбираем лучшую маску
function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const a = pass ? m[j][i] : m[i][j], b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = m[r][c]; if (v === m[r + 1][c] && v === m[r][c + 1] && v === m[r + 1][c + 1]) p += 3; }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) {
    let h1 = true, h2 = true, v1 = true, v2 = true;
    for (let k = 0; k < 11; k++) {
      if (m[r][c + k] !== pat1[k]) h1 = false; if (m[r][c + k] !== pat2[k]) h2 = false;
      if (m[c + k][r] !== pat1[k]) v1 = false; if (m[c + k][r] !== pat2[k]) v2 = false;
    }
    p += 40 * (h1 + h2 + v1 + v2);
  }
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [, groups] = EC_M[v];
    const dataBits = groups.reduce((a, [c, n]) => a + c * n, 0) * 8;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataBits) { version = v; break; }
  }
  if (!version) throw new Error('Слишком длинный текст для QR-кода');
  const cw = encodeData(bytes, version);
  let best = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = makeMatrix(version, cw, mask);
    const p = penalty(m);
    if (p < bestP) { bestP = p; best = m; }
  }
  return best;
}

// SVG для показа в интерфейсе (с белыми полями, чтобы телефон быстро распознал)
function qrSvg(text, { dark = '#0b0b12', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length, q = 4, s = n + q * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { qrMatrix, qrSvg };
