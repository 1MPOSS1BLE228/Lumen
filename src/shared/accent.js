'use strict';
// Выбор акцентного цвета для оформления Windows по палитре темы.
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function pickAccent(colors, effect) {
  if (effect === 'rainbow' || !colors || !colors.length) return '#8b5cff';
  let best = colors[0], bestScore = -1;
  for (const c of colors) {
    const [r, g, b] = hexRgb(c);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const v = mx / 255, s = mx ? (mx - mn) / mx : 0;
    const score = v * (0.45 + s);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best.toLowerCase();
}

module.exports = { pickAccent };
