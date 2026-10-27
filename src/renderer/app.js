(() => {
'use strict';
const api = window.lumen;
// ошибки интерфейса — в журнал
window.addEventListener('error', (e) => { try { api.reportError(`${e.message} @ ${e.filename}:${e.lineno}`); } catch (_) { /* нет моста */ } });
window.addEventListener('unhandledrejection', (e) => { try { api.reportError('promise: ' + (e.reason && e.reason.stack || e.reason)); } catch (_) { /* нет моста */ } });
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- Состояние ----------
let S = null, DEV = [], CONN = { status: 'disconnected', message: '', count: 0 }, CAT = null, VERSION = '';
let NATIVE = { state: 'idle', message: '', count: 0 }, WIN = { available: false, state: 'off', message: '' }, PLATFORM = '';
let HEALTH = { conflicts: [], missing: [] };
let NP = null; // что сейчас играет
let REMOTE = { state: 'off', message: '', url: '', qr: '' };
let UPD = { state: 'idle', version: '', progress: 0, message: '' };
let SCN = { active: null, paused: false, effect: null }, SENS = {}, HK = { list: [], failed: [] }, APPS = [];
const screenCap = { status: 'off', message: '' };
// Эффект, который реально горит сейчас (с учётом сценария)
const effEffect = () => (SCN.active && !SCN.paused && SCN.effect ? SCN.effect : S.effect);
let page = 'home';
let LANGS = { ru: 'Русский' };
let NOTIFY_APPS = [];
let LANG_AUTO = 'Как в Windows';
// Фото под тему: варианты для текущей темы
const PH = { key: '', page: 1, items: [], shown: 8, selected: '', loading: false, error: '', hasMore: false, ver: 0 };
let themeTab = 'ready';
let lastSurpriseName = '';
try { themeTab = localStorage.getItem('lumen.themeTab') === 'mine' ? 'mine' : 'ready'; } catch (_) { /* нет хранилища */ }
function setThemeTab(t) { themeTab = t; try { localStorage.setItem('lumen.themeTab', t); } catch (_) { /* нет хранилища */ } render(); }
let frames = {};
let framesDirty = true;
let dragging = false;
let lastSig = '';
const view = $('#view');
const audio = { status: 'off', message: '', bands: new Array(16).fill(0) };

// ---------- Иконки ----------
const svg = (body, size = 20, sw = 1.7) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const NAV = {
  home: ['Подсветка', '<path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/><path d="M10 20.5h4"/>'],
  effects: ['Эффекты', '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16v5M16.5 18.5h5"/>'],
  devices: ['Устройства', '<rect x="3" y="5" width="18" height="11" rx="2"/><path d="M8 20h8M12 16v4"/>'],
  scenes: ['Сценарии', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'],
  settings: ['Настройки', '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>'],
};
const FXI = {
  static: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  gradient: '<rect x="4" y="6" width="16" height="12" rx="3"/><path d="M8 6v12M12 6v12M16 6v12" opacity=".5"/>',
  wave: '<path d="M3 12c3-6 6-6 9 0s6 6 9 0"/>',
  rainbow: '<path d="M4 17a8 8 0 0 1 16 0M8 17a4 4 0 0 1 8 0"/>',
  breathing: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5" opacity=".55"/>',
  cycle: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  aurora: '<path d="M6 20c1-6 0-9 2-15M12 20c1-6 0-9 2-15M18 20c1-6 0-9 2-15" />',
  fire: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 0-6 1-9z"/>',
  twinkle: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.5 16v3M17 17.5h3"/>',
  comet: '<path d="M4 20L15 9"/><path d="M4 14l7-7M10 20l7-7" opacity=".5"/><circle cx="17" cy="7" r="3" fill="currentColor"/>',
  scanner: '<path d="M3 12h18" opacity=".4"/><rect x="9" y="8" width="6" height="8" rx="2" fill="currentColor"/>',
  ripple: '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6" opacity=".7"/><circle cx="12" cy="12" r="10" opacity=".4"/>',
  music: '<path d="M6 18v-6M10 18V6M14 18v-9M18 18v-5"/>',
  screen: '<rect x="3" y="5" width="18" height="11" rx="2"/><path d="M8 20h8"/><path d="M1.5 8v5M22.5 8v5" opacity=".6"/>',
  temperature: '<path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 10v6"/>',
};
const ICON_DICE = svg('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/>', 22, 1.8);
const ICON_POWER = svg('<path d="M12 3v9"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>', 24, 1.9);
const ICON_CHECK = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14, 2.6);
const ICON_X = svg('<path d="M6 6l12 12M18 6L6 18"/>', 12, 2.4);
const ARROW = { right: '<path d="M5 12h14M13 6l6 6-6 6"/>', left: '<path d="M19 12H5M11 6l-6 6 6 6"/>', up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>' };
const DIR_NAME = { right: 'Вправо', left: 'Влево', up: 'Вверх', down: 'Вниз' };

// ---------- Цвет ----------
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function pickAccent(colors) {
  let best = null, bestScore = -1, second = null, secondScore = -1;
  for (const c of colors) {
    const [r, g, b] = hexRgb(c);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const v = mx / 255, s = mx ? (mx - mn) / mx : 0;
    const score = v * (0.45 + s);
    if (score > bestScore) { second = best; secondScore = bestScore; best = c; bestScore = score; }
    else if (score > secondScore) { second = c; secondScore = score; }
  }
  return [best || '#8b5cff', second || best || '#00e5ff'];
}
function onColor(hex) {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0a0a12' : '#ffffff';
}
function themeGradient(t) {
  if (t.effect === 'rainbow') return 'linear-gradient(100deg,#ff2a2a,#ffb000,#9dff00,#00e5a0,#00a2ff,#8b3dff,#ff2bd6,#ff2a2a)';
  const c = t.colors.length > 1 ? t.colors : [t.colors[0], t.colors[0]];
  return `linear-gradient(100deg,${c.join(',')},${c[0]})`;
}
function applyAccent() {
  if (!S) return;
  const rainbow = S.effect === 'rainbow';
  const [a, b] = rainbow ? ['#8b5cff', '#00e5ff'] : pickAccent(S.colors);
  const st = document.documentElement.style;
  st.setProperty('--accent', a);
  st.setProperty('--accent2', b);
  st.setProperty('--on-accent', onColor(a));
}

// ---------- Отрисовка светодиодов ----------
function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const dotCache = new Map();
function dotSize(dev, bw, bh) {
  const key = `${dev.id}:${Math.round(bw)}x${Math.round(bh)}`;
  if (dotCache.has(key)) return dotCache.get(key);
  const pts = dev.leds.map((l) => [l.x * bw, l.y * bh]);
  let sum = 0, cnt = 0;
  const step = Math.max(1, Math.floor(pts.length / 120));
  for (let i = 0; i < pts.length; i += step) {
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d < best) best = d;
    }
    if (best < Infinity) { sum += best; cnt++; }
  }
  const nn = cnt ? sum / cnt : Math.min(bw, bh) / 4;
  const size = clamp(nn * 0.55, 4, 15);
  dotCache.set(key, size);
  return size;
}
function drawDevice(canvas, dev, buf) {
  if (!(dev.aspect > 0 && Number.isFinite(dev.aspect))) dev.aspect = 1;
  if (!dev._clean) {
    dev._clean = true;
    for (const L of dev.leds) { if (!Number.isFinite(L.x)) L.x = 0.5; if (!Number.isFinite(L.y)) L.y = 0.5; }
  }
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = Math.max(14, Math.min(w, h) * 0.14);
  const capH = canvas.dataset.cap ? 20 : 0;
  const aw = w - pad * 2, ah = h - pad * 2 - capH;
  let bw = aw, bh = bw / dev.aspect;
  if (bh > ah) { bh = ah; bw = bh * dev.aspect; }
  const ox = (w - bw) / 2, oy = (h - capH - bh) / 2 + pad * 0.1;
  if (dev.plate) {
    const m = Math.min(bw, bh) * 0.06 + 6;
    rr(ctx, ox - m, oy - m, bw + m * 2, bh + m * 2, 14);
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  const dot = dotSize(dev, bw, bh);
  const leds = dev.leds;
  const lit = [];
  for (let i = 0; i < leds.length; i++) {
    const L = leds[i];
    const r = buf ? buf[i * 3] : 0, g = buf ? buf[i * 3 + 1] : 0, b = buf ? buf[i * 3 + 2] : 0;
    const rw = L.w ? Math.max(3, L.w * bw) : dot;
    const rh = L.h ? Math.max(3, L.h * bh) : dot;
    const x = ox + L.x * bw - rw / 2, y = oy + L.y * bh - rh / 2;
    const rad = L.w ? Math.min(rw, rh) * 0.28 : Math.min(rw, rh) / 2;
    if (r + g + b < 24) {
      rr(ctx, x, y, rw, rh, rad);
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      ctx.fill();
    } else lit.push([x, y, rw, rh, rad, r, g, b]);
  }
  if (lit.length) {
    ctx.globalCompositeOperation = 'lighter';
    const gl = Math.max(3, dot * 0.55);
    for (const [x, y, rw, rh, rad, r, g, b] of lit) {
      rr(ctx, x - gl, y - gl, rw + gl * 2, rh + gl * 2, rad + gl);
      ctx.fillStyle = `rgba(${r},${g},${b},.16)`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const [x, y, rw, rh, rad, r, g, b] of lit) {
      rr(ctx, x, y, rw, rh, rad);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fill();
    }
  }
}
function drawAll() {
  framesDirty = false;
  const byId = new Map(DEV.map((d) => [d.id, d]));
  for (const c of $$('canvas[data-dev]')) {
    const d = byId.get(c.dataset.dev);
    if (d) drawDevice(c, d, frames[d.id]);
  }
}
let lastAmbient = 0;
function updateAmbient(now) {
  if (now - lastAmbient < 90) return;
  lastAmbient = now;
  let lr = 0, lg = 0, lb = 0, ln = 0, rr_ = 0, rg = 0, rb = 0, rn = 0;
  for (const d of DEV) {
    const f = frames[d.id];
    if (!f) continue;
    for (let i = 0; i < d.leds.length; i++) {
      const R = f[i * 3], G = f[i * 3 + 1], B = f[i * 3 + 2];
      if (d.leds[i].x < 0.5) { lr += R; lg += G; lb += B; ln++; } else { rr_ += R; rg += G; rb += B; rn++; }
    }
  }
  const norm = (r, g, b, n) => {
    if (!n) return [0, [0, 0, 0]];
    r /= n; g /= n; b /= n;
    const mx = Math.max(r, g, b, 1);
    return [mx / 255, [r / mx * 255, g / mx * 255, b / mx * 255]];
  };
  const [la, lc] = norm(lr, lg, lb, ln);
  const [ra, rc] = norm(rr_, rg, rb, rn);
  const st = document.documentElement.style;
  const a = clamp(Math.max(la, ra) * 2.2, 0, 1);
  const prev = parseFloat(st.getPropertyValue('--gla')) || 0;
  st.setProperty('--gla', (prev + (a - prev) * 0.35).toFixed(3));
  if (la > 0.02) st.setProperty('--gl', lc.map(Math.round).join(','));
  if (ra > 0.02) st.setProperty('--gr', rc.map(Math.round).join(','));
}
function loop(now) {
  if (document.hidden) { requestAnimationFrame(loop); return; } // окно спрятано — не рисуем
  if (framesDirty) { drawAll(); updateAmbient(now); }
  drawMeter();
  requestAnimationFrame(loop);
}

// ---------- Вспомогательные ----------
const effectName = (id) => (CAT.effects[id] ? CAT.effects[id].name : id);
const allThemes = () => CAT.themes.concat(S.customThemes);
const currentTheme = () => allThemes().find((t) => t.id === S.themeId);
const isOff = (id) => S.disabledDevices.includes(id);
const devSig = () => DEV.map((d) => d.id + (isOff(d.id) ? 0 : 1) + (d.zones || []).map((z) => z.count).join('.')).join(',') + JSON.stringify(S.colorOrders || {});
function connLabel() {
  const real = DEV.filter((d) => d.source !== 'demo').length;
  if (real > 0) return { cls: 'ok', text: `Устройств: ${real}` };
  if (CONN.status === 'connecting') return { cls: 'busy', text: CONN.message || 'Подключаюсь…' };
  if (NATIVE.state === 'starting') return { cls: 'busy', text: 'Ищу устройства…' };
  return { cls: 'demo', text: S.settings.demoMode ? 'Демо-режим' : 'Нет устройств' };
}
function plural(n, a, b, c) {
  const m = n % 100, d = n % 10;
  if (m > 10 && m < 20) return c;
  if (d === 1) return a;
  if (d >= 2 && d <= 4) return b;
  return c;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const slider = (key, label, val) => `<div class="slide"><div class="slide-top"><span>${label}</span><output data-out="${key}">${val}%</output></div><input class="rng" type="range" min="0" max="100" step="1" value="${val}" data-slider="${key}" style="--p:${val}%" aria-label="${label}"></div>`;
const toggle = (key, on) => `<label class="tg"><input type="checkbox" data-set="${key}" ${on ? 'checked' : ''}><span></span></label>`;

// ---------- Страницы ----------
function deviceCard(d, withCap = true) {
  const wide = d.aspect >= 2 ? ' wide' : '';
  return `<div class="dev${wide}${isOff(d.id) ? ' off' : ''}"><canvas data-dev="${esc(d.id)}" ${withCap ? 'data-cap="1"' : ''}></canvas>${withCap ? `<span class="cap">${esc(d.name)}</span>` : ''}</div>`;
}

function pageHome() {
  const t = currentTheme();
  const mine = S.customThemes;
  const themes = themeTab === 'mine' ? mine : CAT.themes;
  const cards = themes.map((th) => `
    <div class="theme-wrap" style="position:relative">
      <button class="theme${th.id === S.themeId ? ' on' : ''}" data-act="theme" data-id="${esc(th.id)}" aria-pressed="${th.id === S.themeId}">
        <div class="sw" style="background-image:${themeGradient(th)}"></div>
        <div class="meta"><div class="name"${th.custom ? ' data-noi18n' : ''}>${esc(th.name)}</div><div class="tag">${esc(th.tagline || effectName(th.effect))}</div></div>
        <span class="check">${ICON_CHECK}</span>
      </button>
      ${th.custom ? `<div class="theme-acts">
        <button class="btn small" data-act="updtheme" data-id="${esc(th.id)}" title="Записать в тему текущие эффект, цвета и скорость">Обновить</button>
        <button class="btn small" data-act="renametheme" data-id="${esc(th.id)}">Имя</button>
        <button class="btn small" data-act="sharetheme" data-id="${esc(th.id)}" title="Скопировать код темы, чтобы отправить другу">Поделиться</button>
        <button class="btn small danger" data-act="deltheme" data-id="${esc(th.id)}" aria-label="Удалить тему ${esc(th.name)}">Удалить</button>
      </div>` : ''}
    </div>`).join('');
  const empty = `<div class="panel empty mine-empty"><b>Своих тем пока нет</b><p>Настрой эффект, цвета и скорость (на этой странице или в «Эффектах») и сохрани — тема появится здесь. Или нажми «Удиви меня» и сохрани то, что понравится. Тему от друга можно добавить по коду.</p><div class="row-btns"><button class="btn primary" data-act="savetheme">Сохранить текущие настройки как тему</button><button class="btn" data-act="importtheme">Добавить по коду</button></div></div>`;
  const tabs = `<div class="tabs" role="tablist" aria-label="Темы">
      <button role="tab" class="${themeTab === 'ready' ? 'on' : ''}" aria-selected="${themeTab === 'ready'}" data-act="tab" data-id="ready">Готовые <span>${CAT.themes.length}</span></button>
      <button role="tab" class="${themeTab === 'mine' ? 'on' : ''}" aria-selected="${themeTab === 'mine'}" data-act="tab" data-id="mine">Мои <span>${mine.length}</span></button>
    </div>`;
  return `<div class="page">
    <div class="head">
      <div><h1>Подсветка</h1><p class="sub js-sub">${esc(t ? t.name + ' · ' : '')}${esc(effectName(S.effect))}</p></div>
      <div class="head-acts">
        <button class="btn surprise" data-act="surprise" title="Случайная красивая тема (Ctrl+Alt+R)">${ICON_DICE}<span>Удиви меня</span></button>
        <button class="power js-power${S.power ? ' on' : ''}" data-act="power" aria-label="Включить или выключить подсветку" aria-pressed="${S.power}">${ICON_POWER}</button>
      </div>
    </div>
    ${updateBanner()}${scenarioBanner()}${healthBanners(false)}${playerCard()}
    <div class="panel stage">${DEV.length ? DEV.map((d) => deviceCard(d)).join('') : '<div class="stage-empty">Нет устройств. Включи демо-режим или подключи OpenRGB в разделе «Устройства».</div>'}</div>
    <div class="panel controls">${slider('brightness', 'Яркость', S.brightness)}${slider('speed', 'Скорость', S.speed)}
      ${WIN.available ? `<div class="win-row"><div><b>Красить Windows в цвет подсветки</b><span>Панель задач, «Пуск» и заголовки окон меняют цвет вместе с темой.</span></div>${toggle('winThemeEnabled', S.settings.winThemeEnabled)}</div>
      <div class="win-row"><div><b>Обои под тему</b><span>Lumen рисует обои рабочего стола в цветах подсветки. Прежние обои вернутся, когда выключишь.</span></div><div class="row-btns">${S.settings.winWallpaper ? wallStyleSelect() : ''}${toggle('winWallpaper', S.settings.winWallpaper)}</div></div>${photoPicker()}${musicRow()}` : ''}
    </div>
    <section>
      <div class="sec-head"><div class="sec-l"><h2>Темы</h2>${tabs}</div><div class="row-btns">${themeTab === 'mine' && mine.length ? '<button class="btn small" data-act="importtheme">Добавить по коду</button>' : ''}<button class="btn small" data-act="savetheme">Сохранить текущие настройки как тему</button></div></div>
      ${themes.length ? `<div class="themes">${cards}</div>` : empty}
    </section>
  </div>`;
}

function photoKey() { return S.effect === 'rainbow' ? 'rainbow' : S.colors.map((c) => c.toLowerCase()).join(','); }
async function loadPhotos(more = false) {
  if (PH.loading) return;
  const key = photoKey();
  if (!more) Object.assign(PH, { key, page: 1, items: [], shown: 8, selected: '', error: '', hasMore: false });
  PH.loading = true; PH.ver++; refresh();
  const r = await api.photoOptions(more ? PH.page + 1 : 1);
  PH.loading = false;
  if (PH.key !== key) { PH.ver++; refresh(); return; }
  if (!r || !r.ok) PH.error = (r && r.message) || 'Не удалось загрузить варианты';
  else {
    const seen = new Set(PH.items.map((x) => x.id));
    PH.items.push(...r.items.filter((x) => !seen.has(x.id)));
    PH.page = r.page; PH.hasMore = r.hasMore;
    if (!more) PH.selected = r.selected;
    else PH.shown += 8;
  }
  PH.ver++; refresh();
}
// Сетка вариантов фото (показывается, когда выбран стиль «Фото под тему»)
function photoPicker() {
  if (!S.settings.winWallpaper || S.settings.winWallpaperStyle !== 'photo') return '';
  if (PH.key !== photoKey() && !PH.loading) setTimeout(() => loadPhotos(false), 0);
  const pk = S.settings.photoPicks && S.settings.photoPicks[photoKey()];
  if (pk && PH.key === photoKey()) PH.selected = pk.id; // слайд-шоу могло сменить фото само
  // выбранное показываем всегда, даже если оно дальше первых 8
  const selIdx = PH.items.findIndex((x) => x.id === PH.selected);
  const cells = PH.items.map((it, i) => (i < PH.shown || i === selIdx ? ( `<button class="ph${it.id === PH.selected ? ' on' : ''}" data-act="photo-pick" data-i="${i}" title="${esc(it.res)}" aria-label="Фото ${i + 1}, ${esc(it.res)}"><img src="${it.src}" alt=""><span>${esc(it.res)}</span></button>`) : '')).join('');
  const status = PH.loading ? '<p class="note">Подбираю фото в цветах темы…</p>' : PH.error ? `<p class="note" style="color:var(--warn)">${esc(PH.error)}</p>` : !PH.items.length ? '<p class="note">Под этот цвет ничего не нашлось — попробуй другую тему.</p>' : '';
  return `<div class="photo-pick"><div class="ph-head"><b>Фото для этой темы</b><span>Выбери вариант — Lumen запомнит его для темы. Картинки из каталога Wallhaven.</span></div>
    ${cells ? `<div class="ph-grid">${cells}</div>` : ''}${status}
    <div class="row-btns" style="justify-content:space-between;width:100%">${PH.items.length && (PH.shown < PH.items.length || PH.hasMore) && !PH.loading ? '<button class="btn small" data-act="photo-more">Ещё варианты</button>' : '<span></span>'}
      <label class="chip" style="border:0;padding:0;background:none">Менять фото само
      <select class="field" data-set="photoRotate" aria-label="Слайд-шоу" style="height:32px;margin-left:6px">${[[0, 'не менять'], [30, 'каждые 30 минут'], [60, 'каждый час'], [180, 'каждые 3 часа'], [1440, 'раз в день']].map(([v, t]) => `<option value="${v}"${Number(S.settings.photoRotate) === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label></div></div>`;
}

// Подсветка от уведомлений
function notifyGroup(s) {
  const n = s.notify || { apps: {} };
  const st = WIN.notify || {};
  if (st.available === false) return '';
  const chips = NOTIFY_APPS.map((a) => `<label class="chip"><input type="checkbox" data-notify-app="${a.id}" ${n.apps[a.id] ? 'checked' : ''}><i class="sw" style="background:${a.color}"></i> <span data-noi18n>${esc(a.id === 'mail' ? window.LumenDom ? window.LumenDom.t(a.name) : a.name : a.name)}</span></label>`).join('')
    + `<label class="chip"><input type="checkbox" data-notify-app="other" ${n.apps.other ? 'checked' : ''}> Другие приложения <input type="color" data-notify-color value="${esc(n.otherColor)}" aria-label="Цвет для других приложений" class="sw-in"></label>`;
  return `<h3 class="grp">Подсветка от уведомлений</h3><div class="panel group">
    <div class="set"><div class="l"><b>Мигать при новом сообщении</b><span>Пришло уведомление в Discord, Telegram и других — подсветка дважды вспыхивает цветом приложения. Текст сообщений Lumen не читает, только от кого пришло уведомление.</span></div>
      <div class="row-btns">${n.enabled ? '<button class="btn small" data-act="notify-test">Проверить</button>' : ''}<label class="tg"><input type="checkbox" data-notify="enabled" ${n.enabled ? 'checked' : ''}><span></span></label></div></div>
    ${n.enabled ? `<div class="set"><div class="chips">${chips}</div></div>
    <div class="set"><div class="l"><b>Цвет вспышки</b><span>Чтобы уведомление было видно на любой подсветке: перед вспышкой подсветка на миг гаснет, а цвет подбирается непохожим на текущие.</span></div>
      <select class="field" data-notify="mode" aria-label="Цвет вспышки" style="height:34px;min-width:220px">${Object.entries({ auto: 'Цвет приложения, если заметен', contrast: 'Всегда контрастный к подсветке', app: 'Всегда цвет приложения' }).map(([k, v]) => `<option value="${k}"${k === (n.mode || 'auto') ? ' selected' : ''}>${v}</option>`).join('')}</select></div>` : ''}
    ${n.enabled && st.state === 'error' ? `<p class="note" style="color:var(--warn);padding:0 0 14px">${esc(st.message)}</p>` : ''}
    ${n.enabled ? '<p class="note" style="padding:0 0 14px">Работает для уведомлений, которые Windows показывает в углу экрана. Если в Windows включён режим «Не беспокоить», Lumen тоже не мигает.</p>' : ''}
  </div>`;
}

// Цвета под музыку: подсветка берёт цвета с обложки играющего трека
function musicRow() {
  const m = WIN.media || {};
  if (m.available === false) return '';
  const on = !!S.settings.musicColors;
  let st = '';
  if (on) {
    if (m.state === 'error') st = `<span style="color:var(--warn)">${esc(m.message)}</span>`;
    else if (m.playing && m.colors) st = `<span class="cover-now">Сейчас играет <span data-noi18n>${esc(appName(m.app))}</span> ${m.colors.map((c) => `<i class="sw" style="background:${esc(c)}"></i>`).join('')}</span>`;
    else st = '<span>Включи музыку — подсветка возьмёт цвета обложки.</span>';
  }
  return `<div class="win-row"><div><b>Цвета под музыку</b><span>Подсветка берёт цвета с обложки трека, который сейчас играет: Spotify, Яндекс Музыка, YouTube в браузере и другие.</span>${st}</div>${toggle('musicColors', on)}</div>`;
}
const appName = (aumid) => { const a = String(aumid || ''); if (/spotify/i.test(a)) return 'Spotify'; if (/yandex/i.test(a)) return 'Яндекс Музыка'; if (/chrome/i.test(a)) return 'Chrome'; if (/msedge|edge/i.test(a)) return 'Edge'; if (/firefox/i.test(a)) return 'Firefox'; if (/vk/i.test(a)) return 'VK'; return a.split(/[!\\.]/).pop() || 'музыка'; };

// Что сейчас играет: обложка, название и кнопки плеера (работает со Spotify, Яндекс Музыкой, браузером…)
const ICON_PREV = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4.5v15L19.5 12z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>';
function playerCard() {
  if (!NP) return '';
  return `<div class="panel player">
    <div class="cv"${NP.cover ? ` style="background-image:url('${esc(NP.cover)}')"` : ''}></div>
    <div class="txt" data-noi18n><b>${esc(NP.title || '—')}</b><span>${esc(NP.artist || '')}${NP.app ? ` · ${esc(appName(NP.app))}` : ''}</span></div>
    <div class="pl-btns">
      <button class="btn icon" data-act="media" data-m="prev" aria-label="Предыдущий трек" title="Предыдущий трек">${ICON_PREV}</button>
      <button class="btn icon primary" data-act="media" data-m="play" aria-label="${NP.playing ? 'Пауза' : 'Играть'}" title="${NP.playing ? 'Пауза' : 'Играть'}">${NP.playing ? ICON_PAUSE : ICON_PLAY}</button>
      <button class="btn icon" data-act="media" data-m="next" aria-label="Следующий трек" title="Следующий трек">${ICON_NEXT}</button>
    </div></div>`;
}

// Обновления: баннер на главной и блок в настройках
function updateBanner() {
  if (UPD.state !== 'ready') return '';
  return `<div class="panel banner upd"><i class="dot" style="width:10px;height:10px;background:var(--ok)"></i>
    <div class="txt"><b>Готова новая версия Lumen <span data-noi18n>${esc(UPD.version)}</span></b><span>Обновление уже скачано. Lumen закроется на несколько секунд и запустится снова.</span></div>
    <button class="btn primary" data-act="update-install">Обновить сейчас</button></div>`;
}
function updatesGroup(s) {
  if (UPD.available === false) return '';
  const st = UPD.state;
  const line = st === 'checking' ? 'Проверяю…' : st === 'latest' ? 'У тебя последняя версия.' : st === 'available' ? `Есть версия ${esc(UPD.version)}, скачиваю…` : st === 'downloading' ? `Скачиваю версию ${esc(UPD.version)}: ${UPD.progress || 0}%` : st === 'ready' ? `Версия ${esc(UPD.version)} скачана и готова к установке.` : st === 'error' ? `<span style="color:var(--warn)">${esc(UPD.message)}</span>` : '';
  return `<h3 class="grp">Обновления</h3><div class="panel group">
    <div class="set"><div class="l"><b>Обновлять автоматически</b><span>Lumen сам проверяет новые версии на GitHub, скачивает их в фоне и проверяет контрольную сумму. Устанавливает — только по твоей кнопке.</span></div>${toggle('autoUpdate', s.autoUpdate)}</div>
    <div class="set"><div class="l"><b>Версия <span data-noi18n>${esc(VERSION)}</span></b><span>${line}</span></div>
      <div class="row-btns">${st === 'ready' ? '<button class="btn small primary" data-act="update-install">Обновить сейчас</button>' : `<button class="btn small" data-act="update-check"${['checking', 'downloading'].includes(st) ? ' disabled' : ''}>Проверить обновления</button>`}</div></div>
  </div>`;
}

// Управление с телефона: QR-код со ссылкой в домашней сети
function remoteGroup(s) {
  const r = s.remote || {};
  const R = REMOTE || {};
  const body = !r.enabled ? '' : R.state === 'ok' && R.url ? `<div class="set remote-qr"><div class="qr" data-noi18n>${R.qr}</div>
      <div class="l"><b>Наведи камеру телефона на код</b><span>Телефон должен быть в той же сети Wi-Fi, что и компьютер. Откроется страница, где можно включать подсветку, менять яркость и темы.</span>
      <code class="url" data-noi18n>${esc(R.url)}</code>
      <span>Если Windows спросит про доступ к сети — разреши для частных сетей.</span>
      <div class="row-btns" style="margin-top:10px"><button class="btn small" data-act="remote-newlink" title="Старая ссылка перестанет работать">Новая ссылка</button></div></div></div>`
    : R.state === 'error' ? `<p class="note" style="color:var(--warn);padding:0 0 14px">${esc(R.message)}</p>` : '<p class="note" style="padding:0 0 14px">Запуск…</p>';
  return `<h3 class="grp">Управление с телефона</h3><div class="panel group">
    <div class="set"><div class="l"><b>Пульт на телефоне</b><span>Включай подсветку, меняй яркость и темы с телефона — без приложений, прямо в браузере.</span></div><label class="tg"><input type="checkbox" data-remote="enabled" ${r.enabled ? 'checked' : ''}><span></span></label></div>
    ${body}
  </div>`;
}

const WIDGET_ITEMS = { cpu: 'Процессор', ram: 'Память', gpu: 'Видеокарта (нагрузка, °C, ватты)', vram: 'Видеопамять', net: 'Скорость сети', disk: 'Свободно на диске C:', uptime: 'Сколько включён компьютер' };
// Виджеты на рабочем столе (рисуются в слое обоев за значками)
function widgetsGroup(s) {
  const w = s.widgets || {};
  const wt = (k, on) => `<label class="tg"><input type="checkbox" data-widget="${k}" ${on ? 'checked' : ''}><span></span></label>`;
  const corners = { tr: 'Справа сверху', tl: 'Слева сверху', br: 'Справа снизу', bl: 'Слева снизу' };
  const wsel = (k, opts, cur, label) => `<select class="field" data-widget="${k}" aria-label="${label}" style="height:34px;min-width:130px">${Object.entries(opts).map(([v, n]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  const err = w.enabled && WIN.live && WIN.live.state === 'error' ? `<p class="note" style="color:var(--warn);padding:0 0 14px">${esc(WIN.live.message)}</p>` : '';
  return `<h3 class="grp">Виджеты на рабочем столе</h3><div class="panel group">
    <div class="set"><div class="l"><b>Показывать виджеты</b><span>Часы, погода, нагрузка компьютера, музыка и календарь прямо на обоях, за значками. Обновляются редко и замирают, когда рабочий стол закрыт игрой или окном, — ресурсов почти не тратят.</span></div>${wt('enabled', w.enabled)}</div>
    ${w.enabled ? `<div class="set"><div class="l"><b>Часы и дата</b></div><div class="row-btns">${w.clock ? `<label class="chip"><input type="checkbox" data-widget="seconds" ${w.seconds ? 'checked' : ''}> секунды</label>` : ''}${wt('clock', w.clock)}</div></div>
    <div class="set"><div class="l"><b>Погода</b><span>Из бесплатных сервисов Open-Meteo, MET Norway и wttr.in — если один не отвечает, берётся другой. Обновляется раз в 15 минут.</span></div>
      <div class="row-btns">${w.weather ? `<label class="chip"><input type="checkbox" data-widget="forecast" ${w.forecast ? 'checked' : ''}> прогноз на 3 дня</label><input class="field" data-widget="city" value="${esc(w.city)}" placeholder="Город, например Москва" aria-label="Город для погоды" style="width:190px">` : ''}${wt('weather', w.weather)}</div></div>
    <div class="set"><div class="l"><b>Компьютер</b><span>Отметь, что показывать.</span></div>${wt('system', w.system)}</div>
    ${w.system ? `<div class="set"><div class="chips">${Object.entries(WIDGET_ITEMS).map(([k, v]) => `<label class="chip"><input type="checkbox" data-widget-item="${k}" ${w.items && w.items[k] ? 'checked' : ''}> ${v}</label>`).join('')}</div></div>` : ''}
    <div class="set"><div class="l"><b>Сейчас играет</b><span>Название трека, исполнитель и обложка — из Spotify, Яндекс Музыки, браузера и других плееров. Видно, только пока играет музыка.</span></div><div class="row-btns">${w.media ? `<label class="chip" title="Щелчок по кнопке на рабочем столе переключает трек. Lumen замечает такие щелчки, только пока рабочий стол открыт; в играх и развёрнутых окнах — нет."><input type="checkbox" data-widget="mediaButtons" ${w.mediaButtons ? 'checked' : ''}> кнопки плеера</label><label class="chip"><input type="checkbox" data-widget="lyrics" ${w.lyrics ? 'checked' : ''}> строчка из текста песни</label>` : ''}${wt('media', w.media)}</div></div>
    <div class="set"><div class="l"><b>Календарь</b><span>Текущий месяц, сегодняшний день выделен цветом подсветки.</span></div>${wt('calendar', w.calendar)}</div>
    <div class="set"><div class="l"><b>Заметка</b><span>Любой текст на рабочем столе: напоминание, цель, цитата.</span></div><div class="row-btns">${w.note ? `<input class="field" data-widget="noteText" value="${esc(w.noteText || '')}" maxlength="160" placeholder="Например: попить воды 💧" aria-label="Текст заметки" style="width:230px">` : ''}${wt('note', w.note)}</div></div>
    <div class="set"><div class="l"><b>Оформление</b><span>Как выглядят карточки, часы и полоски нагрузки.</span></div><div class="row-btns">
      ${wsel('style', { glass: 'Стекло', solid: 'Плотные', minimal: 'Без подложки', neon: 'Неон' }, w.style, 'Стиль карточек')}
      ${w.style === 'minimal' ? '' : wsel('opacity', { low: 'Прозрачные', mid: 'Полупрозрачные', high: 'Тёмные' }, w.opacity, 'Прозрачность')}
      ${wsel('clockStyle', { thin: 'Часы: тонкие', bold: 'Часы: жирные', mono: 'Часы: как на табло' }, w.clockStyle, 'Шрифт часов')}
      ${wsel('accent', { theme: 'Цвет: как подсветка', white: 'Цвет: белый' }, w.accent, 'Цвет акцентов')}</div></div>
    <div class="set"><div class="l"><b>Где и какого размера</b></div><div class="row-btns">
      <select class="field" data-widget="size" aria-label="Размер виджетов" style="height:34px;min-width:120px">${Object.entries({ s: 'Маленькие', m: 'Средние', l: 'Крупные' }).map(([k, v]) => `<option value="${k}"${k === w.size ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <select class="field" data-widget="corner" aria-label="Угол экрана" style="height:34px;min-width:150px">${Object.entries(corners).map(([k, v]) => `<option value="${k}"${k === w.corner ? ' selected' : ''}>${v}</option>`).join('')}</select></div></div>` : ''}
    ${err}
  </div>`;
}

function wallStyleSelect() {
  const cur = S.settings.winWallpaperStyle;
  return `<select class="field wall-style" data-set="winWallpaperStyle" aria-label="Стиль обоев">${Object.entries(CAT.wallStyles).map(([id, st]) => `<option value="${id}"${id === cur ? ' selected' : ''}>${esc(st.name)}</option>`).join('')}</select>`;
}

function scenarioBanner() {
  if (!SCN.active) return '';
  const paused = SCN.paused;
  return `<div class="panel scn-banner${paused ? ' paused' : ''}">${svg(NAV.scenes[1], 20)}
    <div class="txt"><b>${paused ? 'Сценарий на паузе' : 'Работает сценарий'}</b><span>${esc(SCN.active.label)}${paused ? '. Ты поменял подсветку вручную — сценарий вернётся, когда условие сменится.' : ''}</span></div>
    ${paused ? '<button class="btn small" data-act="resume">Вернуть сценарий</button>' : '<button class="btn small" data-act="goto-scenes">Сценарии</button>'}
  </div>`;
}

// ---------- Сценарии ----------
const IDLE_OPTS = [0, 5, 10, 15, 30, 60];
function themeOptions(sel, withOff) {
  const opt = (v, label) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  return (withOff ? opt('off', 'Выключить подсветку') : '')
    + `<optgroup label="Готовые">${CAT.themes.map((t) => opt(withOff ? 'theme:' + t.id : t.id, t.name)).join('')}</optgroup>`
    + (S.customThemes.length ? `<optgroup label="Мои">${S.customThemes.map((t) => opt(withOff ? 'theme:' + t.id : t.id, t.name)).join('')}</optgroup>` : '');
}
function pageScenes() {
  const sc = S.scenarios;
  const apps = sc.apps.map((a, i) => `<div class="sc-row">
      <div class="sc-exe">${svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>', 18)}<b>${esc(a.exe)}</b></div>
      <span class="sc-arrow">включает тему</span>
      <select class="field" data-sc-app="${i}" aria-label="Тема для ${esc(a.exe)}">${themeOptions(a.themeId, false)}</select>
      <button class="btn small danger" data-act="sc-del-app" data-i="${i}" aria-label="Удалить правило ${esc(a.exe)}">Удалить</button>
    </div>`).join('');
  const sched = sc.schedule.map((r, i) => `<div class="sc-row">
      <div class="sc-time"><span>с</span><input class="field" type="time" value="${r.from}" data-sc-sched="from" data-i="${i}" aria-label="Начало"><span>до</span><input class="field" type="time" value="${r.to}" data-sc-sched="to" data-i="${i}" aria-label="Конец"></div>
      <select class="field" data-sc-sched="mode" data-i="${i}" aria-label="Что делать">${themeOptions(r.mode === 'off' ? 'off' : 'theme:' + r.themeId, true)}</select>
      <button class="btn small danger" data-act="sc-del-sched" data-i="${i}" aria-label="Удалить время">Удалить</button>
    </div>`).join('');
  return `<div class="page">
    <div class="head"><div><h1>Сценарии</h1><p class="sub">Подсветка сама меняется, когда ты играешь, ложишься спать или отходишь от компьютера.</p></div></div>
    ${scenarioBanner()}
    <section>
      <div class="sec-head"><h2>Игры и программы</h2></div>
      <div class="panel group sc">
        ${apps || '<p class="note sc-empty">Например: запустил CS2 — включилась тема «Геймер», закрыл — вернулась прежняя.</p>'}
        <div class="sc-row sc-add">
          <input class="field" id="sc-exe" list="sc-apps" placeholder="Название программы, например cs2.exe" aria-label="Программа">
          <datalist id="sc-apps">${APPS.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
          <select class="field" id="sc-theme" aria-label="Тема">${themeOptions('gamer', false)}</select>
          <button class="btn small primary" data-act="sc-add-app">Добавить</button>
        </div>
        <p class="note sc-hint">${APPS.length ? `Открытые программы есть в подсказках поля (${APPS.length}).` : 'Запусти игру и нажми «Найти открытые программы» — её можно будет выбрать из списка.'} <button class="link" data-act="sc-load-apps">Найти открытые программы</button></p>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>Расписание</h2><button class="btn small" data-act="sc-add-sched">Добавить время</button></div>
      <div class="panel group sc">${sched || '<p class="note sc-empty">Например: с 23:00 до 07:00 подсветка выключена, а вечером — тёплый «Ночник».</p>'}</div>
    </section>
    <section>
      <div class="sec-head"><h2>Гасить автоматически</h2></div>
      <div class="panel group">
        <div class="set"><div class="l"><b>Когда компьютер заблокирован</b><span>Win+L — подсветка гаснет, вошёл обратно — загорается.</span></div><label class="tg"><input type="checkbox" data-sc-bool="offOnLock" ${sc.offOnLock ? 'checked' : ''}><span></span></label></div>
        <div class="set"><div class="l"><b>Когда я отошёл от компьютера</b><span>Если долго нет движений мыши и нажатий клавиш.</span></div>
          <select class="field" data-sc-idle aria-label="Через сколько гасить">${IDLE_OPTS.map((m) => `<option value="${m}"${m === sc.idleMinutes ? ' selected' : ''}>${m ? `через ${m} мин` : 'Никогда'}</option>`).join('')}</select></div>
        <div class="set"><div class="l"><b>При сне и выключении компьютера</b><span>Чтобы подсветка не горела всю ночь, когда компьютер выключен.</span></div><label class="tg"><input type="checkbox" data-sc-bool="offOnSleep" ${sc.offOnSleep ? 'checked' : ''}><span></span></label></div>
      </div>
    </section>
  </div>`;
}
function saveScenarios(mut) {
  const sc = JSON.parse(JSON.stringify(S.scenarios));
  mut(sc);
  api.setScenarios(sc);
}

function pageEffects() {
  const def = CAT.effects[S.effect];
  const effs = Object.values(CAT.effects).map((e) => `
    <button class="fx${e.id === S.effect ? ' on' : ''}" data-act="effect" data-id="${e.id}" aria-pressed="${e.id === S.effect}">
      <span class="ico">${svg(FXI[e.id] || '', 20)}</span>
      <span><span class="nm">${esc(e.name)}</span><br><span class="ds">${esc(e.desc)}</span></span>
    </button>`).join('');

  let colorsHtml;
  if (def.palette === 'none') {
    colorsHtml = S.effect === 'screen' ? '<p class="note">Цвета берутся с экрана: левая часть корпуса светится цветом левой части монитора, правая — правой.</p>' : '<p class="note">Радуга использует весь спектр, поэтому цвета выбирать не нужно.</p>';
  } else {
    const max = def.palette === 'single' ? 1 : 6;
    const shown = S.colors.slice(0, max);
    colorsHtml = `${max > 1 ? `<div class="gradbar" style="background:${themeGradient({ effect: 'x', colors: shown })}"></div>` : ''}
      <div class="pal">${shown.map((c, i) => `<div class="sw-c" style="background:${c}"><input type="color" value="${c}" data-color="${i}" aria-label="Цвет ${i + 1}">${shown.length > 1 ? `<button class="rm" data-act="rmcolor" data-i="${i}" aria-label="Убрать цвет ${i + 1}">${ICON_X}</button>` : ''}</div>`).join('')}
      ${shown.length < max ? `<button class="sw-add" data-act="addcolor" aria-label="Добавить цвет">${svg('<path d="M12 5v14M5 12h14"/>', 18, 2)}</button>` : ''}</div>`;
  }

  const dirHtml = def.dir
    ? `<div><h3>Направление</h3><div class="seg" role="group" aria-label="Направление">${CAT.directions.map((d) => `<button class="${S.direction === d ? 'on' : ''}" data-act="dir" data-id="${d}" aria-label="${DIR_NAME[d]}" aria-pressed="${S.direction === d}" title="${DIR_NAME[d]}">${svg(ARROW[d], 18, 2)}</button>`).join('')}</div></div>`
    : '';

  let musicHtml = '';
  if (S.effect === 'music') {
    const msg = {
      off: 'Звук не слушаю.',
      starting: 'Подключаюсь к звуку…',
      on: 'Слушаю звук, который идёт в колонки или наушники.',
      error: audio.message || 'Не удалось получить звук.',
    }[audio.status];
    musicHtml = `<div><h3>Звук</h3><p class="note" style="margin-bottom:10px">${esc(msg)}</p>
      <div class="meter" aria-hidden="true">${'<i></i>'.repeat(16)}</div>
      ${audio.status === 'error' ? '<button class="btn small" data-act="retryaudio" style="margin-top:12px">Повторить</button>' : ''}</div>`;
  }
  if (S.effect === 'screen') {
    const msg = { off: 'Экран не захватываю.', starting: 'Подключаюсь к экрану…', on: 'Смотрю на основной монитор: подсветка повторяет картинку.', error: screenCap.message || 'Не удалось получить картинку экрана.' }[screenCap.status];
    musicHtml = `<div><h3>Экран</h3><p class="note">${esc(msg)}</p>${screenCap.status === 'error' ? '<button class="btn small" data-act="retryscreen" style="margin-top:12px">Повторить</button>' : ''}</div>`;
  }
  if (S.effect === 'temperature') {
    const t = SENS.gpuTemp;
    musicHtml = `<div><h3>Видеокарта</h3>${t != null
      ? `<div class="temp"><b class="js-temp">${t} °C</b><span class="js-load">загрузка ${SENS.gpuLoad ?? 0}%</span></div><p class="note">Первый цвет — холодная (35 °C), последний — горячая (80 °C). Под нагрузкой подсветка пульсирует быстрее.</p>`
      : `<p class="note">${esc(SENS.message || 'Читаю температуру…')}</p>`}</div>`;
  }
  // для превью — включённое устройство с наибольшим числом светодиодов
  const first = DEV.filter((d) => !isOff(d.id)).sort((a, b) => b.count - a.count)[0] || DEV[0];
  return `<div class="page">
    <div class="head"><div><h1>Эффекты</h1><p class="sub">Собери свою подсветку: выбери эффект и цвета.</p></div></div>
    ${first ? `<div class="dev fx-preview"><canvas data-dev="${esc(first.id)}"></canvas></div>` : ''}
    <div class="fx-layout">
      <div class="fx-grid">${effs}</div>
      <aside class="panel side">
        <div><h3>Цвета</h3>${colorsHtml}</div>
        ${dirHtml}
        <div>${slider('speed', 'Скорость', S.speed)}</div>
        ${musicHtml}
        <button class="btn" data-act="savetheme">Сохранить как тему</button>
      </aside>
    </div>
  </div>`;
}

function nativeBanner() {
  const n = NATIVE.count;
  const dot = (c) => `<i class="dot" style="width:10px;height:10px;background:${c}"></i>`;
  const wrap = (d, title, sub, btns) => `<div class="panel banner">${d}<div class="txt"><b>${title}</b><span>${sub}</span></div>${btns}</div>`;
  const rescan = '<button class="btn" data-act="rescan">Искать снова</button>';
  if (NATIVE.state === 'ready' && n > 0) return wrap(dot('var(--ok)'), 'Windows: устройства подключены', `Найдено: ${n} ${plural(n, 'устройство', 'устройства', 'устройств')}. Сторонние программы не нужны.`, rescan);
  if (NATIVE.state === 'ready') return wrap(dot('var(--warn)'), 'Windows не видит устройств с «Динамической подсветкой»', 'Включи «Динамическую подсветку» в параметрах Windows и убедись, что твои устройства есть в списке.', `<button class="btn primary" data-act="open-lighting">Открыть параметры</button>${rescan}`);
  if (NATIVE.state === 'starting') return wrap(dot('var(--warn)'), 'Ищу устройства Windows…', 'Это занимает несколько секунд.', '');
  if (NATIVE.state === 'error') return wrap(dot('var(--bad)'), 'Встроенное управление не запустилось', esc(NATIVE.message || 'Неизвестная ошибка'), rescan);
  if (NATIVE.state === 'unsupported') return wrap(dot('var(--dim)'), 'Встроенное управление недоступно', 'Оно работает только в Windows 11.', '');
  return wrap(dot('var(--dim)'), 'Встроенное управление выключено', 'Включи его, чтобы Lumen сам нашёл устройства.', '<button class="btn primary" data-act="enable-native">Включить</button>');
}

const ORDER_LABEL = { RGB: 'Обычный (RGB)', GRB: 'GRB — красный и зелёный наоборот', BRG: 'BRG', RBG: 'RBG — зелёный и синий наоборот', GBR: 'GBR', BGR: 'BGR — красный и синий наоборот' };
function zonesBlock(d) {
  if (!d.zones || !d.zones.length) return '';
  const rows = d.zones.map((z) => {
    const cur = (S.colorOrders || {})[`${d.id}|${z.name}`] || 'RGB';
    const auto = (S.zoneAuto || {})[`${d.id}|${z.name}`];
    const presets = [8, 12, 16, 24, 40, 60, 80, 120].filter((n) => n >= z.min && n <= z.max);
    const size = z.resizable
      ? `<label class="zsize"><input class="field" type="number" min="${z.min}" max="${z.max}" value="${z.count}" data-size-dev="${esc(d.id)}" data-size-zone="${esc(z.name)}" aria-label="Светодиодов в зоне ${esc(z.name)}"><span>светод.</span>${auto ? '<b class="zauto">поставил сам — уточни</b>' : ''}</label>
        <div class="zpre">${presets.map((n) => `<button class="chip${n === z.count ? ' on' : ''}" data-act="zone-preset" data-dev="${esc(d.id)}" data-zone="${esc(z.name)}" data-n="${n}">${n}</button>`).join('')}</div>`
      : `<span class="zfixed">${z.count} ${plural(z.count, 'светодиод', 'светодиода', 'светодиодов')}</span>`;
    return `<div class="zone"><div class="zn">${esc(z.name)}${size}</div>
      <select class="field" data-order-dev="${esc(d.id)}" data-order-zone="${esc(z.name)}" aria-label="Порядок цветов: ${esc(z.name)}">${Object.keys(ORDER_LABEL).map((o) => `<option value="${o}"${o === cur ? ' selected' : ''}>${ORDER_LABEL[o]}</option>`).join('')}</select>
      <button class="btn small" data-act="testzone" data-dev="${esc(d.id)}" data-zone="${esc(z.name)}">Проверить</button></div>`;
  }).join('');
  const needSize = d.zones.some((z) => z.resizable && (z.count === 0 || (S.zoneAuto || {})[`${d.id}|${z.name}`]));
  return `<details class="zones" data-key="zones:${esc(d.id)}"${needSize ? ' open' : ''}><summary>Настроить зоны: количество светодиодов и порядок цветов${needSize ? ' <b class="warn">— укажи, сколько светодиодов подключено</b>' : ''}</summary>
    <p class="note">${d.zones.some((z) => z.resizable) ? 'У разъёмов на материнской плате укажи, сколько светодиодов подключено: один вентилятор — обычно 8–24, несколько вентиляторов цепочкой — складывай, лента — смотри по упаковке. <b>Не знаешь точно — ставь больше:</b> лишние светодиоды ничего не ломают, а если поставить мало, светится только начало вентилятора. ' : ''}Если цвета не совпадают, нажми «Проверить»: зона загорится красным, зелёным и синим по очереди. Если увидишь другие цвета, выбери другой порядок.</p>${rows}</details>`;
}

// Предупреждения: другая RGB-программа забирает устройства / движок нашёл не все устройства
function healthBanners(withMissing) {
  const H = HEALTH || {};
  let h = '';
  for (const c of H.conflicts || []) {
    h += `<div class="panel banner warnb"><i class="dot" style="width:10px;height:10px;background:var(--warn)"></i>
      <div class="txt"><b>Подсветкой сейчас управляет другая программа: <span data-noi18n>${esc(c.name)}</span></b><span>Пока она запущена, Lumen не может подсвечивать часть устройств. Закрой её и выключи её запуск вместе с Windows в её настройках.</span></div>
      <button class="btn primary" data-act="close-conflict" data-id="${esc(c.id)}">Закрыть программу</button></div>`;
  }
  if (withMissing) for (const u of H.unsupported || []) {
    h += `<div class="panel banner warnb hint"><i class="dot" style="width:10px;height:10px;background:var(--warn)"></i>
      <div class="txt"><b>${esc(u.title)}</b><ol>${u.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>
      <button class="btn small" data-act="hide-hint" data-id="${esc(u.id)}">Понятно</button></div>`;
  }
  if (withMissing && (H.missing || []).length) {
    h += `<div class="panel banner warnb"><i class="dot" style="width:10px;height:10px;background:var(--warn)"></i>
      <div class="txt"><b>Движок нашёл не все устройства</b><span>Не найдено: <span data-noi18n>${esc([...new Set(H.missing.map((d) => d.name))].join(', '))}</span>. Обычно помогает перезапуск движка.</span></div>
      <div class="row-btns"><button class="btn small" data-act="forget-missing" title="Я убрал это устройство — больше не напоминать">Больше не напоминать</button><button class="btn primary" data-act="restart-engine">Перезапустить движок</button></div></div>`;
  }
  return h;
}

// Оперативная память: движку нужны драйвер PawnIO и права администратора
function memCard() {
  const A = CONN.admin;
  if (!CONN.bundled || !A || !A.available) return '';
  if (A.state === 'working') return `<div class="panel banner"><i class="dot" style="width:10px;height:10px;background:var(--warn)"></i><div class="txt"><b>Включаю подсветку памяти…</b><span>${esc(A.message || '')}</span></div></div>`;
  if (A.on) return '';
  const err = A.state === 'error' ? `<span style="color:var(--warn)">${esc(A.message)}</span>` : '';
  return `<div class="panel banner"><i class="dot" style="width:10px;height:10px;background:var(--dim)"></i>
    <div class="txt"><b>Не видно оперативной памяти?</b><span>Чтобы управлять подсветкой памяти, движку нужен системный драйвер PawnIO и права администратора. Нажми кнопку и согласись в окне Windows — это нужно сделать один раз.</span>${err}</div>
    <button class="btn primary" data-act="engine-admin-on">Включить подсветку памяти</button></div>`;
}

function pageDevices() {
  const connected = CONN.status === 'connected';
  const B = !!CONN.bundled;
  const title = connected ? (B ? 'Движок подсветки работает' : 'OpenRGB подключён')
    : CONN.status === 'connecting' ? (B ? 'Запускаю движок подсветки…' : 'Подключаюсь к OpenRGB…')
    : (B ? 'Движок подсветки не запущен' : 'OpenRGB: для платы, видеокарты и вентиляторов');
  const idle = B ? 'Плата, видеокарта, вентиляторы, водянка, клавиатуры и мыши большинства производителей.' : 'Windows не умеет подсвечивать их сама. Для них нужна бесплатная программа OpenRGB.';
  const banner = `<div class="panel banner">
    <i class="dot" style="width:10px;height:10px;background:${connected ? 'var(--ok)' : CONN.status === 'connecting' ? 'var(--warn)' : 'var(--dim)'}"></i>
    <div class="txt"><b>${title}</b>
    <span>${connected ? `Найдено: ${CONN.count} ${plural(CONN.count, 'устройство', 'устройства', 'устройств')}` : esc(CONN.message || idle)}</span></div>
    ${connected ? '<button class="btn" data-act="disconnect">Отключить</button>' : `<button class="btn primary" data-act="connect"${CONN.status === 'connecting' ? ' disabled' : ''}>${B ? 'Запустить' : 'Подключиться'}</button>`}
  </div>${healthBanners(true)}${memCard()}`;
  const help = connected || B ? '' : `<details class="panel steps-wrap" data-key="steps"><summary>Как подключить материнскую плату, видеокарту и вентиляторы</summary><ol class="steps">
    <li><div><b>Скачай OpenRGB</b><p>Бесплатная программа, которая умеет управлять подсветкой материнских плат, памяти, видеокарт и вентиляторов.</p><button class="btn small" data-act="openrgb-site" style="margin-top:10px">Открыть openrgb.org</button></div></li>
    <li><div><b>Укажи, где она лежит</b><p>Если указать путь к OpenRGB.exe в настройках, Lumen будет запускать её сам и включать режим сервера.</p><button class="btn small" data-act="goto-settings" style="margin-top:10px">Указать путь</button></div></li>
    <li><div><b>Нажми «Подключиться»</b><p>Устройства появятся в списке, и подсветка начнёт слушаться Lumen.</p></div></li>
  </ol></details>`;
  const rows = DEV.length
    ? DEV.map((d) => `<div class="panel row">
        <canvas data-dev="${esc(d.id)}"></canvas>
        <div><div class="nm">${esc(d.name)}</div><div class="meta">${d.source === 'native' ? 'Windows' : esc(d.vendor)} · ${d.count} ${plural(d.count, 'светодиод', 'светодиода', 'светодиодов')}${d.source === 'demo' ? ' · демо' : ''}${d.available === false ? ' · <span style="color:var(--warn)">сейчас управляет другая программа</span>' : ''}</div></div>
        <label class="tg" title="Подсветка устройства"><input type="checkbox" data-dev-toggle="${esc(d.id)}" ${isOff(d.id) ? '' : 'checked'} aria-label="Подсветка: ${esc(d.name)}"><span></span></label>
        ${zonesBlock(d)}
      </div>`).join('')
    : `<div class="panel empty">${connected ? 'OpenRGB подключён, но устройств не нашёл. Проверь, что OpenRGB видит оборудование.' : 'Устройств нет.'}</div>`;
  return `<div class="page"><div class="head"><div><h1>Устройства</h1><p class="sub">Включай и выключай подсветку каждого устройства отдельно.</p></div></div>${nativeBanner()}${banner}${help}<div class="list">${rows}</div></div>`;
}

function pageSettings() {
  const s = S.settings;
  const lab = connLabel();
  const winErr = WIN.state === 'error' ? `<p class="note" style="color:var(--bad);padding:0 0 14px">${esc(WIN.message)}</p>` : '';
  const winGroup = WIN.available ? `<h3 class="grp">Оформление Windows</h3><div class="panel group">
      <div class="set"><div class="l"><b>Менять цвет Windows под тему подсветки</b><span>Акцентный цвет панели задач, меню «Пуск» и заголовков окон будет следовать за подсветкой. Прежний цвет можно вернуть в любой момент.</span></div>${toggle('winThemeEnabled', s.winThemeEnabled)}</div>
      <div class="set"><div class="l"><b>Переключить Windows на тёмную тему</b><span>Нужна, чтобы цвет показывался на панели задач. При выключении вернётся прежняя тема.</span></div>${toggle('winForceDark', s.winForceDark)}</div>
      <div class="set"><div class="l"><b>Менять обои под тему</b><span>Lumen рисует обои рабочего стола в цветах подсветки. Прежние обои сохраняются и возвращаются, когда выключишь.</span></div>${toggle('winWallpaper', s.winWallpaper)}</div>
      <div class="set"><div class="l"><b>Стиль обоев</b><span>${esc((CAT.wallStyles[s.winWallpaperStyle] || {}).desc || '')}</span></div>${wallStyleSelect()}</div>
      ${photoPicker() ? `<div class="set">${photoPicker()}</div>` : ''}
      ${WIN.wallpaper && WIN.wallpaper.state === 'working' && WIN.wallpaper.message ? `<p class="note" style="padding:0 0 14px">${esc(WIN.wallpaper.message)}</p>` : ''}
      ${WIN.wallpaper && WIN.wallpaper.state === 'warn' ? `<p class="note" style="color:var(--warn);padding:0 0 14px">${esc(WIN.wallpaper.message)}</p>` : ''}
      ${s.winWallpaper && s.winWallpaperStyle === 'live' && WIN.live && WIN.live.state === 'error' ? `<p class="note" style="color:var(--warn);padding:0 0 14px">${esc(WIN.live.message)}</p>` : ''}
      <div class="set"><div class="l"><b>Возвращать прежнее оформление при выходе из Lumen</b><span>Цвет Windows и обои вернутся. Если выключить, останутся такими, какими были при закрытии.</span></div>${toggle('winRestoreOnExit', s.winRestoreOnExit)}</div>
      ${winErr}${WIN.wallpaper && WIN.wallpaper.state === 'error' ? `<p class="note" style="color:var(--bad);padding:0 0 14px">${esc(WIN.wallpaper.message)}</p>` : ''}
    </div>
    ${widgetsGroup(s)}${notifyGroup(s)}` : '';
  return `<div class="page">
    <div class="head"><div><h1>Настройки</h1><p class="sub">${esc(lab.text)}</p></div></div>
    <h3 class="grp">Подсветка средствами Windows</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Находить устройства самому</b><span>Работает с устройствами, которые поддерживают «Динамическую подсветку» Windows 11. Сторонние программы не нужны.</span></div>${toggle('nativeEnabled', s.nativeEnabled)}</div>
      <div class="set"><div class="l"><b>Параметры «Динамической подсветки»</b><span>Если подсветка не меняется, проверь там, что подсветка включена и разрешено фоновое управление.</span></div><button class="btn small" data-act="open-lighting">Открыть параметры Windows</button></div>
    </div>
    ${winGroup}
    ${CONN.bundled ? `<h3 class="grp">Движок подсветки (плата, видеокарта, вентиляторы)</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Встроен в Lumen</b><span>Lumen сам запускает движок без окна и закрывает его при выходе. Ничего скачивать и настраивать не нужно.</span></div>
        <button class="btn small" data-act="goto-devices">Устройства</button></div>
      ${CONN.admin && CONN.admin.available ? `<div class="set"><div class="l"><b>Подсветка оперативной памяти</b><span>${CONN.admin.on ? 'Включена: движок работает с правами администратора и драйвером PawnIO.' : 'Память и часть плат видны движку только с драйвером PawnIO и правами администратора. Включается один раз, дальше без вопросов.'}</span></div>
        <button class="btn small${CONN.admin.on ? '' : ' primary'}" data-act="${CONN.admin.on ? 'engine-admin-off' : 'engine-admin-on'}"${CONN.admin.state === 'working' ? ' disabled' : ''}>${CONN.admin.on ? 'Выключить' : 'Включить'}</button></div>` : ''}
    </div>` : `<h3 class="grp">OpenRGB (для платы, видеокарты, вентиляторов)</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Подключаться к OpenRGB автоматически</b><span>Пробовать снова, если связь пропала.</span></div>${toggle('autoConnect', s.autoConnect)}</div>
      <div class="set"><div class="l"><b>Запускать OpenRGB вместе с Lumen</b><span>Lumen откроет OpenRGB в режиме сервера, если он не запущен.</span></div>${toggle('launchOpenrgb', s.launchOpenrgb)}</div>
      <div class="set"><div class="l"><b>Файл OpenRGB.exe</b><span>Обычно находится сам. Укажи вручную, если не нашёлся.</span></div>
        <div class="path"><input class="field" readonly value="${esc(s.openrgbPath || 'Не выбран')}" aria-label="Путь к OpenRGB.exe"><button class="btn small" data-act="pick">Выбрать…</button></div></div>
      <div class="set"><div class="l"><b>Адрес и порт</b><span>Менять нужно, только если OpenRGB работает на другом компьютере.</span></div>
        <div class="hp"><input class="field" data-set="host" value="${esc(s.host)}" aria-label="Адрес"><input class="field" data-set="port" value="${s.port}" inputmode="numeric" aria-label="Порт"></div></div>
    </div>`}
    <h3 class="grp">Горячие клавиши</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Управлять подсветкой с клавиатуры</b><span>Работает в любой программе, даже в игре.</span></div>${toggle('hotkeys', s.hotkeys)}</div>
      ${s.hotkeys ? `<div class="keys">${HK.list.map((h) => `<div class="key-row"><kbd>${h.keys.split('+').map(esc).join('</kbd>+<kbd>')}</kbd><span>${esc(h.label)}${HK.failed.includes(h.keys) ? ' <b class="warn">— занято другой программой</b>' : ''}</span></div>`).join('')}</div>` : ''}
    </div>
    <h3 class="grp">Если что-то не работает</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Отчёт для разработчика</b><span>Копирует в буфер обмена, что Lumen видит: устройства, движок, оформление Windows и последние записи журнала. Его можно вставить в чат.</span></div>
        <div class="row-btns"><button class="btn small" data-act="openlog">Открыть журнал</button><button class="btn small" data-act="copyreport">Скопировать отчёт</button></div></div>
      <div class="set"><div class="l"><b>Сообщить о проблеме</b><span>Опиши, что не работает, — Lumen соберёт архив на рабочий стол: журналы, найденные устройства и список оборудования. Личное (имя пользователя, ключ пульта, город) в архив не попадает. Этот архив можно отправить разработчику.</span></div>
        <button class="btn small primary" data-act="bugreport">Собрать отчёт</button></div>
    </div>
    ${remoteGroup(s)}
    ${updatesGroup(s)}
    <h3 class="grp">Приложение</h3>
    <div class="panel group">
      <div class="set"><div class="l"><b>Язык интерфейса</b><span>Language · Мова · Sprache · Idioma</span></div>
        <select class="field" data-set="language" aria-label="Language / Язык" style="height:34px;min-width:170px" data-noi18n><option value="auto"${s.language === 'auto' ? ' selected' : ''}>${esc(LANG_AUTO)}</option>${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${s.language === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="set"><div class="l"><b>Запускать вместе с Windows</b><span>Подсветка включится сразу после входа в систему.</span></div>${toggle('autostart', s.autostart)}</div>
      <div class="set"><div class="l"><b>Запускаться свёрнутым в трей</b><span>Работает вместе с автозапуском.</span></div>${toggle('startHidden', s.startHidden)}</div>
      <div class="set"><div class="l"><b>Закрытие окна сворачивает в трей</b><span>Подсветка продолжает работать. Выйти можно из меню значка в трее.</span></div>${toggle('closeToTray', s.closeToTray)}</div>
      <div class="set"><div class="l"><b>Показывать демо-устройства</b><span>Пока нет настоящих устройств, видно, как будет выглядеть подсветка.</span></div>${toggle('demoMode', s.demoMode)}</div>
    </div>
    <p class="note">Lumen ${esc(VERSION)}.${CONN.bundled ? ' Движок подсветки: OpenRGB, лицензия GNU GPL v2.0, <a href="#" data-act="openrgb-src" style="color:inherit">исходный код</a>.' : ''}</p>
  </div>`;
}

// ---------- Рендер ----------
function sigFor() {
  switch (page) {
    case 'home': return [page, NP ? [NP.title, NP.artist, NP.playing, (NP.cover || '').length].join('/') : '', UPD.state, UPD.version, JSON.stringify(HEALTH.conflicts || []), themeTab, S.themeId, S.effect, JSON.stringify(S.customThemes), devSig(), WIN.available, S.settings.winThemeEnabled, S.settings.winWallpaper, S.settings.winWallpaperStyle, S.settings.photoRotate, S.settings.musicColors, JSON.stringify(WIN.media || {}), JSON.stringify((S.settings.photoPicks || {})[photoKey()] || ''), S.colors.join(), PH.ver].join('|');
    case 'effects': return [page, S.effect, S.colors.length, S.direction, audio.status, audio.message, screenCap.status, screenCap.message, S.effect === 'temperature' ? (SENS.gpuTemp == null) + (SENS.message || '') : '', devSig()].join('|');
    case 'devices': return [page, devSig(), CONN.status, CONN.message, CONN.count, CONN.bundled, JSON.stringify(CONN.admin || {}), JSON.stringify(HEALTH), NATIVE.state, NATIVE.message, NATIVE.count].join('|');
    case 'scenes': return [page, JSON.stringify(S.scenarios), JSON.stringify(SCN), APPS.join(), S.customThemes.length].join('|');
    default: return [page, JSON.stringify(UPD), JSON.stringify(S.settings), JSON.stringify(REMOTE), JSON.stringify(WIN.notify || {}), PH.ver, S.colors.join(), CONN.status, CONN.message, JSON.stringify(CONN.admin || {}), DEV.length, WIN.available, WIN.state, WIN.message, JSON.stringify(WIN.wallpaper || {}), JSON.stringify(WIN.live || {}), JSON.stringify(HK)].join('|');
  }
}
function render() {
  if (!S || !CAT) return;
  const scroll = view.scrollTop;
  const openKeys = new Set($$('details[data-key][open]', view).map((el) => el.dataset.key)); // раскрытые блоки не сворачиваем
  const html = { home: pageHome, effects: pageEffects, devices: pageDevices, scenes: pageScenes, settings: pageSettings }[page]();
  view.innerHTML = html;
  $$('details[data-key]', view).forEach((el) => { if (openKeys.has(el.dataset.key)) el.open = true; });
  view.scrollTop = scroll;
  lastSig = sigFor();
  syncDynamic();
  framesDirty = true;
}
function syncDynamic() {
  if (!S) return;
  applyAccent();
  $$('.nav').forEach((b) => {
    const [label, body] = NAV[b.dataset.page];
    if (!b.firstChild) b.innerHTML = svg(body, 20) + `<span>${label}</span>`;
    b.classList.toggle('on', b.dataset.page === page);
    b.setAttribute('aria-current', b.dataset.page === page ? 'page' : 'false');
  });
  const lab = connLabel();
  $('#pill').className = 'pill ' + lab.cls;
  $('#pill-text').textContent = lab.text;
  const pw = $('.js-power');
  if (pw) { pw.classList.toggle('on', S.power); pw.setAttribute('aria-pressed', S.power); }
  const sub = $('.js-sub');
  if (sub) { const t = currentTheme(); sub.textContent = (t ? t.name + ' · ' : '') + effectName(S.effect); }
  $$('input[data-slider]').forEach((el) => {
    const k = el.dataset.slider;
    if (document.activeElement !== el || !dragging) { el.value = S[k]; el.style.setProperty('--p', S[k] + '%'); }
    $$(`output[data-out="${k}"]`).forEach((o) => { o.textContent = S[k] + '%'; });
  });
}
function refresh() {
  if (!S) return;
  if (dragging) { syncDynamic(); return; }
  if (sigFor() !== lastSig) render(); else syncDynamic();
}
function go(p) {
  page = p;
  render();
  view.scrollTop = 0;
}

// ---------- Действия ----------
function pushColors() {
  api.setState({ colors: S.colors });
}
const COLOR_POOL = ['#ff2bd6', '#00e5ff', '#ffe600', '#46e3a0', '#ff6b3d', '#7a2bff'];
const ACT = {
  power() { S.power = !S.power; syncDynamic(); api.setState({ power: S.power }); },
  theme(el) { api.applyTheme(el.dataset.id); },
  deltheme(el, e) {
    e.stopPropagation();
    const t = S.customThemes.find((x) => x.id === el.dataset.id);
    openConfirm(`Удалить тему «${t ? t.name : ''}»?`, 'Удалить', () => { api.deleteTheme(el.dataset.id); toast('Тема удалена'); });
  },
  renametheme(el) {
    const t = S.customThemes.find((x) => x.id === el.dataset.id);
    if (!t) return;
    openNameDialog({ title: 'Переименовать тему', value: t.name, okLabel: 'Сохранить название', onOk: (v) => api.renameTheme(t.id, v).then((ok) => ok && toast('Название сохранено')) });
  },
  'zone-preset'(el) { api.setZoneSize(el.dataset.dev, el.dataset.zone, Number(el.dataset.n)).then((ok) => { if (ok) toast('Количество светодиодов сохранено'); }); },
  'hide-hint'(el) { if (api.hideHint) api.hideHint(el.dataset.id); },
  media(el) { if (api.mediaControl) api.mediaControl(el.dataset.m); },
  updtheme(el) { api.updateTheme(el.dataset.id).then((ok) => ok && toast('Тема обновлена текущими настройками')); },
  tab(el) { setThemeTab(el.dataset.id); },
  async surprise() { const t = await api.surprise(); toast(`«${t.name}» — понравилось? Сохрани в «Мои»`); lastSurpriseName = t.name; },
  async sharetheme(el) { const code = await api.exportTheme(el.dataset.id); if (code) toast('Код темы скопирован — отправь его другу'); },
  importtheme() {
    openNameDialog({ title: 'Добавить тему по коду', value: '', okLabel: 'Добавить тему', placeholder: 'Вставь код, который начинается с LUMEN1-', maxlength: 2000,
      onOk: async (v) => { const r = await api.importTheme(v); if (r.ok) { toast(`Тема «${r.theme.name}» добавлена в «Мои»`); setThemeTab('mine'); } else toast(r.error); } });
  },
  resume() { api.resumeScenario(); },
  async copyreport() { await api.copyReport(); toast('Отчёт скопирован — вставь его в чат (Ctrl+V)'); },
  openlog() { api.openLog(); },
  'goto-scenes'() { go('scenes'); },
  retryscreen() { stopScreen(); startScreen(); },
  'sc-add-app'() {
    const exe = ($('#sc-exe').value || '').trim();
    if (!exe) { toast('Напиши название программы, например cs2.exe'); $('#sc-exe').focus(); return; }
    const themeId = $('#sc-theme').value;
    saveScenarios((sc) => { sc.apps = sc.apps.filter((a) => a.exe !== exe.toLowerCase()); sc.apps.push({ exe, themeId }); });
    toast('Правило добавлено');
  },
  'sc-del-app'(el) { saveScenarios((sc) => sc.apps.splice(Number(el.dataset.i), 1)); },
  'sc-add-sched'() { saveScenarios((sc) => sc.schedule.push({ from: '23:00', to: '07:00', mode: 'off', themeId: '' })); },
  'sc-del-sched'(el) { saveScenarios((sc) => sc.schedule.splice(Number(el.dataset.i), 1)); },
  async 'sc-load-apps'() { toast('Ищу открытые программы…'); APPS = await api.listApps(); refresh(); toast(APPS.length ? `Нашёл программ: ${APPS.length}` : 'Не нашёл открытых программ'); },
  effect(el) { api.setState({ effect: el.dataset.id }); },
  dir(el) { api.setState({ direction: el.dataset.id }); },
  addcolor() {
    const c = COLOR_POOL.find((x) => !S.colors.includes(x)) || '#ffffff';
    S.colors = S.colors.concat(c).slice(0, 6);
    pushColors();
    render();
  },
  rmcolor(el, e) {
    e.preventDefault(); e.stopPropagation();
    if (S.colors.length < 2) return;
    S.colors = S.colors.filter((_, i) => i !== Number(el.dataset.i));
    pushColors();
    render();
  },
  savetheme() { openSaveDialog(); },
  connect() { api.connect(); },
  disconnect() { api.disconnect(); },
  pick() { api.pickOpenRGB().then((p) => { if (p) toast('Путь сохранён'); }); },
  'openrgb-site'() { api.openExternal('https://openrgb.org'); },
  'openrgb-src'(el, e) { e.preventDefault(); api.openExternal('https://codeberg.org/OpenRGB/OpenRGB'); },
  'goto-settings'() { go('settings'); },
  'goto-devices'() { go('devices'); },
  async 'close-conflict'(el) { const r = await api.closeConflict(el.dataset.id); toast(r && r.ok ? 'Программа закрыта, перезапускаю движок…' : 'Не получилось закрыть — закрой её вручную через значок в трее'); },
  'notify-test'() { const a = NOTIFY_APPS.find((x) => S.settings.notify.apps[x.id]); api.flash(a ? a.color : S.settings.notify.otherColor); },
  'remote-newlink'() { api.newRemoteLink(); toast('Новая ссылка готова — старая больше не работает'); },
  bugreport() { openBugDialog(); },
  async 'update-check'() { const u = await api.checkUpdate(); if (u && u.state === 'latest') toast('У тебя последняя версия'); },
  async 'update-install'() { if (await api.installUpdate()) toast('Ставлю обновление… Lumen сейчас перезапустится'); },
  'restart-engine'() { api.restartEngine(); toast('Перезапускаю движок подсветки…'); },
  'forget-missing'() { api.forgetMissing(); },
  async 'photo-pick'(el) {
    const it = PH.items[Number(el.dataset.i)];
    if (!it) return;
    PH.selected = it.id; PH.ver++; refresh();
    const { src, ...item } = it;
    void src;
    if (await api.pickPhoto(item)) toast('Ставлю это фото на рабочий стол…');
  },
  'photo-more'() { if (PH.shown < PH.items.length) { PH.shown += 8; PH.ver++; refresh(); } else loadPhotos(true); },
  async 'engine-admin-on'() { const r = await api.setEngineAdmin(true); if (r && r.ok) toast('Подсветка памяти включена. Движок перезапускается, память появится через несколько секунд.'); },
  async 'engine-admin-off'() { await api.setEngineAdmin(false); toast('Движок снова работает без прав администратора'); },
  retryaudio() { stopAudio(); startAudio(); },
  rescan() { api.rescanNative(); },
  async testzone(el) {
    const r = await api.testZone(el.dataset.dev, el.dataset.zone);
    r.steps.forEach((name, i) => setTimeout(() => toast(`Сейчас должно гореть: ${name}`), i * r.stepMs));
  },
  'open-lighting'() { api.openLightingSettings(); },
  'enable-native'() { api.setSettings({ nativeEnabled: true }); },
};
view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el, e);
});
$$('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

let colorTimer = null;
view.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.slider) {
    dragging = true;
    const k = el.dataset.slider, v = Number(el.value);
    S[k] = v;
    el.style.setProperty('--p', v + '%');
    $$(`output[data-out="${k}"]`).forEach((o) => { o.textContent = v + '%'; });
    $$(`input[data-slider="${k}"]`).forEach((o) => { if (o !== el) { o.value = v; o.style.setProperty('--p', v + '%'); } });
    api.setState({ [k]: v });
  } else if (el.dataset.color !== undefined) {
    dragging = true;
    const i = Number(el.dataset.color);
    S.colors = S.colors.slice();
    S.colors[i] = el.value;
    el.parentElement.style.background = el.value;
    const bar = $('.gradbar');
    if (bar) bar.style.background = themeGradient({ effect: 'x', colors: S.colors });
    applyAccent();
    clearTimeout(colorTimer);
    colorTimer = setTimeout(pushColors, 30);
  }
});
view.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.slider || el.dataset.color !== undefined) {
    dragging = false;
    if (el.dataset.color !== undefined) pushColors();
    setTimeout(refresh, 60);
  } else if (el.dataset.remote) {
    api.setSettings({ remote: { enabled: el.checked } });
  } else if (el.dataset.notify) {
    api.setSettings({ notify: el.dataset.notify === 'mode' ? { mode: el.value } : { enabled: el.checked } });
  } else if (el.dataset.notifyApp) {
    api.setSettings({ notify: { apps: { [el.dataset.notifyApp]: el.checked } } });
  } else if (el.dataset.notifyColor !== undefined) {
    api.setSettings({ notify: { otherColor: el.value } });
  } else if (el.dataset.widgetItem) {
    api.setSettings({ widgets: { items: { [el.dataset.widgetItem]: el.checked } } });
  } else if (el.dataset.widget) {
    const k = el.dataset.widget;
    api.setSettings({ widgets: { [k]: el.type === 'checkbox' ? el.checked : el.value } });
  } else if (el.dataset.set) {
    const k = el.dataset.set;
    const val = el.type === 'checkbox' ? el.checked : el.value;
    api.setSettings({ [k]: val });
  } else if (el.dataset.scApp !== undefined) {
    saveScenarios((sc) => { sc.apps[Number(el.dataset.scApp)].themeId = el.value; });
  } else if (el.dataset.scSched) {
    const i = Number(el.dataset.i), k = el.dataset.scSched;
    saveScenarios((sc) => {
      const r = sc.schedule[i];
      if (k === 'mode') { if (el.value === 'off') r.mode = 'off'; else { r.mode = 'theme'; r.themeId = el.value.slice(6); } } else r[k] = el.value;
    });
  } else if (el.dataset.scBool) {
    saveScenarios((sc) => { sc[el.dataset.scBool] = el.checked; });
  } else if (el.dataset.scIdle !== undefined) {
    saveScenarios((sc) => { sc.idleMinutes = Number(el.value); });
  } else if (el.dataset.sizeDev) {
    api.setZoneSize(el.dataset.sizeDev, el.dataset.sizeZone, Number(el.value)).then((ok) => { if (ok) toast('Количество светодиодов сохранено'); });
  } else if (el.dataset.orderDev) {
    api.setColorOrder(el.dataset.orderDev, el.dataset.orderZone, el.value);
  } else if (el.dataset.devToggle) {
    api.setDeviceEnabled(el.dataset.devToggle, el.checked);
  }
});
window.addEventListener('pointerup', () => { if (dragging) { dragging = false; setTimeout(refresh, 80); } });

// Окно «Сохранить тему»
function openSaveDialog() {
  openNameDialog({
    title: 'Сохранить тему', value: S.themeId ? '' : lastSurpriseName, okLabel: 'Сохранить тему',
    onOk: async (v) => { await api.saveTheme(v); toast('Тема сохранена в «Мои»'); if (page === 'home') setThemeTab('mine'); },
  });
}

function openConfirm(text, okLabel, onOk) {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(text)}"><h2>${esc(text)}</h2>
    <div class="acts"><button class="btn" id="m-cancel">Отмена</button><button class="btn primary danger-fill" id="m-ok">${esc(okLabel)}</button></div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#m-cancel').onclick = close;
  $('#m-ok').onclick = () => { close(); onOk(); };
  $('#m-ok').focus();
  m.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  m.onclick = (e) => { if (e.target === m) close(); };
}

// Окно «Сообщить о проблеме»
function openBugDialog() {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `<div class="modal bug" role="dialog" aria-modal="true" aria-label="Сообщить о проблеме">
    <h2>Сообщить о проблеме</h2>
    <p class="note">Напиши своими словами: что делал, что ожидал и что получилось. Например: «Не светится оперативная память, в списке устройств её нет».</p>
    <textarea class="field" id="bug-text" rows="5" maxlength="4000" placeholder="Что не работает?"></textarea>
    <label class="chip" style="margin-top:10px"><input type="checkbox" id="bug-hw" checked> Приложить список оборудования (модели платы, памяти, USB-устройств)</label>
    <div class="acts"><button class="btn" id="m-cancel">Отмена</button><button class="btn primary" id="m-ok">Собрать архив</button></div></div>`;
  const ta = $('#bug-text');
  ta.focus();
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#m-cancel').onclick = close;
  $('#m-ok').onclick = async () => {
    const text = ta.value, hw = $('#bug-hw').checked;
    close();
    toast('Собираю отчёт… это займёт до 30 секунд');
    const r = await api.bugReport(text, hw);
    toast(r && r.ok ? 'Готово: архив лежит на рабочем столе и открыт в Проводнике' : 'Не получилось собрать отчёт: ' + ((r && r.error) || ''));
  };
  m.onclick = (e) => { if (e.target === m) close(); };
}

function openNameDialog({ title, value, okLabel, onOk, placeholder = 'Название, например «Вечер у камина»', maxlength = 24 }) {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <h2>${esc(title)}</h2>
    <input class="field" id="theme-name" maxlength="${maxlength}" placeholder="${esc(placeholder)}" aria-label="${esc(title)}">
    <div class="acts"><button class="btn" id="m-cancel">Отмена</button><button class="btn primary" id="m-ok">${esc(okLabel)}</button></div></div>`;
  const input = $('#theme-name');
  input.value = value || '';
  input.focus();
  input.select();
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  const ok = async () => { const v = input.value; close(); await onOk(v); };
  $('#m-cancel').onclick = close;
  $('#m-ok').onclick = ok;
  input.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
  m.onclick = (e) => { if (e.target === m) close(); };
}

// ---------- Звук (эффект «Музыка») ----------
const AU = { stream: null, ctx: null, an: null, data: null, timer: null, edges: null };
async function startAudio() {
  if (AU.stream || audio.status === 'starting') return;
  audio.status = 'starting'; audio.message = '';
  refresh();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    const tracks = stream.getAudioTracks();
    if (!tracks.length) throw new Error('Система не отдала звук');
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(tracks));
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.55;
    src.connect(an);
    AU.stream = stream; AU.ctx = ctx; AU.an = an; AU.data = new Uint8Array(an.frequencyBinCount);
    const nyq = ctx.sampleRate / 2, bins = an.frequencyBinCount;
    AU.edges = Array.from({ length: 17 }, (_, i) => Math.min(bins - 1, Math.round((40 * Math.pow(12000 / 40, i / 16)) / nyq * bins)));
    AU.timer = setInterval(sampleAudio, 33);
    tracks[0].addEventListener('ended', stopAudio);
    audio.status = 'on';
  } catch (e) {
    AU.stream = null;
    audio.status = 'error';
    audio.message = 'Не удалось получить звук. Проверь, что в Windows есть устройство вывода звука, и нажми «Повторить».';
  }
  refresh();
}
function stopAudio() {
  clearInterval(AU.timer);
  if (AU.stream) AU.stream.getTracks().forEach((t) => t.stop());
  if (AU.ctx) AU.ctx.close().catch(() => {});
  AU.stream = AU.ctx = AU.an = null;
  audio.bands.fill(0);
  if (audio.status !== 'error') audio.status = 'off';
  api.sendAudio(audio.bands);
  refresh();
}
function sampleAudio() {
  if (!AU.an) return;
  AU.an.getByteFrequencyData(AU.data);
  const out = new Array(16);
  for (let b = 0; b < 16; b++) {
    const a = AU.edges[b], z = Math.max(AU.edges[b + 1], a + 1);
    let sum = 0;
    for (let i = a; i < z; i++) sum += AU.data[i];
    const avg = sum / (z - a) / 255;
    out[b] = clamp((avg - 0.12) * 1.7 * (1 + b * 0.05), 0, 1);
  }
  audio.bands = out;
  api.sendAudio(out);
}
function drawMeter() {
  const bars = $$('.meter i');
  if (!bars.length) return;
  for (let i = 0; i < bars.length; i++) bars[i].style.height = Math.max(3, audio.bands[i] * 46) + 'px';
}
// ---------- Экран (эффект «Цвет экрана») ----------
const SCR = { stream: null, video: null, ctx: null, timer: null };
async function startScreen() {
  if (SCR.stream || screenCap.status === 'starting') return;
  screenCap.status = 'starting'; screenCap.message = '';
  refresh();
  try {
    const stream = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15 } }, audio: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 18;
    SCR.stream = stream; SCR.video = video; SCR.ctx = canvas.getContext('2d', { willReadFrequently: true });
    SCR.timer = setInterval(sampleScreen, 66);
    stream.getVideoTracks()[0].addEventListener('ended', stopScreen);
    screenCap.status = 'on';
  } catch (e) {
    SCR.stream = null;
    screenCap.status = 'error';
    screenCap.message = 'Не удалось получить картинку экрана. Нажми «Повторить».';
  }
  refresh();
}
function sampleScreen() {
  if (!SCR.ctx || SCR.video.readyState < 2) return;
  SCR.ctx.drawImage(SCR.video, 0, 0, 32, 18);
  const px = SCR.ctx.getImageData(0, 0, 32, 18).data;
  const data = new Array(16 * 9 * 3);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 16; x++) {
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += px[((y * 2 + dy) * 32 + x * 2 + dx) * 4 + ch];
      data[(y * 16 + x) * 3 + ch] = sum >> 2;
    }
  }
  api.sendScreen({ w: 16, h: 9, data });
}
function stopScreen() {
  clearInterval(SCR.timer);
  if (SCR.stream) SCR.stream.getTracks().forEach((t) => t.stop());
  SCR.stream = SCR.video = SCR.ctx = null;
  if (screenCap.status !== 'error') screenCap.status = 'off';
  refresh();
}

function syncAudio() {
  const fx = S ? effEffect() : '';
  const needScreen = S && S.power && fx === 'screen';
  if (needScreen && screenCap.status === 'off') startScreen();
  if (!needScreen && (SCR.stream || screenCap.status === 'error')) { screenCap.status = 'off'; stopScreen(); }
  const need = S && S.power && fx === 'music';
  if (need && audio.status === 'off') startAudio();
  if (!need && (AU.stream || audio.status === 'error')) { audio.status = 'off'; stopAudio(); }
}

// ---------- Подписки ----------
function onState(s) {
  if (dragging && S) { s.brightness = S.brightness; s.speed = S.speed; s.colors = S.colors; }
  S = s;
  syncAudio();
  refresh();
}
api.onState(onState);
api.onDevices((d) => { DEV = d; dotCache.clear(); refresh(); framesDirty = true; });
api.onConn((c) => { CONN = c; refresh(); });
if (api.onUpdate) api.onUpdate((u) => { UPD = { ...UPD, ...u }; refresh(); });
if (api.onRemote) api.onRemote((r) => { REMOTE = r || REMOTE; refresh(); });
if (api.onHealth) api.onHealth((h) => { HEALTH = h || { conflicts: [], missing: [] }; refresh(); });
if (api.onNowPlaying) api.onNowPlaying((n) => { NP = n || null; refresh(); });
api.onNative((n) => { NATIVE = n; refresh(); });
api.onWinTheme((w) => { WIN = w; refresh(); });
api.onScenario((st) => { SCN = st; syncAudio(); refresh(); });
api.onSensors((d) => {
  SENS = d;
  const t = $('.js-temp'), l = $('.js-load');
  if (t && d.gpuTemp != null) { t.textContent = `${d.gpuTemp} °C`; if (l) l.textContent = `загрузка ${d.gpuLoad ?? 0}%`; } else if (page === 'effects' && S.effect === 'temperature') refresh();
});
api.onHotkeys((h) => { HK = h; refresh(); });
api.onFrames((f) => { frames = f; framesDirty = true; });
window.addEventListener('resize', () => { framesDirty = true; });

api.init().then((init) => {
  if (init.langs) LANGS = init.langs;
  if (init.health) HEALTH = init.health;
  if (init.nowPlaying) NP = init.nowPlaying;
  if (init.remote) REMOTE = init.remote;
  if (api.updateStatus) api.updateStatus().then((u) => { if (u) { UPD = { ...UPD, ...u }; refresh(); } }).catch(() => {});
  if (init.notifyApps) NOTIFY_APPS = init.notifyApps;
  if (window.LumenDom) { window.LumenDom.set(init.lang || 'ru'); LANG_AUTO = window.LumenDom.t('Как в Windows'); }
  S = init.state; DEV = init.devices; CONN = init.conn; CAT = init.catalog; VERSION = init.version;
  NATIVE = init.native || NATIVE; WIN = init.wintheme || WIN; PLATFORM = init.platform || '';
  SCN = init.scenario || SCN; SENS = init.sensors || SENS;
  api.hotkeysInfo().then((h) => { if (h) { HK = h; refresh(); } }).catch(() => {});
  render();
  syncAudio();
  requestAnimationFrame(loop);
  // Мини-гайд: при первом запуске и по кнопке «Как пользоваться»
  const startTour = () => window.LumenTour && window.LumenTour.start({ goPage: (p) => { if (page !== p) go(p); }, done: () => { if (!S.settings.tourDone) api.setSettings({ tourDone: true }); } });
  const hb = document.getElementById('help-btn');
  if (hb) hb.onclick = startTour;
  // Поиск по разделам, темам, эффектам и настройкам (Ctrl+K / Ctrl+F)
  if (window.LumenSearch) {
    window.LumenSearch.init({
      pages: { home: [NAV.home[0], pageHome], effects: [NAV.effects[0], pageEffects], devices: [NAV.devices[0], pageDevices], scenes: [NAV.scenes[0], pageScenes], settings: [NAV.settings[0], pageSettings] },
      themes: () => allThemes().map((th) => ({ id: th.id, name: th.name, tagline: th.tagline, user: !CAT.themes.includes(th) })),
      effects: () => CAT.effects,
      go: (p) => { if (page !== p) go(p); },
      applyTheme: (id) => api.applyTheme(id),
      setEffect: (id) => api.setState({ effect: id }),
    });
    const sb = document.getElementById('search-btn');
    if (sb) sb.onclick = () => window.LumenSearch.open();
  }
  if (!S.settings.tourDone && !document.hidden) setTimeout(startTour, 700);
  else if (!S.settings.tourDone) document.addEventListener('visibilitychange', function once() { if (!document.hidden) { document.removeEventListener('visibilitychange', once); setTimeout(startTour, 500); } });
});
})();
