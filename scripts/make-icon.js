'use strict';
// Генерирует иконки приложения без сторонних библиотек:
//   assets/icon.png (256), assets/tray.png (32), build/icon.ico (16..256)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');

// --- CRC32 + PNG ---------------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Рисунок иконки -----------------------------------------------------
const STOPS = [
  [255, 43, 214],
  [122, 43, 255],
  [0, 229, 255],
  [255, 43, 214],
];
function ringColor(t) {
  const f = t * (STOPS.length - 1);
  const i = Math.min(Math.floor(f), STOPS.length - 2);
  const k = f - i;
  return STOPS[i].map((v, c) => v + (STOPS[i + 1][c] - v) * k);
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sample(x, y) {
  // x,y в диапазоне [-1, 1]
  const box = sdRoundBox(x, y, 0.92, 0.92, 0.42);
  const maskA = 1 - smooth(-0.004, 0.004, box);
  if (maskA <= 0) return [0, 0, 0, 0];
  const d = Math.hypot(x, y);
  // фон: тёмный с лёгким светом по центру
  const bgK = Math.max(0, 1 - d * 0.9);
  let r = 10 + 22 * bgK, g = 10 + 14 * bgK, b = 22 + 40 * bgK;
  // кольцо
  const ang = (Math.atan2(y, x) / (Math.PI * 2) + 1.25) % 1;
  const ring = smooth(0.2, 0.0, Math.abs(d - 0.52) - 0.13 + 0.0) ;
  const ringCore = 1 - smooth(0.115, 0.135, Math.abs(d - 0.52));
  const glow = Math.exp(-Math.pow((d - 0.52) / 0.2, 2)) * 0.55;
  const c = ringColor(ang);
  r += c[0] * glow * 0.45; g += c[1] * glow * 0.45; b += c[2] * glow * 0.45;
  r = r * (1 - ringCore) + c[0] * ringCore;
  g = g * (1 - ringCore) + c[1] * ringCore;
  b = b * (1 - ringCore) + c[2] * ringCore;
  // центральная точка
  const dot = 1 - smooth(0.14, 0.17, d);
  const dotGlow = Math.exp(-Math.pow(d / 0.3, 2)) * 0.5;
  r += 255 * dotGlow * 0.35; g += 255 * dotGlow * 0.35; b += 255 * dotGlow * 0.4;
  r = r * (1 - dot) + 250 * dot;
  g = g * (1 - dot) + 247 * dot;
  b = b * (1 - dot) + 255 * dot;
  void ring;
  return [Math.min(255, r), Math.min(255, g), Math.min(255, b), maskA * 255];
}
function render(size, ss = 3) {
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          const s = sample(x, y);
          R += s[0] * s[3]; G += s[1] * s[3]; B += s[2] * s[3]; A += s[3];
        }
      }
      const n = ss * ss;
      const o = (py * size + px) * 4;
      if (A > 0) {
        out[o] = Math.round(R / A); out[o + 1] = Math.round(G / A); out[o + 2] = Math.round(B / A);
        out[o + 3] = Math.round(A / n);
      }
    }
  }
  return encodePNG(size, size, out);
}

function encodeICO(pngs) {
  const count = pngs.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const rendered = sizes.map((s) => ({ size: s, data: render(s, s <= 48 ? 4 : 3) }));
const png256 = rendered.find((r) => r.size === 256).data;
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png256);
fs.writeFileSync(path.join(root, 'assets', 'tray.png'), rendered.find((r) => r.size === 32).data);
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(512, 2));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), encodeICO(rendered));
console.log('Иконки готовы');
