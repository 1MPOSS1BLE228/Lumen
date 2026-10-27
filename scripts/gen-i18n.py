import json, sys
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
langs = ['en', 'uk', 'de', 'es']
d = {l: {} for l in langs}
for r in rows:
    for i, l in enumerate(langs):
        d[l][r[0]] = r[i + 1]
js = """'use strict';
// Переводы интерфейса Lumen. Ключ — русская фраза (как в коде), значение — перевод.
// Файл собирается из src/shared/i18n/table.tsv (русский, English, Українська, Deutsch, Español).
// Перевод работает так: точное совпадение фразы, а если фраза составная (с числами, именами) —
// по кусочкам, целыми словами. Чтобы добавить язык, добавь колонку в table.tsv и запусти сборку словаря.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LumenI18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LANGS = { ru: 'Русский', en: 'English', uk: 'Українська', de: 'Deutsch', es: 'Español' };
  const DICT = %s;

  // Язык Windows -> язык Lumen (незнакомые языки — английский)
  function resolve(pref, locale) {
    if (pref && LANGS[pref]) return pref;
    if (!locale) return 'ru';
    const l = String(locale || '').toLowerCase().slice(0, 2);
    if (l === 'ru' || l === 'be' || l === 'kk') return 'ru';
    return LANGS[l] ? l : 'en';
  }

  function makeTranslator(lang, dict) {
    const map = dict || DICT[lang] || null;
    const cache = new Map();
    if (!map) return { lang: 'ru', t: (s) => s, map: null };
    // очень короткие слова («с», «до») переводим только целиком — иначе испортим чужие фразы
    const EXACT_ONLY = new Set(['с', 'до', 'нет', 'тема']);
    const keys = Object.keys(map).filter((k) => !EXACT_ONLY.has(k)).sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
    // кусочки — только целыми словами (по краям не кириллица)
    const re = new RegExp('(?<![А-Яа-яЁё])(?:' + keys.map(esc).join('|') + ')(?![А-Яа-яЁё])', 'g');
    const cyr = /[А-Яа-яЁё]/;
    function t(s) {
      if (s == null) return s;
      const str = String(s);
      if (!cyr.test(str)) return str;
      if (cache.has(str)) return cache.get(str);
      const lead = str.match(/^\\s*/)[0], trail = str.match(/\\s*$/)[0];
      const core = str.trim();
      let out = map[core];
      if (out === undefined) out = core.replace(re, (m) => map[m]);
      // кавычки, привычные для языка
      if (lang === 'en') out = out.replace(/«([^«»]*)»/g, '“$1”');
      else if (lang === 'de') out = out.replace(/«([^«»]*)»/g, '„$1“');
      out = lead + out + trail;
      if (cache.size > 5000) cache.clear();
      cache.set(str, out);
      return out;
    }
    return { lang, t, map };
  }

  return { LANGS, DICT, resolve, makeTranslator };
});
""" % json.dumps(d, ensure_ascii=False, indent=0)
open(sys.argv[2], 'w', encoding='utf-8').write(js)
print('ok', len(rows))
