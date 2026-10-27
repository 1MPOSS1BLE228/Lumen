'use strict';
// Сценарии: что должно происходить с подсветкой прямо сейчас.
// Приоритет: блокировка → простой → запущенная программа → расписание.

const DEFAULT_SCENARIOS = {
  apps: [],          // [{ exe: 'cs2.exe', themeId: 'gamer' }]
  schedule: [],      // [{ from: '23:00', to: '07:00', mode: 'off' | 'theme', themeId }]
  offOnLock: false,  // гасить, когда компьютер заблокирован
  idleMinutes: 0,    // гасить после N минут без действий (0 — никогда)
  offOnSleep: true,  // гасить при уходе в сон
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t) => { const m = TIME_RE.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function normalizeExe(s) {
  let e = String(s || '').trim().toLowerCase().replace(/^.*[\\/]/, '');
  if (!e) return '';
  if (!e.endsWith('.exe')) e += '.exe';
  return /^[\w .()+\-[\]]{1,80}\.exe$/.test(e) ? e : '';
}

function sanitizeScenarios(raw, themeExists) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_SCENARIOS };
  out.apps = (Array.isArray(r.apps) ? r.apps : [])
    .map((a) => ({ exe: normalizeExe(a && a.exe), themeId: String((a && a.themeId) || '') }))
    .filter((a) => a.exe && themeExists(a.themeId))
    .slice(0, 30);
  out.schedule = (Array.isArray(r.schedule) ? r.schedule : [])
    .map((s) => ({ from: String((s && s.from) || ''), to: String((s && s.to) || ''), mode: s && s.mode === 'theme' ? 'theme' : 'off', themeId: String((s && s.themeId) || '') }))
    .filter((s) => toMin(s.from) != null && toMin(s.to) != null && s.from !== s.to && (s.mode === 'off' || themeExists(s.themeId)))
    .slice(0, 10);
  out.offOnLock = !!r.offOnLock;
  out.idleMinutes = Math.max(0, Math.min(240, Math.round(Number(r.idleMinutes)) || 0));
  out.offOnSleep = r.offOnSleep !== false;
  return out;
}

function inRange(nowMin, from, to) {
  const a = toMin(from), b = toMin(to);
  return a < b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b; // через полночь
}

// ctx: { apps: Set<exe>, idleSec, locked, now: Date }; themeName(id) -> строка
// Возвращает null или { key, kind: 'off'|'theme', themeId, label }
function evaluate(sc, ctx, themeName = (id) => id) {
  if (sc.offOnLock && ctx.locked) return { key: 'lock', kind: 'off', label: 'Компьютер заблокирован — подсветка погашена' };
  if (sc.idleMinutes > 0 && ctx.idleSec >= sc.idleMinutes * 60) return { key: 'idle', kind: 'off', label: `Нет действий больше ${sc.idleMinutes} мин — подсветка погашена` };
  for (const a of sc.apps) {
    if (ctx.apps && ctx.apps.has(a.exe)) return { key: `app:${a.exe}`, kind: 'theme', themeId: a.themeId, label: `Запущена ${a.exe} — тема «${themeName(a.themeId)}»` };
  }
  const nowMin = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  for (let i = 0; i < sc.schedule.length; i++) {
    const s = sc.schedule[i];
    if (!inRange(nowMin, s.from, s.to)) continue;
    if (s.mode === 'off') return { key: `sched:${i}:off`, kind: 'off', label: `По расписанию ${s.from}–${s.to} подсветка выключена` };
    return { key: `sched:${i}:${s.themeId}`, kind: 'theme', themeId: s.themeId, label: `По расписанию ${s.from}–${s.to} — тема «${themeName(s.themeId)}»` };
  }
  return null;
}

module.exports = { DEFAULT_SCENARIOS, sanitizeScenarios, evaluate, normalizeExe, inRange };
