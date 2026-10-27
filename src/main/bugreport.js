'use strict';
// «Сообщить о проблеме»: собирает в один zip-архив всё, что нужно, чтобы понять, почему не работает подсветка.
// Личное убираем: имя пользователя и имя компьютера в путях, ключ от пульта на телефоне, город для погоды.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

// --- Простой zip без сторонних библиотек ---------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdir, end]);
}

// --- Убираем личное -----------------------------------------------------------
function makeScrubber() {
  const user = (() => { try { return os.userInfo().username; } catch (_) { return ''; } })();
  const host = os.hostname();
  const rules = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (user && user.length > 1) rules.push([new RegExp(`([\\\\/]Users[\\\\/])${esc(user)}(?=[\\\\/"']|$)`, 'gi'), '$1<user>'], [new RegExp(`\\b${esc(user)}\\b`, 'g'), '<user>']);
  if (host && host.length > 1) rules.push([new RegExp(`\\b${esc(host)}\\b`, 'gi'), '<pc>']);
  rules.push([/([?&]t=)[A-Za-z0-9_-]{8,}/g, '$1<key>']);
  return (text) => rules.reduce((t, [re, to]) => t.replace(re, to), String(text));
}

function scrubSettings(state) {
  const s = JSON.parse(JSON.stringify(state || {}));
  if (s.settings) {
    if (s.settings.remote) s.settings.remote.token = s.settings.remote.token ? '<скрыт>' : '';
    if (s.settings.widgets) s.settings.widgets.city = s.settings.widgets.city ? '<скрыт>' : '';
    if (s.settings.photoPicks) s.settings.photoPicks = `${Object.keys(s.settings.photoPicks).length} шт.`;
  }
  return s;
}

function runPs(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true }); } catch (e) { resolve('не удалось запустить PowerShell: ' + e.message); return; }
    const t = setTimeout(() => { try { child.kill(); } catch (_) { /* уже */ } }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve('ошибка: ' + e.message); });
    child.on('exit', () => { clearTimeout(t); resolve(out + (err ? '\n--- ошибки ---\n' + err.slice(0, 4000) : '')); });
  });
}

const tail = (file, max) => { try { const b = fs.readFileSync(file); return b.length > max ? b.subarray(b.length - max) : b; } catch (_) { return null; } };

// Собрать отчёт. ctx: { core, logFile, dataDir, outDir, version, extra }
async function buildReport({ core, logFile, dataDir, outDir, extra = {}, description = '', withHardware = true }) {
  const scrub = makeScrubber();
  const files = [];
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const health = await core.checkHealth().catch(() => core.health);
  const summary = [
    `Отчёт Lumen ${core.version} — ${new Date().toLocaleString('ru-RU')}`,
    '',
    'Что не работает (написал пользователь):',
    description ? String(description).slice(0, 4000) : '(не указано)',
    '',
    `Windows: ${os.type()} ${os.release()} · Electron ${process.versions.electron || '-'} · язык ${core.lang()}`,
    `Движок: ${core.conn.status} ${core.conn.message || ''} · с правами администратора: ${core.state.settings.engineAdmin ? 'да' : 'нет'}`,
    `Устройства сейчас (${core.devices.length}):`,
    ...core.devices.map((d) => `  · ${d.name} [${d.source}, ${d.kind}, ${d.leds.length} св.]${(d.zones || []).length ? ' зоны: ' + d.zones.map((z) => `${z.name}=${z.count}`).join(', ') : ''}`),
    `Мешают программы: ${health.conflicts.length ? health.conflicts.map((c) => c.name).join(', ') : 'нет'}`,
    `Не найдены знакомые устройства: ${health.missing.length ? health.missing.map((d) => d.name).join(', ') : 'нет'}`,
  ].join('\n');
  files.push({ name: '00-сводка.txt', data: scrub(summary) });
  files.push({ name: 'диагностика.json', data: scrub(JSON.stringify({ ...core.diagnostics(), ...extra, health }, null, 2)) });
  files.push({ name: 'настройки.json', data: scrub(JSON.stringify(scrubSettings(core.publicState()), null, 2)) });
  const log = tail(logFile, 600000);
  if (log) files.push({ name: 'lumen.log', data: scrub(log.toString('utf8')) });
  for (const f of ['engine-setup-result.json', 'engine-request.json']) {
    const b = tail(path.join(dataDir, f), 20000);
    if (b) files.push({ name: 'движок/' + f, data: scrub(b.toString('utf8')) });
  }
  // Журналы и настройки движка OpenRGB (что он нашёл и где споткнулся)
  const orgb = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'OpenRGB');
  for (const f of ['OpenRGB.json', 'sizes.ors']) {
    const b = tail(path.join(orgb, f), 200000);
    if (b) files.push({ name: 'движок/' + f, data: f.endsWith('.json') ? scrub(b.toString('utf8')) : b });
  }
  try {
    const logs = fs.readdirSync(path.join(orgb, 'logs')).map((f) => ({ f, t: fs.statSync(path.join(orgb, 'logs', f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 3);
    for (const { f } of logs) files.push({ name: 'движок/logs/' + f, data: scrub(tail(path.join(orgb, 'logs', f), 400000).toString('utf8')) });
  } catch (_) { /* журналов нет */ }
  if (withHardware && process.platform === 'win32') {
    const src = path.join(__dirname, 'hwinfo.ps1');
    const dest = path.join(dataDir, 'hwinfo.ps1');
    try { fs.writeFileSync(dest, '﻿' + fs.readFileSync(src, 'utf8').replace(/^﻿/, ''), 'utf8'); } catch (_) { /* не страшно */ }
    files.push({ name: 'оборудование.txt', data: scrub(await runPs(dest)) });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `Lumen-отчёт-${stamp}.zip`);
  fs.writeFileSync(file, makeZip(files));
  return { file, files: files.map((f) => f.name) };
}

module.exports = { buildReport, makeZip, makeScrubber, scrubSettings };
