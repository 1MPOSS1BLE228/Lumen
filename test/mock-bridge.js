'use strict';
// Поддельный мост lampbridge.ps1: говорит на том же протоколе и записывает полученные кадры
// в файл, указанный в LUMEN_MOCK_LOG. Нужен для тестов без Windows.
const fs = require('fs');
const rl = require('readline').createInterface({ input: process.stdin });
const log = process.env.LUMEN_MOCK_LOG;
const mode = process.env.LUMEN_MOCK_MODE || 'normal';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Клавиатура 3x2 и лента из 8 ламп; позиции в метрах, как отдаёт Windows
const kb = [];
for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) kb.push(0.02 * c + 0.01, 0.02 * r + 0.01, 0);
const strip = [];
for (let i = 0; i < 8; i++) strip.push(0.05 * i, 0, 0);
const devices = mode === 'empty' ? [] : [
  { handle: 0, id: 'HID#VID_1234&PID_0001#a', name: 'Тестовая клавиатура', kind: 1, count: 6, connected: true, enabled: true, minInterval: 20, bbox: [0.06, 0.04, 0.01], pos: kb },
  { handle: 1, id: 'HID#VID_1234&PID_0002#b', name: 'Тестовая лента', kind: 4, count: 8, connected: true, enabled: true, available: mode !== 'busy', minInterval: 20, bbox: [0.4, 0.01, 0.01], pos: strip },
];

if (mode === 'crash-once' && !fs.existsSync(log + '.crashed')) {
  fs.writeFileSync(log + '.crashed', '1');
  process.stderr.write('boom');
  process.exit(5);
}
if (mode === 'fatal') { out({ event: 'fatal', message: 'Нет доступа к API подсветки Windows: тест' }); setTimeout(() => process.exit(2), 50); }
else out({ event: 'ready' });

rl.on('line', (line) => {
  if (line[0] === 'S') {
    const [, h, b64] = line.split('\t');
    if (log) fs.appendFileSync(log, JSON.stringify({ t: Date.now(), h: Number(h), rgb: [...Buffer.from(b64, 'base64')] }) + '\n');
    return;
  }
  const msg = JSON.parse(line);
  if (msg.cmd === 'list') out({ id: msg.id, ok: true, devices: mode === 'single' ? devices[0] : devices });
  if (msg.cmd === 'quit') { if (log) fs.appendFileSync(log, JSON.stringify({ quit: true }) + '\n'); process.exit(0); }
});
