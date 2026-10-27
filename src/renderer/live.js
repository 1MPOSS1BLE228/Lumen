'use strict';
// Живые обои «Волны». Экономный способ: каждый слой холмов (с тенью и светлым краем) рисуется
// ОДИН раз в отдельную картинку при смене темы, а анимация лишь сдвигает готовые картинки.
// Форма волн повторяется ровно через ширину экрана, поэтому картинка бесшовно «прокручивается».
// Кадр — это 13 копирований готовых картинок, без размытия и расчёта кривых — видеокарта почти не нагружается.
(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { alpha: false });
  const RAINBOW = ['#ff2a2a', '#ffb000', '#9dff00', '#00e5a0', '#00a2ff', '#8b3dff', '#ff2bd6'];
  const L = 6;
  const FPS = 30;
  const MAX_W = 2560; // внутреннее разрешение не больше 2560 по ширине: волны плавные, разницы не видно
  const MORPH_MS = 1500;

  const hexRgb = (h) => { const n = parseInt(String(h).slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  }
  function palAt(pal, p) {
    if (pal.length === 1) return pal[0];
    const f = Math.min(1, Math.max(0, p)) * (pal.length - 1);
    const i = Math.min(Math.floor(f), pal.length - 2);
    const t = f - i;
    return mix(pal[i], pal[i + 1], t * t * (3 - 2 * t));
  }

  // Параметры волн в долях экрана; число «горбов» целое — тогда форма повторяется через ширину экрана
  function model(theme) {
    let pal = (theme.effect === 'rainbow' ? RAINBOW : theme.colors && theme.colors.length ? theme.colors : ['#8b5cff']).slice(0, 6).map(hexRgb);
    if (pal.length === 1) pal = [pal[0], pal[0].map((v) => v * 0.55)];
    const rnd = seeded('waves' + pal.map((c) => c.join()).join('|'));
    const layers = [];
    for (let k = 0; k < L; k++) {
      layers.push({
        base: 0.26 + 0.12 * k + (rnd() - 0.5) * 0.03,
        a1: 0.05 + rnd() * 0.04, n1: Math.max(1, Math.round(0.6 + rnd() * 0.9)), p1: rnd() * 6.28,
        a2: 0.015 + rnd() * 0.02, n2: Math.round(2 + rnd() * 2.5), p2: rnd() * 6.28,
        color: scale(palAt(pal, k / (L - 1)), 0.95 - 0.13 * k),
      });
    }
    return {
      layers,
      top: mix([6, 6, 11], pal[0], 0.06),
      bot: mix([4, 4, 8], pal[pal.length - 1], 0.1),
      glow: palAt(pal, 0.2),
      speed: 0.45 + Math.min(100, Math.max(1, Number(theme.speed) || 50)) / 100,
    };
  }

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };

  // Готовые картинки для темы при текущем размере
  function build(m, W, H) {
    const bg = mk(W, H);
    const g = bg.getContext('2d', { alpha: false });
    const lin = g.createLinearGradient(0, 0, 0, H);
    lin.addColorStop(0, css(m.top));
    lin.addColorStop(1, css(m.bot));
    g.fillStyle = lin;
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W * 0.5, H * 0.28);
    g.scale(W * 0.6, H * 0.35);
    const gl = g.createRadialGradient(0, 0, 0, 0, 0, 2);
    gl.addColorStop(0, css(m.glow, 0.18));
    gl.addColorStop(0.25, css(m.glow, 0.18 * 0.78));
    gl.addColorStop(0.5, css(m.glow, 0.18 * 0.37));
    gl.addColorStop(0.75, css(m.glow, 0.18 * 0.105));
    gl.addColorStop(1, css(m.glow, 0));
    g.fillStyle = gl;
    g.fillRect(-2, -2, 4, 4);
    g.restore();
    // зерно против полос на тёмных переходах — один раз
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    let s = 12345;
    for (let i = 0; i < d.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = ((s >> 16) & 3) - 1.5;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);

    const pad = Math.ceil(H * 0.05); // запас по краям под тень, чтобы на стыке не было шва
    const bob = Math.ceil(H * 0.008);
    const layers = m.layers.map((ly) => {
      const a1 = ly.a1 * H, a2 = ly.a2 * H, base = ly.base * H;
      const top = Math.max(0, Math.floor(base - a1 - a2 - pad - bob));
      const h = H - top + bob;
      const c = mk(W + pad * 2, h);
      const x = c.getContext('2d');
      const edge = (px) => base - top + a1 * Math.sin((px / W) * Math.PI * 2 * ly.n1 + ly.p1) + a2 * Math.sin((px / W) * Math.PI * 2 * ly.n2 + ly.p2);
      const step = Math.max(3, Math.round(W / 640));
      const path = new Path2D();
      path.moveTo(0, edge(-pad));
      for (let px = step; px <= W + pad * 2; px += step) path.lineTo(px, edge(px - pad));
      const rim = new Path2D(path);
      path.lineTo(W + pad * 2, h);
      path.lineTo(0, h);
      path.closePath();
      const t0 = base - top - a1 - a2;
      const fill = x.createLinearGradient(0, t0, 0, t0 + H * 0.3 + a1 * 2);
      fill.addColorStop(0, css(ly.color));
      fill.addColorStop(1, css(scale(ly.color, 0.55)));
      x.save();
      x.shadowColor = 'rgba(0,0,0,0.42)';
      x.shadowBlur = H * 0.028;
      x.shadowOffsetY = -H * 0.004;
      x.fillStyle = fill;
      x.fill(path);
      x.restore();
      x.lineJoin = 'round';
      x.strokeStyle = 'rgba(255,255,255,0.07)';
      x.lineWidth = Math.max(3, H / 240);
      x.stroke(rim);
      x.strokeStyle = css(mix(ly.color, [255, 255, 255], 0.55), 0.55);
      x.lineWidth = Math.max(1.2, H / 900);
      x.stroke(rim);
      return { c, top, pad, h };
    });
    return { bg, layers, W, H, speed: m.speed };
  }

  let theme = { colors: ['#8b5cff', '#00e5ff'] };
  let cur = null; // готовые картинки
  let prev = null; // прошлая тема (для плавной смены)
  let morphStart = 0;
  let frameBuf = null; // для плавной смены: сюда рисуется новая тема
  let paused = false;
  let clock = 0;
  let last = 0;
  let lastDraw = 0;

  function size() {
    const dpr = window.devicePixelRatio || 1;
    let w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (w > MAX_W) { h = Math.round(h * MAX_W / w); w = MAX_W; }
    return [Math.max(64, w), Math.max(64, h)];
  }

  function rebuild(keepPrev) {
    const [W, H] = size();
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; keepPrev = false; }
    prev = keepPrev && cur ? cur : null;
    cur = build(model(theme), W, H);
    morphStart = performance.now();
    frameBuf = prev ? mk(W, H) : null;
  }

  function paint(g, set) {
    const { W, H } = set;
    g.drawImage(set.bg, 0, 0);
    for (let k = 0; k < set.layers.length; k++) {
      const ly = set.layers[k];
      const dir = k % 2 ? -1 : 1;
      // каждый слой плывёт со своей скоростью — объём, как в параллаксе
      let off = (clock * W * (0.006 + 0.003 * k) * dir) % W;
      if (off < 0) off += W;
      const y = ly.top + Math.sin(clock * 0.25 + k * 1.7) * H * 0.006;
      // кусок [pad, pad+W) картинки повторяется через W
      g.drawImage(ly.c, ly.pad, 0, W, ly.h, -off, y, W, ly.h);
      g.drawImage(ly.c, ly.pad, 0, W, ly.h, W - off, y, W, ly.h);
    }
  }

  function draw(now) {
    if (!cur) return;
    if (prev) {
      const t = Math.min(1, (now - morphStart) / MORPH_MS);
      if (t >= 1) { prev = null; frameBuf = null; paint(ctx, cur); return; }
      paint(ctx, prev);
      const fb = frameBuf.getContext('2d', { alpha: false });
      paint(fb, cur);
      ctx.save();
      ctx.globalAlpha = t * t * (3 - 2 * t);
      ctx.drawImage(frameBuf, 0, 0);
      ctx.restore();
      return;
    }
    paint(ctx, cur);
  }

  // --- Режим: волны или картинка обоев --------------------------------------
  let mode = { waves: true, widgets: null };
  let bmp = null; // картинка обоев (режим без волн)
  let looping = false;

  function drawImage() {
    const [W, H] = size();
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.fillStyle = '#06060b';
    ctx.fillRect(0, 0, W, H);
    if (!bmp) return;
    const k = Math.max(W / bmp.width, H / bmp.height); // «заполнение», как у Windows
    const w = bmp.width * k, h = bmp.height * k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  }

  function frame(now) {
    if (paused || !mode.waves) { last = 0; looping = false; return; }
    requestAnimationFrame(frame);
    if (now - lastDraw < 1000 / FPS - 2) return;
    if (last) clock += Math.min(0.1, (now - last) / 1000) * (cur ? cur.speed : 1);
    last = now;
    lastDraw = now;
    draw(now);
  }

  function loop() { if (!looping && mode.waves && !paused) { looping = true; requestAnimationFrame(frame); } }

  // --- Виджеты ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let wdata = {};
  let clockTimer = null;

  function tickClock() {
    clearTimeout(clockTimer);
    if (!mode.widgets || !mode.widgets.clock || paused) return;
    const d = new Date();
    const sec = !!mode.widgets.seconds;
    $('ct').textContent = d.toLocaleTimeString(loc(), sec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    $('cd').textContent = d.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });
    // следующее обновление — ровно в начале следующей минуты (или секунды, если включены секунды)
    clockTimer = setTimeout(tickClock, sec ? 1000 - d.getMilliseconds() + 20 : 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
  }

  const ICONS = {
    sun: '<circle cx="24" cy="24" r="9" fill="#ffd34d"/><g stroke="#ffd34d" stroke-width="3" stroke-linecap="round"><path d="M24 5v5M24 38v5M5 24h5M38 24h5M10.6 10.6l3.5 3.5M33.9 33.9l3.5 3.5M10.6 37.4l3.5-3.5M33.9 14.1l3.5-3.5"/></g>',
    moon: '<path d="M30 8a16 16 0 1 0 10 26A13 13 0 0 1 30 8z" fill="#e8e6ff"/>',
    cloud: '<path d="M15 36h20a8 8 0 0 0 0-16 11 11 0 0 0-21 3 6.5 6.5 0 0 0 1 13z" fill="#dfe6f2"/>',
    'cloud-sun': '<circle cx="17" cy="17" r="7" fill="#ffd34d"/><path d="M17 38h18a7.5 7.5 0 0 0 0-15 10 10 0 0 0-19 3 6 6 0 0 0 1 12z" fill="#e6ecf5"/>',
    fog: '<path d="M14 30h20a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0-1 11z" fill="#cfd6e2"/><g stroke="#cfd6e2" stroke-width="3" stroke-linecap="round"><path d="M10 36h28M14 42h20"/></g>',
    drizzle: '<path d="M14 28h20a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0-1 11z" fill="#cfd8e6"/><g stroke="#6cc4ff" stroke-width="2.5" stroke-linecap="round"><path d="M18 34v3M26 34v3M34 34v3"/></g>',
    rain: '<path d="M14 26h20a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0-1 11z" fill="#c4cfe0"/><g stroke="#4fb3ff" stroke-width="3" stroke-linecap="round"><path d="M17 32l-2 6M25 32l-2 6M33 32l-2 6"/></g>',
    snow: '<path d="M14 26h20a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0-1 11z" fill="#dfe6f2"/><g fill="#fff"><circle cx="17" cy="35" r="2.2"/><circle cx="25" cy="39" r="2.2"/><circle cx="33" cy="35" r="2.2"/></g>',
    storm: '<path d="M14 26h20a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0-1 11z" fill="#b9c3d6"/><path d="M25 27l-6 9h5l-3 8 9-11h-5l3-6z" fill="#ffd34d"/>',
  };
  const sign = (t) => (t > 0 ? '+' + t : String(t));

  const fmtSpeed = (b) => (b == null ? '—' : b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' МБ/с' : b >= 1024 ? Math.round(b / 1024) + ' КБ/с' : b + ' Б/с');
  const fmtUp = (s) => { if (s == null) return '—'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`; };
  const loc = () => (window.LumenDom ? window.LumenDom.locale() : 'ru-RU');
  const dayName = (iso) => new Date(iso + 'T12:00').toLocaleDateString(loc(), { weekday: 'short' }).replace('.', '');

  function renderWidgets() {
    const W = mode.widgets;
    const box = $('w');
    if (!W) { box.className = ''; return; }
    box.className = 'on ' + (['tr', 'tl', 'br', 'bl'].includes(W.corner) ? W.corner : 'tr') + ' sz-' + (['s', 'm', 'l'].includes(W.size) ? W.size : 'm');
    $('wc').style.display = W.clock ? '' : 'none';
    $('wc').classList.toggle('sec', !!W.seconds);
    $('ww').style.display = W.weather ? '' : 'none';
    $('ws').style.display = W.system ? '' : 'none';
    if (W.weather) {
      const w = wdata.weather;
      const el = $('ww');
      if (!w) { el.className = 'card wx err'; el.textContent = 'Погода загружается…'; }
      else if (w.error) { el.className = 'card wx err'; el.textContent = w.error; }
      else {
        el.className = 'card wx';
        const extra = [w.humidity != null ? `влажность ${esc(w.humidity)}%` : '', w.rain ? `дождь ${esc(w.rain)}%` : '', `ветер ${esc(w.wind)} м/с`].filter(Boolean).join(' · ');
        const days = W.forecast && w.days && w.days.length ? `<div class="fc">${w.days.map((d) => `<div><span>${esc(dayName(d.date))}</span><svg viewBox="0 0 48 48">${ICONS[d.icon] || ICONS.cloud}</svg><b>${esc(sign(d.max))}°</b><i>${esc(sign(d.min))}°</i></div>`).join('')}</div>` : '';
        el.innerHTML = `<div class="now"><svg viewBox="0 0 48 48">${ICONS[w.icon] || ICONS.cloud}</svg><div><div class="tp">${esc(sign(w.temp))}°</div>
          <div class="tx">${esc(w.text)}${w.feels !== w.temp ? `, ощущается ${esc(sign(w.feels))}°` : ''}</div>
          <div class="mt">${esc(w.city)}${w.max != null ? ` · ↑${esc(sign(w.max))}° ↓${esc(sign(w.min))}°` : ''}</div>
          <div class="mt">${extra}</div></div></div>${days}`;
      }
    }
    if (W.system) {
      const it = W.items || {};
      const row = (label, pct, val, hot) => `<div class="r${hot ? ' hot' : ''}"><span class="l">${label}</span>${pct === false ? '<span></span>' : `<div class="bar"><i style="width:${pct == null ? 0 : Math.max(2, Math.min(100, pct))}%"></i></div>`}<span class="v">${val}</span></div>`;
      const d = wdata;
      let h = '';
      if (it.cpu !== false) h += row('Процессор', d.cpu, d.cpu == null ? '—' : d.cpu + '%', d.cpu > 85);
      if (it.ram !== false) h += row('Память', d.ram, d.ramUsed == null ? '—' : `${d.ramUsed} / ${d.ramTotal} ГБ`, d.ram > 90);
      if (it.gpu !== false && d.gpu != null) h += row('Видеокарта', d.gpu, [d.gpu + '%', d.gpuTemp != null ? d.gpuTemp + ' °C' : '', d.gpuPower != null ? d.gpuPower + ' Вт' : ''].filter(Boolean).join(' · '), d.gpu > 95 || d.gpuTemp >= 80);
      if (it.vram && d.vramUsed != null) h += row('Видеопамять', d.vramTotal ? (100 * d.vramUsed) / d.vramTotal : null, `${d.vramUsed} / ${d.vramTotal} ГБ`, d.vramTotal && d.vramUsed / d.vramTotal > 0.92);
      if (it.net && (d.down != null || d.up != null)) h += row('Сеть', false, `↓ ${fmtSpeed(d.down)} &nbsp;↑ ${fmtSpeed(d.up)}`);
      if (it.disk && d.diskFree != null) h += row('Диск C:', d.diskTotal ? 100 * (1 - d.diskFree / d.diskTotal) : null, `свободно ${d.diskFree} ГБ`, d.diskTotal && d.diskFree / d.diskTotal < 0.08);
      if (it.uptime && d.uptime != null) h += row('Включён', false, fmtUp(d.uptime));
      $('ws').innerHTML = h || '<span class="l">Выбери, что показывать, в настройках Lumen</span>';
    }
  }

  function setAccent() {
    const c = theme.effect === 'rainbow' ? ['#ff2a2a', '#8b3dff'] : (theme.colors && theme.colors.length ? theme.colors : ['#8b5cff']);
    document.documentElement.style.setProperty('--a', c[0]);
    document.documentElement.style.setProperty('--b', c[1] || c[0]);
  }

  if (window.live) {
    window.live.onTheme((t) => {
      theme = t || {};
      setAccent();
      if (!mode.waves) return; // в режиме картинки волны не нужны
      rebuild(true);
      if (paused) { prev = null; draw(performance.now()); }
    });
    window.live.onPause((p) => {
      paused = !!p;
      if (!paused) { loop(); tickClock(); } else clearTimeout(clockTimer);
    });
    window.live.onMode((m) => {
      const was = mode.waves;
      mode = { waves: !!(m && m.waves), widgets: (m && m.widgets) || null };
      document.body.classList.toggle('anim', mode.waves);
      if (mode.waves) { if (!was || !cur) rebuild(false); loop(); }
      else { cur = prev = frameBuf = null; drawImage(); } // картинки волн больше не держим в памяти
      renderWidgets();
      tickClock();
    });
    window.live.onImage(async (buf) => {
      try {
        const b = await createImageBitmap(new Blob([buf]));
        if (bmp) bmp.close();
        bmp = b;
        if (!mode.waves) drawImage();
      } catch (_) { /* не картинка */ }
    });
    window.live.onData((d) => { wdata = d || {}; renderWidgets(); });
    if (window.live.onLang) window.live.onLang((l) => { if (window.LumenDom) window.LumenDom.set(l); renderWidgets(); tickClock(); });
  }
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (mode.waves) { rebuild(false); draw(performance.now()); } else drawImage(); }, 300); });
  rebuild(false);
  setAccent();
  loop();
})();
