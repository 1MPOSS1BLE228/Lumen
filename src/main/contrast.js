'use strict';
// Цвет вспышки уведомления, который будет заметен на фоне текущей подсветки.
// Похожесть цветов меряем в пространстве Lab (ΔE) — так, как её видит глаз, а не по числам RGB.

function rgbToLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a, b) {
  const A = rgbToLab(a), B = rgbToLab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

// Насколько цвет отличается от самого похожего цвета подсветки
const minDist = (c, palette) => Math.min(...palette.map((p) => deltaE(c, p)));

const SIMILAR = 40; // ΔE меньше — на глаз почти то же самое
const CANDIDATES = [
  [255, 255, 255], [255, 32, 32], [32, 255, 64], [40, 90, 255], [255, 210, 0], [255, 0, 220], [0, 240, 255], [255, 120, 0],
];

// app — цвет приложения [r,g,b]; palette — цвета текущей подсветки; mode: 'auto' | 'contrast' | 'app'
// rainbow — подсветка переливается всеми цветами (тогда заметнее всего белый)
function pickFlashColor(app, palette, mode = 'auto', rainbow = false) {
  if (mode === 'app' || !palette || !palette.length) return app;
  if (rainbow) return [255, 255, 255];
  if (mode === 'auto' && minDist(app, palette) >= SIMILAR) return app; // цвет приложения и так заметен
  let best = CANDIDATES[0], bestD = -1;
  for (const c of [app, ...CANDIDATES]) {
    const d = minDist(c, palette);
    if (d > bestD + 0.5) { best = c; bestD = d; }
  }
  return best;
}

module.exports = { rgbToLab, deltaE, pickFlashColor, SIMILAR };
