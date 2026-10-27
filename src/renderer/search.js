'use strict';
// Поиск по Lumen: разделы, темы, эффекты и любые настройки. Ctrl+K или Ctrl+F, или кнопка «Поиск».
// Настройки не перечислены вручную: каждый раздел «рисуется» в памяти, и из него берутся
// заголовки групп и названия пунктов — так поиск сам знает о новых настройках.
(() => {
  // ctx: { pages: {id: [имя, () => html]}, themes, effects, go(page), applyTheme(id), setEffect(id) }
  let ctx = null, box = null, items = [], shown = [], sel = 0;
  const t = (s) => (window.LumenDom && window.LumenDom.t ? window.LumenDom.t(s) : s);
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function build() {
    const list = [];
    for (const [id, [name]] of Object.entries(ctx.pages)) list.push({ kind: 'Раздел', title: name, page: id });
    for (const th of ctx.themes()) list.push({ kind: 'Тема', title: th.name, sub: th.tagline || '', theme: th.id, user: !!th.user });
    for (const [id, e] of Object.entries(ctx.effects())) list.push({ kind: 'Эффект', title: e.name, sub: e.desc || '', effect: id });
    // пункты настроек и других разделов
    const tmp = document.createElement('div');
    for (const [id, [name, html]] of Object.entries(ctx.pages)) {
      let h = '';
      try { h = html(); } catch (_) { continue; }
      tmp.innerHTML = h;
      let group = '';
      tmp.querySelectorAll('h3.grp, .set .l > b, details > summary, .panel h3, .banner .txt > b').forEach((el) => {
        if (el.matches('h3.grp')) { group = clean(el); list.push({ kind: name, title: group, page: id, find: group }); return; }
        const title = clean(el);
        if (!title || title.length > 90) return;
        const descEl = el.parentElement && el.parentElement.querySelector(':scope > span');
        list.push({ kind: name, title, sub: [group, clean(descEl)].filter(Boolean).join(' · '), page: id, find: title });
      });
    }
    // повторы (одна и та же надпись в разных местах) убираем
    const seen = new Set();
    items = list.filter((x) => { const k = x.kind + '|' + x.title + '|' + (x.page || ''); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const x of items) x.hay = norm([x.title, x.sub, t(x.title), t(x.sub || ''), x.kind, t(x.kind)].join(' '));
  }

  function search(q) {
    q = norm(q);
    if (!q) return items.filter((x) => x.kind === 'Раздел' || x.theme).slice(0, 12);
    const words = q.split(' ');
    const scored = [];
    for (const x of items) {
      if (!words.every((w) => x.hay.includes(w))) continue;
      const title = norm(t(x.title)) + ' ' + norm(x.title);
      let s = 0;
      if (title.startsWith(q) || norm(x.title).startsWith(q)) s += 10;
      if (title.includes(q)) s += 5;
      if (x.kind === 'Раздел') s += 3;
      if (x.theme || x.effect) s += 1;
      scored.push([s, x]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 30).map((p) => p[1]);
  }

  function draw() {
    const q = box.querySelector('input').value;
    shown = search(q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const ul = box.querySelector('.sr');
    ul.innerHTML = shown.length ? shown.map((x, i) => `<li class="${i === sel ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">
        <span class="k">${escH(x.kind)}</span><b>${escH(x.title)}</b>${x.sub ? `<i>${escH(x.sub)}</i>` : ''}</li>`).join('')
      : '<li class="none">Ничего не нашлось. Попробуй другое слово.</li>';
    const on = ul.querySelector('li.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function pick(x) {
    close();
    if (!x) return;
    if (x.theme) { ctx.go('home'); ctx.applyTheme(x.theme); return; }
    if (x.effect) { ctx.go('effects'); ctx.setEffect(x.effect); return; }
    ctx.go(x.page);
    if (!x.find) return;
    // подсветить найденный пункт (текст на экране уже может быть переведён)
    setTimeout(() => {
      const want = [norm(x.find), norm(t(x.find))];
      const els = [...document.querySelectorAll('#view h3.grp, #view .set .l > b, #view details > summary, #view .panel h3, #view .banner .txt > b')];
      const el = els.find((e) => want.includes(norm(e.textContent))) || els.find((e) => want.some((w) => norm(e.textContent).startsWith(w)));
      if (!el) return;
      const det = el.closest('details');
      if (det) det.open = true;
      const row = el.closest('.set, .panel, details') || el;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('found'); void row.offsetWidth; row.classList.add('found');
      setTimeout(() => row.classList.remove('found'), 2200);
    }, 80);
  }

  function open() {
    if (!ctx || box) return;
    build();
    box = document.createElement('div');
    box.className = 'search-back';
    box.innerHTML = `<div class="search" role="dialog" aria-modal="true" aria-label="Поиск">
      <div class="sbar"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
      <input type="search" placeholder="Что найти? Например: обои, яркость, Лава" aria-label="Что найти" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <ul class="sr" role="listbox"></ul></div>`;
    document.body.appendChild(box);
    const input = box.querySelector('input');
    input.placeholder = t(input.placeholder);
    input.oninput = () => { sel = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { pick(shown[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); }
    };
    box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
    box.querySelector('.sr').addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(shown[Number(li.dataset.i)]); });
    draw();
    input.focus();
  }

  function close() { if (box) { box.remove(); box = null; } }

  window.LumenSearch = {
    init(c) {
      ctx = c;
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyK' || e.code === 'KeyF')) { e.preventDefault(); if (box) close(); else open(); }
      });
    },
    open, close,
    get active() { return !!box; },
    _items: () => items, _search: search, _build: build,
  };
})();
