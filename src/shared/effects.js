'use strict';
// Движок эффектов. Чистые функции: время + положение светодиода -> цвет.
// Работает и в главном процессе (отправка на железо), и в тестах.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fract = (v) => v - Math.floor(v);
const smooth = (t) => t * t * (3 - 2 * t);

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function hsv(h, s, v) {
  h = fract(h) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [r * 255, g * 255, b * 255];
}
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// Цвет из палитры. loop=true — палитра замкнута (последний цвет плавно переходит в первый).
function paletteAt(pal, p, loop) {
  const n = pal.length;
  if (n === 1) return pal[0];
  if (loop) {
    const f = fract(p) * n;
    const i = Math.floor(f);
    return mix(pal[i % n], pal[(i + 1) % n], smooth(f - i));
  }
  const f = clamp01(p) * (n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  return mix(pal[i], pal[i + 1], smooth(f - i));
}

const hash1 = (i) => fract(Math.sin(i * 127.1 + 311.7) * 43758.5453);
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const h = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}
const fbm = (x, y) => noise2(x, y) * 0.6 + noise2(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.4;

// --- Эффекты ---------------------------------------------------------------
// L: { x, y, u, v, i, n, seed }  — позиция светодиода (0..1) и его «бегущая» координата u
// c: { T, pal, audio, twoD }
const fns = {
  static: (L, c) => c.pal[0],

  gradient: (L, c) => paletteAt(c.pal, L.u, false),

  wave: (L, c) => paletteAt(c.pal, L.u * 0.9 - c.T * 0.12, true),

  rainbow: (L, c) => hsv(L.u * 0.9 - c.T * 0.1, 1, 1),

  breathing: (L, c) => {
    const phase = c.T * 0.22;
    const cycle = Math.floor(phase);
    const k = 0.5 - 0.5 * Math.cos(fract(phase) * Math.PI * 2);
    return scale(c.pal[cycle % c.pal.length], 0.02 + 0.98 * Math.pow(k, 1.4));
  },

  cycle: (L, c) => paletteAt(c.pal, c.T * 0.07 + L.u * 0.12, true),

  aurora: (L, c) => {
    const p = 0.5 + 0.5 * Math.sin(L.u * 3.2 + c.T * 0.35 + Math.sin(L.v * 2.4 + c.T * 0.27) * 1.6);
    const s = 0.5 + 0.5 * Math.sin(L.u * 5.1 - c.T * 0.55 + Math.sin(c.T * 0.19) * 2);
    return scale(paletteAt(c.pal, p, false), 0.28 + 0.72 * Math.pow(s, 1.4));
  },

  fire: (L, c) => {
    const rise = c.twoD ? 1 - L.y : 0.5;
    const n = fbm(L.x * 4.5 + L.seed * 0.0, (c.twoD ? L.y * 4.5 : L.x * 2.5 + 3) - c.T * 1.6);
    const heat = clamp01(n * (0.55 + 0.9 * rise) * 1.25 - 0.05);
    const ramp = [[0, 0, 0]].concat(c.pal);
    return paletteAt(ramp, heat, false);
  },

  twinkle: (L, c) => {
    const rate = 0.25 + hash1(L.i * 3.7 + 1) * 0.9;
    const s = Math.pow(Math.max(0, Math.sin((c.T * rate + L.seed) * Math.PI * 2)), 10);
    const spark = c.pal[1 + (L.i % Math.max(1, c.pal.length - 1))] || c.pal[0];
    return mix(scale(c.pal[0], 0.35), spark, s);
  },

  comet: (L, c) => {
    const head = fract(c.T * 0.22);
    const d = fract(head - L.u);
    const tail = Math.exp(-d * 7);
    const col = paletteAt(c.pal, fract(c.T * 0.04), true);
    return scale(col, 0.05 + 0.95 * tail);
  },

  scanner: (L, c) => {
    const ph = fract(c.T * 0.18);
    const pos = ph < 0.5 ? ph * 2 : 2 - ph * 2;
    const d = Math.abs(L.u - pos);
    return scale(c.pal[0], 0.04 + 0.96 * Math.exp(-d * d * 90));
  },

  ripple: (L, c) => {
    const d = Math.hypot((L.x - 0.5) * (c.twoD ? 1.6 : 2), (L.y - 0.5) * (c.twoD ? 1 : 0));
    const w = 0.5 + 0.5 * Math.sin((d * 3.2 - c.T * 0.35) * Math.PI * 2);
    return scale(paletteAt(c.pal, d * 1.4 - c.T * 0.1, true), 0.15 + 0.85 * Math.pow(w, 1.6));
  },

  // Цвет экрана: сетка усреднённых цветов монитора (screen.w × screen.h)
  screen: (L, c) => {
    const sc = c.screen;
    if (!sc || !sc.data) return [8, 8, 12];
    if (L.n <= 2) {
      // мышь, видеокарта с одной зоной и т.п.: средний цвет всего экрана
      if (!sc._avg) {
        let r = 0, g = 0, b = 0;
        const cells = sc.w * sc.h;
        for (let i = 0; i < cells; i++) { r += sc.data[i * 3]; g += sc.data[i * 3 + 1]; b += sc.data[i * 3 + 2]; }
        sc._avg = [r / cells, g / cells, b / cells];
      }
      return sc._avg;
    }
    const col = Math.min(sc.w - 1, Math.max(0, Math.floor(L.x * sc.w)));
    if (!c.twoD) {
      let r = 0, g = 0, b = 0;
      for (let row = 0; row < sc.h; row++) { const o = (row * sc.w + col) * 3; r += sc.data[o]; g += sc.data[o + 1]; b += sc.data[o + 2]; }
      return [r / sc.h, g / sc.h, b / sc.h];
    }
    const row = Math.min(sc.h - 1, Math.max(0, Math.floor(L.y * sc.h)));
    const o = (row * sc.w + col) * 3;
    return [sc.data[o], sc.data[o + 1], sc.data[o + 2]];
  },

  // Температура видеокарты: 35 °C — первый цвет палитры, 80 °C — последний; под нагрузкой пульсирует
  temperature: (L, c) => {
    const s = c.sensors;
    if (!s || s.gpuTemp == null) return scale(c.pal[0], 0.25 + 0.2 * (0.5 + 0.5 * Math.sin(c.T * 2)));
    const t = clamp01((s.gpuTemp - 35) / 45);
    const load = clamp01((s.gpuLoad || 0) / 100);
    const wave = 0.5 + 0.5 * Math.sin(c.T * (1.2 + load * 4) - L.u * 3);
    return scale(paletteAt(c.pal, t, false), 0.72 + 0.28 * wave * (0.3 + load * 0.7));
  },

  music: (L, c) => {
    const bands = c.audio.bands;
    const nb = bands.length;
    const lvl = bands[Math.min(nb - 1, Math.max(0, Math.floor(L.u * nb)))] || 0;
    let b;
    if (c.twoD) b = 0.08 + 0.92 * clamp01((lvl - (1 - L.y)) * 7 + 0.5);
    else b = 0.08 + 0.92 * Math.pow(lvl, 0.8);
    b = Math.min(1, b + c.audio.bass * 0.22);
    return scale(paletteAt(c.pal, L.u, false), b);
  },
};

// palette: 'none' | 'single' | 'multi' — сколько цветов использует эффект
// dir: учитывает ли направление
const EFFECTS = {
  static: { name: 'Статичный', desc: 'Один сплошной цвет', palette: 'single', dir: false },
  gradient: { name: 'Градиент', desc: 'Плавный переход между цветами', palette: 'multi', dir: true },
  wave: { name: 'Волна', desc: 'Цвета бегут по устройству', palette: 'multi', dir: true },
  rainbow: { name: 'Радуга', desc: 'Все цвета спектра', palette: 'none', dir: true },
  breathing: { name: 'Дыхание', desc: 'Плавное угасание и вспышка', palette: 'multi', dir: false },
  cycle: { name: 'Смена цвета', desc: 'Устройство перетекает из цвета в цвет', palette: 'multi', dir: false },
  aurora: { name: 'Северное сияние', desc: 'Переливающиеся полотна света', palette: 'multi', dir: true },
  fire: { name: 'Огонь', desc: 'Пламя поднимается снизу вверх', palette: 'multi', dir: false },
  twinkle: { name: 'Мерцание', desc: 'Вспыхивающие огоньки на фоне', palette: 'multi', dir: false },
  comet: { name: 'Комета', desc: 'Яркая голова с длинным хвостом', palette: 'multi', dir: true },
  scanner: { name: 'Сканер', desc: 'Луч бегает туда-обратно', palette: 'single', dir: false },
  ripple: { name: 'Круги', desc: 'Волны расходятся от центра', palette: 'multi', dir: false },
  music: { name: 'Музыка', desc: 'Подсветка реагирует на звук из колонок', palette: 'multi', dir: false },
  screen: { name: 'Цвет экрана', desc: 'Подсветка повторяет картинку на мониторе', palette: 'none', dir: false },
  temperature: { name: 'Температура', desc: 'Цвет показывает нагрев видеокарты', palette: 'multi', dir: true },
};
const EFFECT_IDS = Object.keys(EFFECTS);
for (const id of EFFECT_IDS) EFFECTS[id].id = id;

const DIRECTIONS = ['right', 'left', 'up', 'down'];

// Положение светодиода -> «бегущая» координата в выбранном направлении
function projectU(x, y, dir, linear) {
  switch (dir) {
    case 'left': return 1 - x;
    case 'up': return linear ? x : 1 - y;
    case 'down': return linear ? 1 - x : y;
    default: return x;
  }
}

// Подготовка светодиодов устройства под направление (кэшируется в dev._prep)
function prepareLeds(dev, dir) {
  const key = dir;
  if (dev._prep && dev._prep.key === key) return dev._prep.list;
  const list = dev.leds.map((p, i) => {
    const u = projectU(p.x, p.y, dir, dev.linear);
    const perp = dir === 'up' || dir === 'down' ? p.x : p.y;
    return { x: p.x, y: p.y, u, v: perp, i, n: dev.leds.length, seed: hash1(i + 1.234) };
  });
  dev._prep = { key, list };
  return list;
}

// Скорость 0..100 -> множитель времени
const speedFactor = (speed) => 0.12 + Math.pow(clamp01(speed / 100), 1.3) * 2.6;

const EMPTY_AUDIO = { bands: new Array(16).fill(0), bass: 0, level: 0 };

// Рисует кадр устройства в out (Uint8Array длиной 3*n)
function renderDevice(dev, params, T, audio, out) {
  const def = fns[params.effect] || fns.static;
  const pal = params.pal && params.pal.length ? params.pal : [[255, 255, 255]];
  const leds = prepareLeds(dev, params.direction);
  const c = { T, pal, audio: audio || EMPTY_AUDIO, twoD: !dev.linear, screen: params.screen, sensors: params.sensors };
  const k = clamp01(params.brightness / 100);
  for (let i = 0; i < leds.length; i++) {
    const col = def(leds[i], c);
    const o = i * 3;
    out[o] = Math.max(0, Math.min(255, (col[0] * k) | 0));
    out[o + 1] = Math.max(0, Math.min(255, (col[1] * k) | 0));
    out[o + 2] = Math.max(0, Math.min(255, (col[2] * k) | 0));
  }
  return out;
}

module.exports = {
  EFFECTS, EFFECT_IDS, DIRECTIONS, fns,
  hexToRgb, rgbToHex, hsv, mix, paletteAt, speedFactor, renderDevice, prepareLeds, clamp01,
};
