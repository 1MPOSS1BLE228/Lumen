'use strict';
// Коды для обмена темами: LUMEN1-<base64url(JSON)>. Их можно скинуть в мессенджер.
const PREFIX = 'LUMEN1-';
const ALLOWED_DIR = ['right', 'left', 'up', 'down'];

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function encodeTheme(t) {
  const o = { n: t.name, e: t.effect, c: t.colors.map((c) => c.replace('#', '')), s: t.speed, d: t.direction };
  return PREFIX + b64url(JSON.stringify(o));
}

// effects — справочник эффектов для проверки. Бросает Error с понятным текстом.
function decodeTheme(code, effects) {
  const raw = String(code || '').trim().replace(/\s+/g, '');
  if (!raw.toUpperCase().startsWith(PREFIX)) throw new Error('Это не код темы Lumen: он должен начинаться с LUMEN1-');
  let o;
  try { o = JSON.parse(unb64url(raw.slice(PREFIX.length))); } catch (_) { throw new Error('Код повреждён: проверь, что он скопирован целиком'); }
  if (!o || typeof o !== 'object') throw new Error('Код повреждён');
  if (!effects[o.e]) throw new Error('В коде неизвестный эффект — возможно, он из более новой версии Lumen');
  const colors = (Array.isArray(o.c) ? o.c : []).map(String).filter((c) => /^[0-9a-f]{6}$/i.test(c)).slice(0, 6).map((c) => '#' + c.toLowerCase());
  if (!colors.length) throw new Error('В коде нет цветов');
  const speed = Math.min(100, Math.max(0, Math.round(Number(o.s)) || 50));
  const name = String(o.n || 'Тема по коду').replace(/[<>]/g, '').trim().slice(0, 24) || 'Тема по коду';
  return { name, effect: o.e, colors, speed, direction: ALLOWED_DIR.includes(o.d) ? o.d : 'right' };
}

module.exports = { encodeTheme, decodeTheme, PREFIX };
