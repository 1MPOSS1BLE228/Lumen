'use strict';
// Стили обоев. Каждый стиль — «шейдер»: функция (x, y) -> [r, g, b] для каждого пикселя.
// Композиция зависит от цветов темы (сид), поэтому у каждой темы свои обои.

const STYLES = {
  live: { name: 'Живые волны', desc: 'Волны медленно плывут прямо за значками рабочего стола. В играх и при развёрнутых окнах анимация замирает и не тратит силы компьютера.' },
  photo: { name: 'Фото под тему', desc: 'Красивые фотографии и арт в цветах подсветки из открытого каталога Wallhaven, в разрешении твоего монитора. Для каждой темы можно выбрать свой вариант.' },
  waves: { name: 'Волны', desc: 'Слои плавных холмов с подсвеченными краями' },
  ribbons: { name: 'Ленты', desc: 'Светящиеся ленты, как северное сияние' },
  shapes: { name: 'Фигуры', desc: 'Крупные круги и кольца с объёмом' },
  glow: { name: 'Сияние', desc: 'Мягкие цветные пятна на тёмном фоне' },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

function palAt(pal, p) {
  if (pal.length === 1) return pal[0];
  const f = clamp01(p) * (pal.length - 1);
  const i = Math.min(Math.floor(f), pal.length - 2);
  const t = f - i;
  return mix(pal[i], pal[i + 1], t * t * (3 - 2 * t));
}
function palLoop(pal, p) {
  const n = pal.length;
  if (n === 1) return pal[0];
  const f = (((p % 1) + 1) % 1) * n;
  const i = Math.floor(f);
  const t = f - i;
  return mix(pal[i % n], pal[(i + 1) % n], t * t * (3 - 2 * t));
}

// Детерминированный генератор случайных чисел от строки
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}

// Тёмный фон с лёгким оттенком темы
function background(pal, W, H) {
  const top = mix([6, 6, 11], pal[0], 0.06);
  const bot = mix([4, 4, 8], pal[pal.length - 1], 0.1);
  return (x, y) => mix(top, bot, y / H);
}

// --- Волны: слои холмов, как горы на закате -------------------------------
function waves(pal, W, H, rnd) {
  const bg = background(pal, W, H);
  const L = 6;
  const layers = [];
  for (let k = 0; k < L; k++) {
    layers.push({
      base: H * (0.26 + 0.12 * k + (rnd() - 0.5) * 0.03),
      a1: H * (0.05 + rnd() * 0.04), f1: (Math.PI * 2 * (0.6 + rnd() * 0.9)) / W, p1: rnd() * 6.28,
      a2: H * (0.015 + rnd() * 0.02), f2: (Math.PI * 2 * (2 + rnd() * 2.5)) / W, p2: rnd() * 6.28,
      color: scale(palAt(pal, k / (L - 1)), 0.95 - 0.13 * k),
    });
  }
  const glowC = palAt(pal, 0.2);
  return (x, y) => {
    let c = bg(x, y);
    // мягкое свечение за холмами
    const gy = (y - H * 0.28) / (H * 0.35), gx = (x - W * 0.5) / (W * 0.6);
    c = mix(c, glowC, Math.exp(-(gx * gx + gy * gy)) * 0.18);
    for (let k = 0; k < L; k++) {
      const ly = layers[k];
      const edge = ly.base + ly.a1 * Math.sin(x * ly.f1 + ly.p1) + ly.a2 * Math.sin(x * ly.f2 + ly.p2);
      const d = y - edge;
      // тень от следующего слоя на предыдущем
      if (d < 0 && d > -H * 0.06) c = scale(c, 1 - 0.35 * Math.exp(d / (H * 0.018)));
      if (d > -1.5) {
        const a = smooth(-1, 1, d);
        let lc = scale(ly.color, 1 - 0.45 * clamp01(d / (H * 0.3)));
        lc = mix(lc, [255, 255, 255], Math.exp(-Math.max(0, d) / 2.2) * 0.35); // светлый край
        c = mix(c, lc, a);
      }
    }
    return c;
  };
}

// --- Ленты: светящиеся полосы, как северное сияние ------------------------
function ribbons(pal, W, H, rnd) {
  const bg = background(pal, W, H);
  const R = 4;
  const rib = [];
  for (let i = 0; i < R; i++) {
    rib.push({
      y: H * (0.3 + 0.13 * i + (rnd() - 0.5) * 0.05),
      a1: H * (0.08 + rnd() * 0.08), f1: (Math.PI * 2 * (0.5 + rnd() * 0.7)) / W, p1: rnd() * 6.28,
      a2: H * (0.02 + rnd() * 0.03), f2: (Math.PI * 2 * (1.6 + rnd() * 1.5)) / W, p2: rnd() * 6.28,
      t: H * (0.035 + rnd() * 0.035), off: rnd(), sh: rnd() * 6.28,
    });
  }
  return (x, y) => {
    let c = bg(x, y);
    // редкие звёзды
    const sx = Math.floor(x / 3), sy = Math.floor(y / 3);
    const hs = Math.sin(sx * 12.9898 + sy * 78.233) * 43758.5453;
    const star = hs - Math.floor(hs);
    if (star > 0.9985) c = mix(c, [255, 255, 255], (star - 0.9985) * 400 * (1 - y / H));
    let r = 0, g = 0, b = 0;
    for (const rb of rib) {
      const cy = rb.y + rb.a1 * Math.sin(x * rb.f1 + rb.p1) + rb.a2 * Math.sin(x * rb.f2 + rb.p2);
      const thick = rb.t * (0.7 + 0.5 * Math.sin(x * rb.f1 * 1.7 + rb.sh));
      const d = (y - cy) / thick;
      // вертикальные «шторки» сияния уходят вверх
      const up = d < 0 ? Math.exp(d * 0.35) : Math.exp(-d * d * 1.8);
      const curtain = 0.65 + 0.35 * Math.sin(x * 0.045 + rb.sh) * Math.sin(x * 0.013 + rb.off * 9);
      const k = up * curtain * 0.55 + Math.exp(-d * d * 30) * 0.65;
      const col = palLoop(pal, x / W * 0.9 + rb.off);
      r += col[0] * k; g += col[1] * k; b += col[2] * k;
    }
    // «экранное» смешивание: светлее, но без пересветов
    return [255 - (255 - c[0]) * (1 - Math.min(1, r / 255)), 255 - (255 - c[1]) * (1 - Math.min(1, g / 255)), 255 - (255 - c[2]) * (1 - Math.min(1, b / 255))];
  };
}

// --- Фигуры: объёмные круги и кольца --------------------------------------
function shapes(pal, W, H, rnd) {
  const bg = background(pal, W, H);
  const m = Math.min(W, H);
  const discs = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    discs.push({
      x: W * (0.15 + 0.7 * rnd()), y: H * (0.15 + 0.7 * rnd()), r: m * (0.16 + rnd() * 0.22),
      c: pal[i % pal.length], light: rnd() * 6.28,
    });
  }
  discs.sort((a, b) => b.r - a.r); // большие — дальше
  const rings = [];
  for (let i = 0; i < 3; i++) rings.push({ x: W * (0.1 + 0.8 * rnd()), y: H * (0.1 + 0.8 * rnd()), r: m * (0.12 + rnd() * 0.35), w: 1.5 + rnd() * 2, c: pal[(i + 1) % pal.length] });
  const dot = { x: W * (0.2 + 0.6 * rnd()), y: H * (0.2 + 0.6 * rnd()), r: m * 0.035, c: pal[pal.length - 1] };
  return (x, y) => {
    let c = bg(x, y);
    // сетка мелких точек
    const gx = (x % 32) - 16, gy = (y % 32) - 16;
    c = mix(c, [255, 255, 255], (1 - smooth(1, 2.2, Math.hypot(gx, gy))) * 0.07);
    for (const dk of discs) {
      const dx = x - dk.x, dy = y - dk.y;
      const dist = Math.hypot(dx, dy);
      // мягкая тень под кругом
      if (dist > dk.r) c = scale(c, 1 - 0.45 * Math.exp(-(dist - dk.r) / (m * 0.035)));
      const a = smooth(dk.r + 1, dk.r - 1, dist);
      if (a > 0) {
        // объём: светлее с одной стороны, темнее с другой
        const lx = Math.cos(dk.light), ly = Math.sin(dk.light);
        const shade = 0.55 + 0.45 * clamp01(0.5 - (dx * lx + dy * ly) / (dk.r * 2));
        let fc = scale(dk.c, shade);
        fc = mix(fc, [255, 255, 255], Math.pow(clamp01(1 - (dk.r - dist) / 3), 3) * 0.25); // тонкий светлый обод
        c = mix(c, fc, a * 0.92);
      }
    }
    for (const rg of rings) {
      const d = Math.abs(Math.hypot(x - rg.x, y - rg.y) - rg.r);
      const core = 1 - smooth(rg.w * 0.5, rg.w * 0.5 + 1.2, d);
      const glow = Math.exp(-d / 10) * 0.35;
      c = mix(c, rg.c, Math.min(1, core + glow));
    }
    const dd = Math.hypot(x - dot.x, y - dot.y);
    c = mix(c, mix(dot.c, [255, 255, 255], 0.3), smooth(dot.r + 1, dot.r - 1, dd));
    return c;
  };
}

function makeShader(style, pal, W, H) {
  if (style === 'live') style = 'waves'; // обычная картинка под живыми обоями — те же волны
  const rnd = seeded(style + pal.map((c) => c.join()).join('|'));
  if (style === 'waves') return waves(pal, W, H, rnd);
  if (style === 'ribbons') return ribbons(pal, W, H, rnd);
  if (style === 'shapes') return shapes(pal, W, H, rnd);
  return null;
}

module.exports = { STYLES, makeShader };
