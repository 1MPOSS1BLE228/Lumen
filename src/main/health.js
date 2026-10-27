'use strict';
// «Здоровье» подсветки: какие сторонние RGB-программы сейчас забирают устройства,
// и каких знакомых устройств движок в этот раз не нашёл.

// Программы, которые держат подсветку у себя (имена процессов в нижнем регистре)
const CONFLICTS = [
  { id: 'signalrgb', name: 'SignalRGB', exes: ['signalrgb.exe', 'signalrgblauncher.exe'] },
  { id: 'icue', name: 'Corsair iCUE', exes: ['icue.exe'] },
  { id: 'armoury', name: 'ASUS Armoury Crate / Aura', exes: ['armourycrate.exe', 'armourycrate.usersessionhelper.exe', 'lightingservice.exe', 'auraservice.exe'] },
  { id: 'msi', name: 'MSI Center / Mystic Light', exes: ['msi.centralserver.exe', 'mysticlight.exe', 'msi_mysticlight.exe'] },
  { id: 'ghub', name: 'Logitech G HUB', exes: ['lghub.exe', 'lghub_agent.exe'] },
  { id: 'nzxt', name: 'NZXT CAM', exes: ['nzxt cam.exe'] },
  { id: 'polychrome', name: 'ASRock Polychrome RGB', exes: ['polychromergb.exe', 'polychrome rgb.exe'] },
  { id: 'fusion', name: 'Gigabyte RGB Fusion', exes: ['rgbfusion.exe', 'gcc.exe'] },
  { id: 'steelseries', name: 'SteelSeries GG', exes: ['steelseriesgg.exe', 'steelseriesengine.exe'] },
  { id: 'razer', name: 'Razer Synapse', exes: ['razer synapse 3.exe', 'razer synapse.exe', 'razercentralservice.exe'] },
];

// Разбор вывода tasklist /fo csv /nh -> имена процессов в нижнем регистре
function parseTasklist(out) {
  const names = new Set();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

function findConflicts(names) {
  const set = names instanceof Set ? names : new Set([...names].map((x) => String(x).toLowerCase()));
  return CONFLICTS.filter((c) => c.exes.some((e) => set.has(e))).map((c) => ({ id: c.id, name: c.name, exes: c.exes.filter((e) => set.has(e)) }));
}

// Знакомые устройства: имя + откуда (движок / Windows). Храним не больше 40.
function mergeKnown(known, current) {
  const key = (d) => `${d.source}|${d.name}`;
  const map = new Map((known || []).map((d) => [key(d), d]));
  for (const d of current) map.set(key(d), { name: d.name, source: d.source, kind: d.kind || '' });
  return [...map.values()].slice(-40);
}

// Каких знакомых устройств сейчас нет (одинаковые названия считаем по количеству: 4 планки памяти)
function missingDevices(known, current) {
  const count = (list) => list.reduce((m, d) => { const k = `${d.source}|${d.name}`; m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());
  const cur = count(current);
  return (known || []).filter((d) => !cur.has(`${d.source}|${d.name}`)).map((d) => ({ name: d.name, kind: d.kind, source: d.source }));
}

module.exports = { CONFLICTS, parseTasklist, findConflicts, mergeKnown, missingDevices };
