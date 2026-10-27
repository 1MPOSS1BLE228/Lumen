'use strict';
// Перевод интерфейса «на лету»: всё, что появляется в окне (текст, подсказки, placeholder),
// переводится словарём из shared/i18n.js. Для русского ничего не делаем.
(() => {
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'svg']);
  let tr = null;
  let obs = null;

  const skip = (el) => !el || SKIP.has(el.nodeName) || (el.closest && el.closest('[data-noi18n]'));

  function text(n) {
    if (!tr || skip(n.parentNode)) return;
    const v = n.nodeValue;
    const t = tr.t(v);
    if (t !== v) n.nodeValue = t;
  }
  function attrs(el) {
    if (!tr || skip(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const t = tr.t(v); if (t !== v) el.setAttribute(a, t); }
    }
    if (el.nodeName === 'INPUT' && el.readOnly && el.value) { const t = tr.t(el.value); if (t !== el.value) el.value = t; }
  }
  function walk(root) {
    if (!tr || !root) return;
    if (root.nodeType === 3) { text(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    attrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) text(n); else attrs(n); }
  }

  window.LumenDom = {
    lang: 'ru',
    set(lang) {
      this.lang = lang;
      if (obs) { obs.disconnect(); obs = null; }
      tr = lang && lang !== 'ru' && window.LumenI18n ? window.LumenI18n.makeTranslator(lang) : null;
      document.documentElement.lang = lang || 'ru';
      if (!tr) return;
      document.title = tr.t(document.title);
      walk(document.body);
      obs = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'characterData') text(r.target);
          else if (r.type === 'attributes') attrs(r.target);
          else for (const n of r.addedNodes) walk(n);
        }
      });
      obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    },
    t(s) { return tr ? tr.t(s) : s; },
    locale() { return { ru: 'ru-RU', en: 'en-GB', uk: 'uk-UA', de: 'de-DE', es: 'es-ES' }[this.lang] || 'ru-RU'; },
  };
})();
