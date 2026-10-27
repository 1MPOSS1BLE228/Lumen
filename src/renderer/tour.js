'use strict';
// Мини-гайд для новичков: пошагово подсвечивает кнопки и разделы и коротко объясняет, что они делают.
// Показывается при первом запуске, потом — по кнопке «Как пользоваться» внизу слева.
(() => {
  const STEPS = [
    { title: 'Привет! Это Lumen', text: 'Одна программа для всей подсветки компьютера: плата, видеокарта, память, вентиляторы, клавиатура и мышь. Покажу главное за минуту.', target: null },
    { page: 'home', target: '.js-power', title: 'Включить и выключить', text: 'Главная кнопка: гасит и зажигает всю подсветку разом. С клавиатуры — Ctrl+Alt+L, работает даже в игре.' },
    { page: 'home', target: '.themes', title: 'Темы', text: 'Нажми на любую тему — сменятся подсветка, цвет Windows и обои. Свои темы появятся во вкладке «Мои».' },
    { page: 'home', target: '.controls', title: 'Яркость и скорость', text: 'Двигай ползунки — подсветка меняется сразу. Здесь же включаются обои и цвет Windows под тему.' },
    { page: 'home', target: '.btn.surprise', title: 'Удиви меня', text: 'Не знаешь, что выбрать? Lumen придумает случайную красивую тему. Понравится — сохрани её.' },
    { page: 'home', target: '.nav[data-page="effects"]', title: 'Эффекты', text: 'Собери свою подсветку: волна, дыхание, огонь, реакция на музыку, цвет экрана. Выбери цвета и направление.' },
    { page: 'home', target: '.nav[data-page="devices"]', title: 'Устройства', text: 'Что нашёл Lumen. Здесь включается подсветка оперативной памяти и настраиваются вентиляторы на разъёмах платы.' },
    { page: 'home', target: '.nav[data-page="scenes"]', title: 'Сценарии', text: 'Подсветка меняется сама: запустил игру — включилась игровая тема, ночью — выключилась, отошёл — погасла.' },
    { page: 'home', target: '.nav[data-page="settings"]', title: 'Настройки', text: 'Обои, виджеты на рабочем столе, пульт на телефоне, подсветка от уведомлений, язык. И кнопка «Собрать отчёт», если что-то не работает.' },
    { page: 'home', target: '#help-btn', title: 'Готово!', text: 'Lumen живёт в трее возле часов: закрытие окна его не выключает. Этот гайд всегда можно открыть снова здесь.' },
  ];

  let i = 0, box = null, onDone = null, go = null;

  function place() {
    if (!box) return;
    const st = STEPS[i];
    const card = box.querySelector('.tour-card');
    const hole = box.querySelector('.tour-hole');
    const el = st.target ? document.querySelector(st.target) : null;
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = el ? el.getBoundingClientRect() : null;
    if (r && r.width) {
      const pad = 8;
      Object.assign(hole.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
      // карточку — рядом с подсвеченным местом, где больше свободного места
      const cw = card.offsetWidth, ch = card.offsetHeight, W = innerWidth, H = innerHeight;
      let left = r.right + 18, top = r.top;
      if (left + cw > W - 12) left = Math.max(12, r.left - cw - 18);
      if (left < 12 || (r.width > W * 0.5)) { left = Math.min(Math.max(12, r.left), W - cw - 12); top = r.bottom + 18; if (top + ch > H - 12) top = Math.max(12, r.top - ch - 18); }
      Object.assign(card.style, { left: left + 'px', top: Math.min(Math.max(12, top), H - ch - 12) + 'px', transform: 'none' });
    } else {
      hole.style.display = 'none';
      Object.assign(card.style, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' });
    }
  }

  function render() {
    const st = STEPS[i];
    if (st.page && go) go(st.page);
    box.querySelector('.tour-card').innerHTML = `
      <div class="tour-n">${i + 1} / ${STEPS.length}</div>
      <h3>${st.title}</h3><p>${st.text}</p>
      <div class="tour-acts"><button class="btn small tour-skip">${i === STEPS.length - 1 ? '' : 'Пропустить'}</button>
        <div>${i ? '<button class="btn small tour-back">Назад</button>' : ''}<button class="btn small primary tour-next">${i === STEPS.length - 1 ? 'Понятно' : 'Далее'}</button></div></div>`;
    const skip = box.querySelector('.tour-skip');
    if (i === STEPS.length - 1) skip.style.visibility = 'hidden';
    skip.onclick = end;
    box.querySelector('.tour-next').onclick = () => { if (i < STEPS.length - 1) { i++; render(); } else end(); };
    const back = box.querySelector('.tour-back');
    if (back) back.onclick = () => { i--; render(); };
    box.querySelector('.tour-next').focus();
    setTimeout(place, 60);
  }

  function end() {
    if (!box) return;
    box.remove();
    box = null;
    removeEventListener('resize', place);
    if (onDone) onDone();
  }

  // goPage(page) — переключить раздел приложения; done() — гайд закрыт
  window.LumenTour = {
    start({ goPage, done } = {}) {
      if (box) return;
      go = goPage; onDone = done; i = 0;
      box = document.createElement('div');
      box.className = 'tour';
      box.innerHTML = '<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-modal="true" aria-label="Как пользоваться Lumen"></div>';
      document.body.appendChild(box);
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') end(); if (e.key === 'ArrowRight') box.querySelector('.tour-next').click(); if (e.key === 'ArrowLeft' && i) { i--; render(); } });
      addEventListener('resize', place);
      render();
    },
    get active() { return !!box; },
  };
})();
