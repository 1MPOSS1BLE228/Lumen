'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fx = require('../src/shared/effects');
const { THEMES } = require('../src/shared/catalog');
const { OpenRGBClient, deviceLayout } = require('../src/main/openrgb');
const { Core } = require('../src/main/core');
const { createDemoDevices } = require('../src/main/devices');
const { startMock } = require('./mock-openrgb');
const { NativeBackend, layoutFromBridge } = require('../src/main/native');
const { WinTheme } = require('../src/main/wintheme');
const { pickAccent } = require('../src/shared/accent');
const { randomTheme } = require('../src/shared/surprise');
const { encodeTheme, decodeTheme } = require('../src/shared/share');
const { sanitizeScenarios, evaluate } = require('../src/main/scenarios');
const { Sensors, parseNvidiaSmi } = require('../src/main/sensors');
const { Wallpaper, renderWallpaper } = require('../src/main/wallpaper');
const zlib = require('zlib');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-'));
const BRIDGE = path.join(__dirname, 'mock-bridge.js');
const mockNative = (mode = 'normal', dir = tmp()) => {
  const log = path.join(dir, 'bridge.log');
  process.env.LUMEN_MOCK_LOG = log;
  process.env.LUMEN_MOCK_MODE = mode;
  return { be: new NativeBackend({ dataDir: dir, command: process.execPath, args: [BRIDGE] }), log };
};
const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (cond, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (cond()) return true; await wait(25); } return false; };

let passed = 0;
const failed = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed.push(name); console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

(async () => {
  console.log('Эффекты и темы');
  await test('все эффекты на всех демо-устройствах дают валидные байты и меняются во времени', () => {
    const devs = createDemoDevices();
    for (const id of fx.EFFECT_IDS) {
      for (const dir of fx.DIRECTIONS) {
        for (const d of devs) {
          const a = new Uint8Array(d.leds.length * 3), b = new Uint8Array(d.leds.length * 3);
          const p = { effect: id, pal: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], direction: dir, brightness: 100 };
          fx.renderDevice(d, p, 1.0, null, a);
          fx.renderDevice(d, p, 7.3, null, b);
          for (const v of a) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${id}/${dir}/${d.id}: ${v}`);
          if (!['static', 'gradient', 'music', 'screen', 'temperature'].includes(id) && d.id !== 'demo:mouse') {
            // у динамических эффектов кадр обязан меняться
            if (id !== 'scanner' && id !== 'comet') assert.notDeepStrictEqual(Buffer.from(a), Buffer.from(b), `${id}/${d.id} не анимируется`);
          }
        }
      }
    }
  });
  await test('яркость 0 даёт чёрный кадр, 50 — вдвое темнее', () => {
    const d = createDemoDevices()[0];
    const p = { effect: 'static', pal: [[200, 100, 50]], direction: 'right', brightness: 100 };
    const full = fx.renderDevice(d, p, 0, null, new Uint8Array(d.leds.length * 3));
    assert.deepStrictEqual([full[0], full[1], full[2]], [200, 100, 50]);
    const half = fx.renderDevice(d, { ...p, brightness: 50 }, 0, null, new Uint8Array(d.leds.length * 3));
    assert.deepStrictEqual([half[0], half[1], half[2]], [100, 50, 25]);
    const zero = fx.renderDevice(d, { ...p, brightness: 0 }, 0, null, new Uint8Array(d.leds.length * 3));
    assert.ok(zero.every((v) => v === 0));
  });
  await test('эффект «Музыка» реагирует на звук', () => {
    const d = createDemoDevices()[2];
    const p = { effect: 'music', pal: [[255, 255, 255]], direction: 'right', brightness: 100 };
    const quiet = fx.renderDevice(d, p, 0, { bands: new Array(16).fill(0), bass: 0, level: 0 }, new Uint8Array(d.leds.length * 3));
    const loud = fx.renderDevice(d, p, 0, { bands: new Array(16).fill(1), bass: 1, level: 1 }, new Uint8Array(d.leds.length * 3));
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    assert.ok(sum(loud) > sum(quiet) * 3);
  });
  await test('темы корректны: уникальные id, существующие эффекты, hex-цвета', () => {
    const ids = new Set();
    for (const t of THEMES) {
      assert.ok(!ids.has(t.id)); ids.add(t.id);
      assert.ok(fx.EFFECTS[t.effect], t.id);
      assert.ok(t.colors.length >= 1 && t.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)), t.id);
      assert.ok(t.speed >= 0 && t.speed <= 100);
    }
    assert.ok(THEMES.length >= 15);
  });

  console.log('Клиент OpenRGB (поддельный сервер)');
  const mock = await startMock();
  await test('подключение, согласование версии, список устройств и раскладка', async () => {
    const c = new OpenRGBClient({ port: mock.port, name: 'Lumen' });
    await c.connect();
    assert.strictEqual(c.version, 3);
    const list = await c.listDevices();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].name, 'Mock Keyboard');
    assert.strictEqual(list[0].kind, 'keyboard');
    assert.strictEqual(list[0].ledCount, 6);
    assert.strictEqual(list[0].zones[0].matrix.width, 3);
    assert.strictEqual(list[1].kind, 'strip');
    assert.strictEqual(list[1].modes.length, 2);
    const lay = deviceLayout(list[0]);
    assert.strictEqual(lay.leds.length, 6);
    assert.deepStrictEqual(lay.leds[0], { x: 0, y: 0 });
    assert.deepStrictEqual(lay.leds[5], { x: 1, y: 1 });
    assert.strictEqual(lay.linear, false);
    const lay2 = deviceLayout(list[1]);
    assert.strictEqual(lay2.linear, true);
    assert.strictEqual(lay2.leds[9].x, 1);
    assert.strictEqual(mock.log.clientName, 'Lumen');
    c.close();
  });
  await test('кадр уходит в правильном формате', async () => {
    const c = new OpenRGBClient({ port: mock.port });
    await c.connect();
    mock.log.updates.length = 0;
    c.setLeds(1, new Uint8Array([1, 2, 3, 4, 5, 6]));
    await wait(100);
    const u = mock.log.updates[0];
    assert.strictEqual(u.dev, 1); assert.strictEqual(u.n, 2);
    assert.deepStrictEqual(u.rgb, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(u.size, u.len);
    c.close();
  });
  await test('ошибка подключения понятна (порт закрыт)', async () => {
    const c = new OpenRGBClient({ port: 1 });
    await assert.rejects(() => c.connect(1000), (e) => e.code === 'ECONNREFUSED' || /таймаут/.test(e.message));
  });

  console.log('Ядро Lumen');
  await test('демо-режим: кадры генерируются, настройки сохраняются и читаются', async () => {
    const dir = tmp();
    const core = new Core({ dataDir: dir });
    core.state.settings.autoConnect = false;
    let frames = 0, last = null;
    core.on('frames', (f) => { frames++; last = f; });
    core.start();
    await wait(250);
    assert.ok(frames >= 4, 'кадров: ' + frames);
    assert.ok(Object.keys(last).length === 5);
    core.setState({ brightness: 33, effect: 'fire' });
    assert.strictEqual(core.state.themeId, null);
    core.applyTheme('lava');
    assert.strictEqual(core.state.effect, 'fire');
    assert.strictEqual(core.state.themeId, 'lava');
    const t = core.saveTheme('  Тест  ');
    assert.strictEqual(t.name, 'Тест');
    core.shutdown();
    const again = new Core({ dataDir: dir });
    assert.strictEqual(again.state.brightness, 33);
    assert.strictEqual(again.state.customThemes.length, 1);
    assert.strictEqual(again.state.themeId, t.id);
    again.deleteTheme(t.id);
    assert.strictEqual(again.state.customThemes.length, 0);
    again.shutdown();
  });
  await test('защита от мусора на входе', () => {
    const core = new Core({ dataDir: tmp() });
    core.setState({ brightness: 999, speed: -5, colors: ['red', '#12345', '#aabbcc'], effect: 'nope', direction: 'sideways' });
    assert.strictEqual(core.state.brightness, 100);
    assert.strictEqual(core.state.speed, 0);
    assert.deepStrictEqual(core.state.colors, ['#aabbcc']);
    assert.ok(fx.EFFECTS[core.state.effect]);
    assert.ok(fx.DIRECTIONS.includes(core.state.direction));
    core.setSettings({ port: 'abc', host: '' });
    assert.strictEqual(core.state.settings.host, '127.0.0.1');
    core.shutdown();
  });
  await test('подключение к OpenRGB: устройства подменяют демо, кадры доходят до «железа»', async () => {
    const core = new Core({ dataDir: tmp() });
    core.setSettings({ port: mock.port, autoConnect: false, launchOpenrgb: false });
    mock.log.updates.length = 0; mock.log.customModes.length = 0;
    core.start();
    await core.connect({ manual: true });
    assert.strictEqual(core.conn.status, 'connected');
    assert.strictEqual(core.devices.length, 2);
    assert.ok(core.devices.every((d) => d.source === 'openrgb'));
    await wait(400);
    assert.deepStrictEqual(mock.log.customModes.sort(), [0, 1]);
    const strip = mock.log.updates.filter((u) => u.dev === 1);
    assert.ok(strip.length >= 3, 'кадров на ленту: ' + strip.length);
    assert.ok(strip.some((u) => u.rgb.some((v) => v > 0)), 'кадры не чёрные');
    // выключение питания → чёрный кадр
    core.setState({ power: false });
    await wait(200);
    mock.log.updates.length = 0;
    await wait(300);
    // при неизменном кадре шлём только раз в 2 секунды (keepalive)
    assert.ok(mock.log.updates.length <= 2, 'лишние кадры: ' + mock.log.updates.length);
    // отключённое устройство гаснет
    core.setState({ power: true });
    await wait(250);
    assert.ok(mock.log.updates.filter((u) => u.dev === 1).pop().rgb.some((v) => v > 0), 'лента должна светиться');
    mock.log.updates.length = 0;
    core.setDeviceEnabled(core.devices[1].id, false);
    await wait(250);
    const last = mock.log.updates.filter((u) => u.dev === 1).pop();
    assert.ok(last && last.rgb.every((v) => v === 0), 'выключенное устройство должно гаснуть');
    // после отключения возвращается демо
    core.disconnect();
    assert.strictEqual(core.devices.length, 5);
    core.shutdown();
  });
  await test('нет OpenRGB → понятная ошибка и демо остаётся', async () => {
    const core = new Core({ dataDir: tmp() });
    core.setSettings({ port: 1, autoConnect: false, launchOpenrgb: false });
    await core.connect({ manual: true });
    assert.strictEqual(core.conn.status, 'error');
    assert.ok(/OpenRGB/.test(core.conn.message), core.conn.message);
    assert.strictEqual(core.devices.length, 5);
    core.shutdown();
  });


  console.log('Встроенный драйвер Windows (поддельный мост)');
  await test('раскладка ламп из метров в 0..1, вид и пропорции', () => {
    const kb = layoutFromBridge({ count: 6, pos: [0.01, 0.01, 0, 0.03, 0.01, 0, 0.05, 0.01, 0, 0.01, 0.03, 0, 0.03, 0.03, 0, 0.05, 0.03, 0] });
    assert.deepStrictEqual(kb.leds[0], { x: 0, y: 0 });
    assert.deepStrictEqual(kb.leds[5], { x: 1, y: 1 });
    assert.strictEqual(kb.linear, false);
    assert.ok(Math.abs(kb.aspect - 2) < 1e-6, 'aspect ' + kb.aspect);
    const strip = layoutFromBridge({ count: 3, pos: [0, 0, 0, 0.1, 0, 0, 0.2, 0, 0] });
    assert.strictEqual(strip.linear, true);
    assert.strictEqual(strip.leds[1].x, 0.5);
    const one = layoutFromBridge({ count: 1, pos: [0.5, 0.5, 0] });
    assert.deepStrictEqual(one.leds[0], { x: 0.5, y: 0.5 });
  });
  await test('находит устройства, отдаёт кадры в правильном формате и закрывает мост', async () => {
    const { be, log } = mockNative();
    const changes = [];
    be.on('devices', (l) => changes.push(l.length));
    be.start();
    assert.ok(await until(() => be.status.state === 'ready' && be.devices.length === 2), 'устройства не найдены: ' + JSON.stringify(be.status));
    assert.strictEqual(be.devices[0].name, 'Тестовая клавиатура');
    assert.strictEqual(be.devices[0].kind, 'keyboard');
    assert.strictEqual(be.devices[0].plate, true);
    assert.strictEqual(be.devices[1].linear, true);
    assert.strictEqual(be.devices[1].available, true);
    assert.ok(be.devices[0].id.startsWith('native:'));
    assert.strictEqual(be.status.count, 2);
    assert.strictEqual(be.setLeds(be.devices[1].id, new Uint8Array(8 * 3).fill(7)), true);
    assert.strictEqual(be.setLeds(be.devices[1].id, new Uint8Array(8 * 3).fill(9)), false, 'слишком частый кадр должен пропускаться');
    await wait(40);
    assert.strictEqual(be.setLeds(be.devices[1].id, Uint8Array.from({ length: 24 }, (_, i) => i)), true);
    await until(() => readLog(log).filter((x) => x.rgb).length >= 2);
    const frames = readLog(log).filter((x) => x.rgb);
    assert.strictEqual(frames[0].h, 1);
    assert.deepStrictEqual(frames[0].rgb, new Array(24).fill(7));
    assert.deepStrictEqual(frames[1].rgb, Array.from({ length: 24 }, (_, i) => i));
    be.stop();
    assert.ok(await until(() => readLog(log).some((x) => x.quit)), 'мост не получил команду выхода');
    assert.strictEqual(be.devices.length, 0);
  });
  await test('одно устройство (не массив) и пустой список разбираются', async () => {
    const a = mockNative('single'); a.be.start();
    assert.ok(await until(() => a.be.devices.length === 1)); a.be.stop();
    const b = mockNative('empty'); b.be.start();
    assert.ok(await until(() => b.be.status.state === 'ready'));
    assert.strictEqual(b.be.devices.length, 0); b.be.stop();
  });
  await test('устройство занято другой программой — это видно', async () => {
    const { be } = mockNative('busy'); be.start();
    assert.ok(await until(() => be.devices.length === 2));
    assert.strictEqual(be.devices[1].available, false);
    assert.strictEqual(be.devices[0].available, true);
    be.stop();
  });
  await test('мост упал — перезапускается сам', async () => {
    const dir = tmp();
    const { be } = mockNative('crash-once', dir);
    be.restartDelay = 100;
    be.start();
    assert.ok(await until(() => be.status.state === 'ready' && be.devices.length === 2, 6000), 'после сбоя устройства не вернулись: ' + JSON.stringify(be.status));
    be.stop();
  });
  await test('фатальная ошибка моста показывается и не зацикливает перезапуски', async () => {
    const { be } = mockNative('fatal');
    be.start();
    assert.ok(await until(() => be.status.state === 'error'));
    assert.ok(/Нет доступа/.test(be.status.message), be.status.message);
    await wait(300);
    assert.strictEqual(be.child, null);
    be.stop();
  });
  await test('не Windows — «не поддерживается», без попыток запуска', () => {
    const be = new NativeBackend({ dataDir: tmp(), platform: 'linux' });
    be.start();
    assert.strictEqual(be.status.state, 'unsupported');
    assert.strictEqual(be.child, null);
  });
  await test('PowerShell-скрипты: BOM при копировании и нет опасных 8-значных hex-литералов', () => {
    for (const f of ['lampbridge.ps1', 'wintheme.ps1', 'wallpaper.ps1']) {
      const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
      assert.ok(!/0x[0-9A-Fa-f]{8}\b/.test(text), f + ': hex-литерал из 8 цифр в PowerShell 5.1 бывает отрицательным');
      assert.ok(/[А-Яа-я]/.test(text));
      assert.ok(!/\[Windows\.UI\.Color\s*,/.test(text), f + ': тип Windows.UI.Color нельзя загружать по имени (так падала проверка на реальной Windows)');
    }
    const dir = tmp();
    const be = new NativeBackend({ dataDir: dir, platform: 'win32' });
    const dest = be._scriptPath();
    assert.strictEqual(fs.readFileSync(dest)[0], 0xef, 'нужен UTF-8 BOM, иначе Windows PowerShell 5.1 испортит кириллицу');
  });

  console.log('Цвет оформления Windows (поддельный исполнитель)');
  await test('акцент: выбор яркого цвета из палитры', () => {
    assert.strictEqual(pickAccent(['#202020', '#FF2BD6', '#303030']), '#ff2bd6');
    assert.strictEqual(pickAccent(['#ff0000'], 'rainbow'), '#8b5cff');
    assert.strictEqual(pickAccent([]), '#8b5cff');
  });
  await test('включение: резервная копия → применение; выключение: возврат и удаление копии', async () => {
    const calls = [];
    const runner = async (args) => { calls.push(args); return args[1] === 'Read' ? JSON.stringify({ dwmAccent: 123, appsLight: 1, palette: 'AABB' }) : '{"ok":true}'; };
    const dir = tmp();
    const wt = new WinTheme({ dataDir: dir, runner, platform: 'win32' });
    wt.setAccent('#FF2BD6');
    await wt.configure({ enabled: true, forceDark: true });
    assert.deepStrictEqual(calls.map((c) => c[1]), ['Read', 'Apply']);
    assert.deepStrictEqual(calls[1], ['-Action', 'Apply', '-Accent', 'ff2bd6', '-Dark', '1']);
    assert.ok(wt.hasBackup());
    assert.strictEqual(wt.status.state, 'ok');
    await wt.configure({ enabled: false, forceDark: true });
    assert.strictEqual(calls[2][1], 'Restore');
    const sent = JSON.parse(Buffer.from(calls[2][calls[2].indexOf('-Backup') + 1], 'base64').toString());
    assert.deepStrictEqual(sent, { dwmAccent: 123, appsLight: 1, palette: 'AABB' });
    assert.ok(!wt.hasBackup());
    assert.strictEqual(wt.status.state, 'off');
  });
  await test('частые смены цвета склеиваются, неизменный цвет не применяется заново, резервная копия одна', async () => {
    const calls = [];
    const runner = async (args) => { calls.push(args); return args[1] === 'Read' ? '{}' : '{"ok":true}'; };
    const wt = new WinTheme({ dataDir: tmp(), runner, platform: 'win32' });
    await wt.configure({ enabled: true, forceDark: false });
    wt.setAccent('#ff0000'); wt.setAccent('#00ff00'); wt.setAccent('#0000ff');
    await wait(1900);
    const applies = calls.filter((c) => c[1] === 'Apply');
    assert.strictEqual(applies.length, 1, 'применений: ' + applies.length);
    assert.strictEqual(applies[0][3], '0000ff');
    assert.ok(!applies[0].includes('-Dark'), 'без «тёмной темы» параметр -Dark не передаётся');
    wt.setAccent('#0000ff'); await wait(1800);
    assert.strictEqual(calls.filter((c) => c[1] === 'Apply').length, 1);
    assert.strictEqual(calls.filter((c) => c[1] === 'Read').length, 1);
    await wt.shutdown({ restore: true });
    assert.ok(!wt.hasBackup());
  });
  await test('ошибка PowerShell показывается пользователю и ничего не ломает', async () => {
    const runner = async () => { throw new Error('доступ запрещён'); };
    const wt = new WinTheme({ dataDir: tmp(), runner, platform: 'win32' });
    wt.setAccent('#ff0000');
    await wt.configure({ enabled: true, forceDark: false });
    assert.strictEqual(wt.status.state, 'error');
    assert.ok(/доступ запрещён/.test(wt.status.message));
  });
  await test('не Windows — недоступно и ничего не запускает', async () => {
    const wt = new WinTheme({ dataDir: tmp(), platform: 'linux' });
    assert.strictEqual(wt.available, false);
    await wt.configure({ enabled: true, forceDark: false });
    assert.strictEqual(wt.status.state, 'off');
  });

  console.log('Ядро + встроенный драйвер + цвет Windows');
  await test('устройства Windows подменяют демо, кадры доходят до моста, цвет Windows следует за темой', async () => {
    const { be, log } = mockNative();
    const winCalls = [];
    const wt = new WinTheme({ dataDir: tmp(), platform: 'win32', runner: async (a) => { winCalls.push(a); return a[1] === 'Read' ? '{}' : '{"ok":true}'; } });
    const core = new Core({ dataDir: tmp(), native: be, wintheme: wt, platform: 'win32' });
    core.setSettings({ autoConnect: false, launchOpenrgb: false, winThemeEnabled: true });
    core.begin();
    assert.ok(await until(() => core.devices.length === 2 && core.devices.every((d) => d.source === 'native')), 'устройства: ' + core.devices.length);
    assert.ok(await until(() => readLog(log).filter((x) => x.rgb).length >= 4), 'кадры не пошли');
    assert.ok(readLog(log).some((x) => x.rgb.some((v) => v > 0)), 'кадры чёрные');
    core.applyTheme('lava');
    await wait(2100);
    const last = winCalls.filter((c) => c[1] === 'Apply').pop();
    assert.ok(last, 'цвет Windows не применён');
    assert.ok(/^[0-9a-f]{6}$/.test(last[3]), last.join(' '));
    // выключили встроенное управление — демо возвращается
    core.setSettings({ nativeEnabled: false });
    assert.ok(await until(() => core.devices.length === 5), 'демо не вернулось');
    await core.finalize();
    assert.ok(!wt.hasBackup(), 'при выходе оформление должно вернуться');
    assert.ok(winCalls.some((c) => c[1] === 'Restore'));
  });


  console.log('Встроенный движок (OpenRGB внутри установщика)');
  await test('Lumen сам запускает движок без окна, подключается и гасит его при выходе', async () => {
    // поддельный движок — shell-скрипт, в Windows его не запустить; там это проверяет реальный запуск
    if (process.platform === 'win32') return;
    const dir = tmp();
    const exe = path.join(dir, 'OpenRGB.exe');
    fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'mock-engine.js')}" "$@"\n`, { mode: 0o755 });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const core = new Core({ dataDir: dir, bundledEngine: exe, platform: 'linux' });
    core.setSettings({ port, autoConnect: true, launchOpenrgb: false });
    assert.strictEqual(core.findOpenRGB(), exe, 'встроенный движок важнее пути из настроек');
    core.begin();
    assert.ok(core.engineChild, 'движок должен быть запущен сразу');
    assert.strictEqual(core.conn.bundled, true);
    assert.ok(await until(() => core.conn.status === 'connected', 15000), 'не подключился: ' + JSON.stringify(core.conn));
    assert.strictEqual(core.devices.filter((d) => d.source === 'openrgb').length, 2);
    const child = core.engineChild;
    const exited = new Promise((r) => child.once('exit', r));
    core.shutdown();
    await Promise.race([exited, wait(3000)]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'движок должен закрыться вместе с Lumen');
  });
  await test('без встроенного движка поведение прежнее', () => {
    const core = new Core({ dataDir: tmp(), bundledEngine: '/нет/такого/OpenRGB.exe' });
    assert.strictEqual(core.bundledEngine, '');
    assert.strictEqual(core.conn.bundled, undefined);
    core.shutdown();
  });


  console.log('Порядок цветов (GRB-вентиляторы)');
  await test('GRB: красный уходит на железо как (0,255,0), превью остаётся красным; проверка зоны', async () => {
    const core = new Core({ dataDir: tmp() });
    core.setSettings({ port: mock.port, autoConnect: false, launchOpenrgb: false });
    core.start();
    await core.connect({ manual: true });
    const strip = core.devices.find((d) => d.name === 'Mock Strip');
    assert.deepStrictEqual(core.deviceInfos().find((d) => d.id === strip.id).zones.map((z) => [z.name, z.count, z.resizable]), [['Strip', 10, true], ['Header 2', 40, true]], 'разъём без размера получил 40 светодиодов сам');
    core.setState({ effect: 'static', colors: ['#ff0000'], brightness: 100 });
    core.setColorOrder(strip.id, 'Strip', 'GRB');
    core.setColorOrder(strip.id, 'Strip', 'НЕТ');
    assert.strictEqual(core.state.colorOrders[`${strip.id}|Strip`], 'GRB');
    mock.log.updates.length = 0;
    await wait(250);
    const last = mock.log.updates.filter((u) => u.dev === 1).pop();
    assert.deepStrictEqual(last.rgb.slice(0, 3), [0, 255, 0], 'на железо должен уйти переставленный цвет');
    assert.deepStrictEqual([...core.frames[strip.id].slice(0, 3)], [255, 0, 0], 'превью не меняется');
    // проверка зоны: шаг 1 — красный (с учётом GRB → 0,255,0), шаг 2 — зелёный (→ 255,0,0)
    const r = core.testZone(strip.id, 'Strip');
    assert.strictEqual(r.steps.length, 3);
    await wait(300);
    let u = mock.log.updates.filter((x) => x.dev === 1).pop();
    assert.deepStrictEqual(u.rgb.slice(0, 3), [0, 255, 0]);
    await wait(1500);
    u = mock.log.updates.filter((x) => x.dev === 1).pop();
    assert.deepStrictEqual(u.rgb.slice(0, 3), [255, 0, 0]);
    await wait(3000);
    assert.strictEqual(core.test, null, 'проверка заканчивается сама');
    core.setColorOrder(strip.id, 'Strip', 'RGB');
    assert.ok(!(`${strip.id}|Strip` in core.state.colorOrders));
    core.shutdown();
  });


  console.log('Количество светодиодов на разъёмах платы');
  await test('размер зоны задаётся из Lumen и сам применяется на «чистом» компьютере', async () => {
    const m1 = await startMock();
    const dir = tmp();
    const core = new Core({ dataDir: dir });
    core.setSettings({ port: m1.port, autoConnect: false, launchOpenrgb: false });
    core.start();
    await core.connect({ manual: true });
    const strip = core.devices.find((d) => d.name === 'Mock Strip');
    assert.strictEqual(core.setZoneSize(strip.id, 'Header 2', 12), true);
    assert.strictEqual(core.setZoneSize(strip.id, 'Нет такой', 5), false);
    assert.ok(await until(() => core.devices.find((d) => d.name === 'Mock Strip').leds.length === 22), 'после изменения устройство должно перечитаться');
    assert.deepStrictEqual(m1.log.resizes, [{ dev: 1, zi: 1, size: 40 }, { dev: 1, zi: 1, size: 12 }], 'сначала 40 сам, потом как сказал пользователь');
    core.setZoneSize(strip.id, 'Header 2', 5000);
    assert.strictEqual(core.state.zoneSizes[`${strip.id}|Header 2`], 100, 'размер ограничивается максимумом зоны');
    core.setZoneSize(strip.id, 'Header 2', 12);
    core.shutdown();
    m1.server.close();
    // «компьютер друга»: движок не знает размеров, Lumen применяет сохранённые сам
    const m2 = await startMock();
    const core2 = new Core({ dataDir: dir });
    core2.setSettings({ port: m2.port, autoConnect: false, launchOpenrgb: false });
    await core2.connect({ manual: true });
    assert.deepStrictEqual(m2.log.resizes, [{ dev: 1, zi: 1, size: 12 }]);
    assert.strictEqual(core2.devices.find((d) => d.name === 'Mock Strip').leds.length, 22);
    core2.shutdown();
    m2.server.close();
  });


  console.log('Цвет экрана и температура');
  await test('«Цвет экрана»: светодиод берёт цвет своей части экрана, сглаживание, насыщенность', async () => {
    const core = new Core({ dataDir: tmp() });
    core.setState({ effect: 'screen', brightness: 100 });
    const data = [];
    for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) data.push(...(col < 2 ? [200, 20, 20] : [20, 20, 200]));
    core.setScreen({ w: 4, h: 2, data });
    core.setScreen({ w: 4, h: 2, data: [1, 2] }); // мусор игнорируется
    for (let i = 0; i < 20; i++) core.tick();
    const strip = core.devices.find((d) => d.id === 'demo:strip');
    const f = core.frames[strip.id];
    const n = strip.leds.length;
    assert.ok(f[0] > 180 && f[2] < 40, 'левая часть ленты — красная: ' + [...f.slice(0, 3)]);
    assert.ok(f[(n - 1) * 3 + 2] > 180 && f[(n - 1) * 3] < 40, 'правая часть — синяя');
    core.shutdown();
  });
  await test('температура: разбор nvidia-smi, опрос только пока нужен, цвет от холодного к горячему', async () => {
    assert.deepStrictEqual(parseNvidiaSmi('62, 35\r\n'), { gpuTemp: 62, gpuLoad: 35, vramUsed: null, vramTotal: null, gpuPower: null });
    assert.deepStrictEqual(parseNvidiaSmi('41, 17, 2345, 16376, 31.52'), { gpuTemp: 41, gpuLoad: 17, vramUsed: 2345, vramTotal: 16376, gpuPower: 32 });
    assert.strictEqual(parseNvidiaSmi('No devices were found'), null);
    const fake = path.join(tmp(), 'smi.js');
    fs.writeFileSync(fake, 'console.log(process.env.FAKE_T + ", 90")');
    process.env.FAKE_T = '30';
    const sensors = new Sensors({ command: process.execPath, args: [fake] });
    const d = await sensors.poll();
    assert.deepStrictEqual([d.gpuTemp, d.gpuLoad, d.ok], [30, 90, true]);
    const bad = new Sensors({ command: '/нет/такой/программы' });
    const d2 = await bad.poll();
    assert.strictEqual(d2.ok, false);
    assert.ok(/nvidia-smi/.test(d2.message));
    const core = new Core({ dataDir: tmp(), sensors });
    core.applyTheme('thermo');
    core.tick();
    assert.ok(sensors.timer, 'для «Температуры» датчик опрашивается');
    await until(() => sensors.data.gpuTemp === 30);
    core.tick();
    const cold = [...core.frames['demo:strip'].slice(0, 3)];
    process.env.FAKE_T = '85';
    await until(() => sensors.data.gpuTemp === 85, 5000);
    core.tick();
    const hot = [...core.frames['demo:strip'].slice(0, 3)];
    assert.ok(cold[2] > cold[0], 'холодная — синеватая: ' + cold);
    assert.ok(hot[0] > hot[2], 'горячая — красная: ' + hot);
    core.applyTheme('cyberpunk');
    core.tick();
    assert.strictEqual(sensors.timer, null, 'без «Температуры» датчик не опрашивается');
    core.shutdown();
  });

  console.log('Обои под тему');
  await test('картинка обоев: правильный PNG нужного размера, цвета темы, без полос', () => {
    const { png, width, height } = renderWallpaper({ colors: ['#ff0000', '#0000ff'], effect: 'wave', width: 320, height: 180, style: 'glow' });
    assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 320);
    assert.strictEqual(png.readUInt32BE(20), 180);
    assert.deepStrictEqual([width, height], [320, 180]);
    // распаковать и проверить: слева сверху больше красного, справа снизу — синего
    const chunks = []; let o = 8;
    while (o < png.length) { const len = png.readUInt32BE(o); const type = png.toString('ascii', o + 4, o + 8); if (type === 'IDAT') chunks.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len; }
    const raw = zlib.inflateSync(Buffer.concat(chunks));
    const px = (x, y) => { const i = y * (320 * 3 + 1) + 1 + x * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    const tl = px(30, 30), br = px(290, 160);
    assert.ok(tl[0] > tl[2] + 30, 'левый верх красный: ' + tl);
    assert.ok(br[2] > br[0] + 30, 'правый низ синий: ' + br);
  });
  await test('обои: копия прежних, установка, склейка частых смен, возврат', async () => {
    const dir = tmp();
    const orig = path.join(dir, 'TranscodedWallpaper');
    fs.writeFileSync(orig, 'ORIGINAL');
    const calls = [];
    const runner = async (args) => { calls.push(args); return args[1] === 'Read' ? JSON.stringify({ path: '', style: '2', tile: '0', transcoded: orig }) : '{"ok":true}'; };
    const wp = new Wallpaper({ dataDir: dir, runner, platform: 'win32', getSize: () => ({ width: 200, height: 120 }) });
    wp.setTheme({ colors: ['#ff0000'], effect: 'static' });
    await wp.configure(true);
    const set = calls.find((c) => c[1] === 'Set');
    assert.ok(set && fs.existsSync(set[3]) && fs.readFileSync(set[3]).slice(1, 4).toString() === 'PNG', 'поставлен настоящий PNG');
    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'wallpaper-backup.json'), 'utf8'));
    assert.strictEqual(fs.readFileSync(backup.copy, 'utf8'), 'ORIGINAL', 'прежние обои скопированы до замены');
    wp.setTheme({ colors: ['#00ff00'], effect: 'static' });
    wp.setTheme({ colors: ['#0000ff'], effect: 'static' });
    await wait(2900);
    assert.strictEqual(calls.filter((c) => c[1] === 'Set').length, 2, 'две быстрые смены — одна установка');
    assert.strictEqual(fs.readdirSync(path.join(dir, 'wallpapers')).filter((f) => f.startsWith('lumen-')).length, 1, 'старые картинки удаляются');
    await wp.configure(false);
    const r = calls.find((c) => c[1] === 'Restore');
    assert.deepStrictEqual([r[3], r[5]], [backup.copy, '2'], 'возврат прежних обоев и стиля');
    assert.ok(!wp.hasBackup());
  });


  await test('стили обоев: каждый рисуется, они разные, у разных тем разная композиция', () => {
    const { STYLES } = require('../src/main/wallpaper');
    const pngs = {};
    for (const st of Object.keys(STYLES).filter((x) => x !== 'live' && x !== 'photo')) {
      const r = renderWallpaper({ colors: ['#ff2bd6', '#00e5ff'], effect: 'wave', width: 160, height: 90, style: st });
      assert.strictEqual(r.png.slice(1, 4).toString(), 'PNG', st);
      pngs[st] = r.png.toString('base64');
    }
    assert.strictEqual(new Set(Object.values(pngs)).size, Object.keys(pngs).length, 'все стили выглядят по-разному');
    const a = renderWallpaper({ colors: ['#ff0000', '#00ff00'], effect: 'wave', width: 160, height: 90, style: 'shapes' }).png.toString('base64');
    const b = renderWallpaper({ colors: ['#0000ff', '#ffff00'], effect: 'wave', width: 160, height: 90, style: 'shapes' }).png.toString('base64');
    assert.notStrictEqual(a, b);
    const core = new Core({ dataDir: tmp() });
    core.setSettings({ winWallpaperStyle: 'ribbons' });
    assert.strictEqual(core.state.settings.winWallpaperStyle, 'ribbons');
    core.setSettings({ winWallpaperStyle: 'нет' });
    assert.strictEqual(core.state.settings.winWallpaperStyle, 'ribbons');
    core.shutdown();
  });


  await test('живые волны: включаются со стилем, получают цвета темы, под ними — обычные волны', async () => {
    const live = new (require('events').EventEmitter)();
    const calls = [];
    Object.assign(live, { available: true, status: { state: 'off', message: '' }, configure: (on) => calls.push(['cfg', on]), setTheme: (t) => calls.push(['theme', t]), shutdown: () => calls.push(['bye']) });
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'lumen-settings.json'), JSON.stringify({ settings: { winWallpaperStyle: 'ai' } }));
    const core = new Core({ dataDir: dir, live, platform: 'linux' });
    assert.strictEqual(core.state.settings.winWallpaperStyle, 'live', 'старый стиль «Нейросеть» заменён живыми волнами');
    core.setSettings({ winWallpaper: true, winWallpaperStyle: 'live' });
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'cfg').pop(), ['cfg', true]);
    core.applyTheme('ocean');
    const th = calls.filter((c) => c[0] === 'theme').pop()[1];
    assert.deepStrictEqual(th.colors, core.effective().colors);
    core.setSettings({ winWallpaperStyle: 'ribbons' });
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'cfg').pop(), ['cfg', false], 'другой стиль — живые обои выключаются');
    await core.finalize();
    assert.ok(calls.some((c) => c[0] === 'bye'));
    const a = renderWallpaper({ colors: ['#ff2bd6', '#00e5ff'], effect: 'wave', width: 160, height: 90, style: 'live' }).png.toString('base64');
    const b = renderWallpaper({ colors: ['#ff2bd6', '#00e5ff'], effect: 'wave', width: 160, height: 90, style: 'waves' }).png.toString('base64');
    assert.strictEqual(a, b, 'обычная картинка под живыми обоями совпадает с «Волнами»');
  });

  await test('подсветка памяти: разрешение один раз, дальше движок через задачу, отказ ничего не ломает', async () => {
    const dir = tmp();
    const exe = path.join(dir, 'OpenRGB.exe');
    fs.writeFileSync(exe, '');
    const ae = new (require('events').EventEmitter)();
    let ok = false, inst = false;
    const calls = [];
    Object.assign(ae, { available: true, status: { state: 'off', message: '' },
      installed: () => inst,
      setup: async () => { calls.push('setup'); if (ok) inst = true; return ok ? { ok: true } : { ok: false, message: 'Ты отменил' }; },
      start: async (port) => { calls.push('start:' + port); return true; },
      stop: () => calls.push('stop') });
    const core = new Core({ dataDir: dir, adminEngine: ae, bundledEngine: exe, platform: 'linux' });
    let r = await core.setEngineAdmin(true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(core.state.settings.engineAdmin, false, 'отказ — остаётся как было');
    ok = true;
    r = await core.setEngineAdmin(true);
    assert.ok(r.ok && core.state.settings.engineAdmin);
    assert.ok(core.conn.admin.on, 'интерфейс знает, что включено');
    const l = core.launchOpenRGB();
    assert.ok(l.admin, 'движок запускается через задачу');
    await wait(10);
    assert.ok(calls.includes('start:6742'));
    await core.setEngineAdmin(false);
    assert.ok(calls.includes('stop') && !core.state.settings.engineAdmin);
    core.shutdown();
  });

  await test('погода: если Open-Meteo ограничил запросы — берём MET Norway, потом wttr.in; рабочий сервис спрашиваем первым', async () => {
    const { WidgetFeed } = require('../src/main/widgets');
    const metno = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-metno.json'), 'utf8'));
    const wttr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-wttr.json'), 'utf8'));
    const hits = [];
    let down = new Set(['api.open-meteo.com']);
    const fetchImpl = async (u, opts) => {
      const host = new URL(u).host;
      hits.push(host);
      assert.ok(/Lumen/.test(opts.headers['User-Agent']), 'сервисы просят представиться');
      if (down.has(host)) return { ok: false, status: 429, json: async () => ({}) };
      if (host.startsWith('geocoding')) return { ok: true, status: 200, json: async () => ({ results: [{ name: 'Москва', latitude: 55.75, longitude: 37.62 }] }) };
      if (host === 'api.met.no') return { ok: true, status: 200, json: async () => metno };
      if (host === 'wttr.in') return { ok: true, status: 200, json: async () => wttr };
      throw new Error('неожиданный адрес ' + u);
    };
    const feed = new WidgetFeed({ sensors: { data: {} }, fetchImpl });
    feed.cfg = { city: 'Москва', lang: 'ru' };
    await feed._weather();
    let w = feed.data.weather;
    assert.ok(!w.error, w.error);
    assert.strictEqual(w.source, 'metno');
    assert.ok(Number.isFinite(w.temp) && w.text && w.days.length === 3 && w.days.every((d) => /^\d{4}-\d\d-\d\d$/.test(d.date) && Number.isFinite(d.max)), JSON.stringify(w));
    // в следующий раз Open-Meteo уже не дёргаем
    hits.length = 0;
    await feed._weather();
    assert.strictEqual(hits[0], 'api.met.no');
    // MET Norway тоже лёг — wttr.in
    down = new Set(['api.open-meteo.com', 'api.met.no']);
    await feed._weather();
    w = feed.data.weather;
    assert.strictEqual(w.source, 'wttr');
    assert.ok(w.city === 'Москва' && Number.isFinite(w.temp) && w.days.length >= 2 && w.humidity != null, JSON.stringify(w));
    // все лежат: свежие данные не стираем, а через час — понятная ошибка
    down = new Set(['api.open-meteo.com', 'api.met.no', 'wttr.in']);
    await feed._weather();
    assert.strictEqual(feed.data.weather.source, 'wttr', 'свежая погода осталась');
    feed.data.weather.at -= 2 * 3600000;
    await feed._weather();
    assert.ok(/подождать|ответил/.test(feed.data.weather.error), feed.data.weather.error);
    // геокодер Open-Meteo недоступен — город ищем через OpenStreetMap
    const f2 = new WidgetFeed({ sensors: { data: {} }, fetchImpl: async (u) => {
      const host = new URL(u).host;
      if (host.startsWith('geocoding') || host === 'api.open-meteo.com') return { ok: false, status: 503, json: async () => ({}) };
      if (host === 'nominatim.openstreetmap.org') return { ok: true, status: 200, json: async () => [{ name: 'Казань', lat: '55.79', lon: '49.12' }] };
      if (host === 'api.met.no') { assert.ok(u.includes('lat=55.790')); return { ok: true, status: 200, json: async () => metno }; }
      throw new Error(u);
    } });
    f2.cfg = { city: 'Казань', lang: 'ru' };
    await f2._weather();
    assert.strictEqual(f2.data.weather.city, 'Казань');
    const { metCode, wwoCode } = require('../src/main/widgets');
    assert.deepStrictEqual([metCode('clearsky_night'), metCode('heavyrainandthunder'), metCode('lightsnowshowers_day'), wwoCode('113'), wwoCode(389), wwoCode('338')], [0, 95, 71, 0, 95, 75]);
  });

  await test('уведомления: вспышка заметна на любой подсветке (контрастный цвет и затемнение перед вспышкой)', async () => {
    const { pickFlashColor, deltaE } = require('../src/main/contrast');
    const blue = [88, 101, 242]; // Discord
    assert.deepStrictEqual(pickFlashColor(blue, [[255, 0, 0], [255, 80, 0]], 'auto'), blue, 'на красном синий и так видно');
    const onBlue = pickFlashColor(blue, [[60, 90, 255], [255, 255, 255]], 'auto');
    assert.ok(deltaE(onBlue, [60, 90, 255]) > 60 && deltaE(onBlue, [255, 255, 255]) > 60, 'на бело-синей — непохожий цвет: ' + onBlue);
    assert.deepStrictEqual(pickFlashColor(blue, [[60, 90, 255]], 'app'), blue, 'режим «всегда цвет приложения»');
    assert.deepStrictEqual(pickFlashColor(blue, [[255, 0, 0]], 'auto', true), [255, 255, 255], 'радуга — белый');
    const core = new Core({ dataDir: tmp() });
    core.setState({ power: true, effect: 'static', colors: ['#3c5aff', '#ffffff'], brightness: 100 });
    core.setSettings({ notify: { mode: 'contrast' } });
    assert.strictEqual(core.state.settings.notify.mode, 'contrast');
    core.setSettings({ notify: { mode: 'взлом' } });
    assert.strictEqual(core.state.settings.notify.mode, 'contrast', 'чужое значение не принимаем');
    assert.ok(core.flash('#5865f2'));
    const f = core.flashFx;
    assert.ok(deltaE(f.rgb, [60, 90, 255]) > 60, 'вспышка не синяя: ' + f.rgb);
    const out = new Uint8Array([60, 90, 255]);
    core._applyFlash(out, f, f.t0 + 60);
    assert.ok(out[2] < 120, 'в начале — затемнение: ' + out);
    const out2 = new Uint8Array([60, 90, 255]);
    core._applyFlash(out2, f, f.t0 + f.ms * 0.29);
    assert.ok(deltaE([out2[0], out2[1], out2[2]], f.rgb) < 15, 'в середине — цвет вспышки: ' + out2);
    core.shutdown();
  });

  await test('сейчас играет: строчка текста по времени трека, кнопки плеера из окна и с телефона', async () => {
    const { Lyrics, parseLrc, cleanTitle } = require('../src/main/lyrics');
    assert.deepStrictEqual(parseLrc('[00:01.50] Первая\n[00:04.2]Вторая\n[01:00.000][01:10.00] Припев\nбез времени'), [{ t: 1500, text: 'Первая' }, { t: 4200, text: 'Вторая' }, { t: 60000, text: 'Припев' }, { t: 70000, text: 'Припев' }]);
    assert.deepStrictEqual(['Song (Remastered 2011)', 'Track - Live at Wembley', 'Hit feat. Someone', 'Обычная'].map(cleanTitle), ['Song', 'Track', 'Hit', 'Обычная']);
    const urls = [];
    const ly = new Lyrics({ fetchImpl: async (u, o) => {
      urls.push(u);
      assert.ok(/Lumen/.test(o.headers['User-Agent']));
      if (u.includes('/api/get')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [{ duration: 500, syncedLyrics: '[00:01.00] не та длина' }, { duration: 200, syncedLyrics: '[00:00.50] Строка один\n[00:03.00] Строка два' }] };
    } });
    const lines = await ly.get({ artist: 'Тест', title: 'Песня (Remastered)', dur: 201000 });
    assert.deepStrictEqual(lines.map((l) => l.text), ['Строка один', 'Строка два'], 'взяли вариант с подходящей длительностью');
    assert.ok(urls[0].includes('track_name=%D0%9F%D0%B5%D1%81%D0%BD%D1%8F&') && urls[0].includes('duration=201'));
    await ly.get({ artist: 'Тест', title: 'Песня (Remastered)', dur: 201000 });
    assert.strictEqual(urls.length, 2, 'второй раз — из кэша');
    const offline = new Lyrics({ fetchImpl: async () => { throw new Error('fetch failed'); } });
    assert.strictEqual(await offline.get({ artist: 'a', title: 'b' }), null, 'нет сети — null, не кэшируем');

    // ядро: трек -> данные виджета, текст, кнопки
    const ctl = [];
    const media = Object.assign(new (require('events').EventEmitter)(), { start() {}, stop() {}, control: async (w) => { ctl.push(w); return true; }, status: { state: 'off' } });
    const core = new Core({ dataDir: tmp(), media });
    core.lyrics = ly;
    core.setSettings({ widgets: { enabled: true, media: true, lyrics: true }, remote: { enabled: false } });
    const np = [];
    core.on('nowplaying', (n) => np.push(n));
    media.emit('track', { playing: true, title: 'Песня (Remastered)', artist: 'Тест', app: 'Spotify.exe', cover: '', pos: 1000, dur: 201000, at: Date.now(), colors: null });
    await wait(50);
    const d = core.widgetFeed.data;
    assert.strictEqual(d.media.title, 'Песня (Remastered)');
    assert.deepStrictEqual(d.lyrics && d.lyrics.lines.map((l) => l.t), [500, 3000]);
    assert.strictEqual(d.lyrics.key, 'Тест|Песня (Remastered)');
    assert.strictEqual(np.length, 1);
    media.emit('track', { playing: true, title: 'Песня (Remastered)', artist: 'Тест', app: 'Spotify.exe', cover: '', pos: 4000, dur: 201000, at: Date.now() });
    assert.strictEqual(np.length, 1, 'позиция в треке не дёргает окно');
    media.emit('track', { playing: false, title: 'Песня (Remastered)', artist: 'Тест', app: 'Spotify.exe', cover: '', pos: 4000, dur: 201000, at: Date.now() });
    assert.strictEqual(np.length, 2, 'пауза — в окне меняется кнопка');
    assert.strictEqual(core.widgetFeed.data.media, null, 'на паузе виджет прячется');
    assert.strictEqual(core._remoteState().media.playing, false);
    assert.ok(core._remoteAct({ media: 'next' }));
    assert.ok(!core._remoteAct({ media: 'rm -rf' }));
    await core.mediaControl('play');
    assert.deepStrictEqual(ctl, ['next', 'play']);
    core.shutdown();
  });

  await test('Lian Li UNI FAN TL: мост находит вентиляторы, Lumen красит каждый своим цветом, подсказка прячется', async () => {
    const { LianLiTL, portDevices, colorLine } = require('../src/main/tlfan');
    const devs = portDevices([3, 0, 1, 0]);
    assert.deepStrictEqual(devs.map((d) => [d.id, d.fans, d.leds.length]), [['lianli:tl:0', 3, 3], ['lianli:tl:2', 1, 1]]);
    assert.strictEqual(colorLine(devs, new Map([['lianli:tl:0', Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255])], ['lianli:tl:2', Uint8Array.from([1, 2, 3])]])), 'ff000000ff000000ff010203');
    const dir = tmp();
    const log = path.join(dir, 'tl.log');
    process.env.TLFAN_LOG = log;
    const lianli = new LianLiTL({ dataDir: dir, command: process.execPath, args: [path.join(__dirname, 'mock-tlfan.js')] });
    const core = new Core({ dataDir: dir, lianli, platform: 'win32', hooks: { listUsb: async () => new Set(['0416:7372']), listProcesses: async () => new Set() } });
    core.setSettings({ autoConnect: false, launchOpenrgb: false, nativeEnabled: false });
    core.start();
    const h0 = await core.checkHealth();
    assert.deepStrictEqual(h0.unsupported, [], 'пока мост запускается, подсказку не показываем');
    assert.ok(await until(() => core.devices.filter((d) => d.source === 'lianli').length === 2), 'вентиляторы появились: ' + core.devices.map((d) => d.name));
    assert.ok(!core.devices.some((d) => d.vendor === 'Demo' || /демо/i.test(d.name)), 'демо-устройства убраны');
    core.setState({ power: true, effect: 'static', colors: ['#00ff00'], brightness: 100 });
    assert.ok(await until(() => fs.existsSync(log) && /^C (00ff00){4}$/m.test(fs.readFileSync(log, 'utf8'))), 'зелёный ушёл на все 4 вентилятора: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
    assert.deepStrictEqual((await core.checkHealth()).unsupported, []);
    core.shutdown();
    await wait(200);
    assert.ok(/^Q$/m.test(fs.readFileSync(log, 'utf8')), 'при выходе мост закрывается');
    delete process.env.TLFAN_LOG;
  });

  await test('зоны ARGB: без размера Lumen ставит 40 сам, случайные «1–2» исправляет, подсказка про Lian Li TL', async () => {
    const { parseUsbIds, findUnsupported } = require('../src/main/health');
    const ids = parseUsbIds('USB\\VID_0416&PID_7372&MI_00\\9&1\r\nHID\\VID_0B05&PID_19AF&MI_02\\a');
    assert.ok(ids.has('0416:7372') && ids.has('0b05:19af'));
    assert.deepStrictEqual(findUnsupported(ids).map((u) => u.id), ['lianli-tl']);
    assert.deepStrictEqual(findUnsupported(ids, ['lianli-tl']), [], 'после «Понятно» не показываем');
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'lumen-settings.json'), JSON.stringify({ zoneSizes: { 'orgb:B|x|Header 1': 1, 'orgb:B|x|Header 2': 30 } }));
    // мост Lian Li не запускаем (это проверяет отдельный тест) — здесь только подсказка
    const core = new Core({ dataDir: dir, platform: 'linux', lianli: new (require('../src/main/tlfan').LianLiTL)({ dataDir: dir, platform: 'linux' }), hooks: { listUsb: async () => ids, listProcesses: async () => new Set() } });
    assert.deepStrictEqual(core.state.zoneSizes, { 'orgb:B|x|Header 2': 30 }, 'случайную единицу сбросили, настоящий размер оставили');
    const calls = [];
    const client = { resizeZone: (...a) => calls.push(a) };
    const list = [{ index: 0, name: 'B', location: 'x', zones: [
      { name: 'Header 1', ledsCount: 1, ledsMin: 0, ledsMax: 500 },
      { name: 'Header 2', ledsCount: 0, ledsMin: 0, ledsMax: 500 },
      { name: 'Header 3', ledsCount: 0, ledsMin: 0, ledsMax: 500 },
      { name: 'Fixed', ledsCount: 1, ledsMin: 1, ledsMax: 1 },
    ] }];
    assert.ok(core._applyZoneSizes(client, list));
    assert.deepStrictEqual(calls, [[0, 0, 40], [0, 1, 30], [0, 2, 40]]);
    assert.ok(core.state.zoneAuto['orgb:B|x|Header 1'] && !core.state.zoneAuto['orgb:B|x|Header 2']);
    const h = await core.checkHealth();
    assert.strictEqual(h.unsupported[0].id, 'lianli-tl');
    core.hideHint('lianli-tl');
    assert.deepStrictEqual(core.health.unsupported, []);
    assert.deepStrictEqual((await core.checkHealth()).unsupported, []);
    core.shutdown();
  });

  await test('виджеты: погода по городу, нагрузка, ошибки понятные, настройки в порядке', async () => {
    const { WidgetFeed } = require('../src/main/widgets');
    const urls = [];
    let net = true;
    const fetchImpl = async (u) => {
      urls.push(u);
      if (!net) throw new Error('fetch failed');
      if (u.includes('geocoding')) return { ok: true, json: async () => ({ results: [{ name: 'Москва', latitude: 55.75, longitude: 37.62 }] }) };
      return { ok: true, json: async () => ({ current: { temperature_2m: 4.6, apparent_temperature: 1.2, weather_code: 3, wind_speed_10m: 4.4, is_day: 1 }, daily: { temperature_2m_max: [7], temperature_2m_min: [1] } }) };
    };
    const feed = new WidgetFeed({ sensors: { data: { ok: true, gpuLoad: 17, gpuTemp: 41 } }, fetchImpl });
    const got = [];
    feed.on('data', (d) => got.push(JSON.parse(JSON.stringify(d))));
    feed.configure({ enabled: true, clock: true, weather: true, system: true, city: 'Москва' });
    await wait(1200);
    const last = got[got.length - 1];
    assert.deepStrictEqual([last.weather.city, last.weather.temp, last.weather.text, last.weather.max], ['Москва', 5, 'Пасмурно', 7]);
    assert.ok(last.cpu >= 0 && last.cpu <= 100 && last.ramTotal > 0, 'загрузка процессора и памяти');
    assert.deepStrictEqual([last.gpu, last.gpuTemp], [17, 41]);
    assert.ok(feed.needsGpu);
    feed.setPaused(true);
    assert.ok(!feed.needsGpu, 'на паузе видеокарту не опрашиваем');
    net = false;
    feed.configure({ enabled: true, weather: true, city: 'Тверь' });
    feed.setPaused(false);
    await wait(700);
    assert.ok(/нет интернета/.test(feed.data.weather.error), feed.data.weather.error);
    feed.configure({ enabled: true, weather: true, city: '' });
    await wait(700);
    assert.ok(/Укажи город/.test(feed.data.weather.error));
    feed.stop();
    const core = new Core({ dataDir: tmp() });
    core.setSettings({ widgets: { enabled: true, city: '<b>Казань</b>', corner: 'нет', clock: 'да' } });
    const w = core.state.settings.widgets;
    assert.deepStrictEqual([w.enabled, w.clock, w.city, w.corner, w.size], [true, true, 'bКазань/b', 'tr', 'm']);
    core.setSettings({ widgets: { items: { net: false, vram: true }, size: 'l' } });
    core.setSettings({ widgets: { style: 'neon', opacity: 'взлом', clockStyle: 'mono', accent: 'white', media: true, calendar: true, note: true, noteText: '<script>x</script> попить воды' } });
    const w2 = core.state.settings.widgets;
    assert.deepStrictEqual([w2.style, w2.opacity, w2.clockStyle, w2.accent, w2.media, w2.calendar, w2.note, w2.noteText], ['neon', 'mid', 'mono', 'white', true, true, true, 'scriptx/script попить воды']);
    assert.deepStrictEqual([core.state.settings.widgets.items.net, core.state.settings.widgets.items.vram, core.state.settings.widgets.items.cpu, core.state.settings.widgets.size], [false, true, true, 'l'], 'по одному пункту, остальное не трогаем');
    core.shutdown();
    core.widgetFeed.stop();
  });

  await test('языки: словарь, составные фразы, выбор языка, без русских остатков в каталоге', () => {
    const I = require('../src/shared/i18n');
    const en = I.makeTranslator('en'), uk = I.makeTranslator('uk');
    assert.strictEqual(en.t('Подсветка'), 'Lighting');
    assert.strictEqual(en.t('Найдено: 3 устройства'), 'Found: 3 devices');
    assert.strictEqual(en.t('17% · 41 °C · 32 Вт'), '17% · 41 °C · 32 W');
    assert.strictEqual(en.t('Удалить тему «Мой вечер»?'), 'Delete theme “Мой вечер”?', 'имена пользователя не трогаем');
    assert.strictEqual(uk.t('Подсветка'), 'Підсвітка');
    assert.strictEqual(I.makeTranslator('ru').t('Подсветка'), 'Подсветка');
    assert.deepStrictEqual([I.resolve('auto', 'uk-UA'), I.resolve('auto', 'fr-FR'), I.resolve('auto', 'ru-RU'), I.resolve('de', 'ru-RU'), I.resolve('auto', '')], ['uk', 'en', 'ru', 'de', 'ru']);
    // все темы, эффекты и стили обоев переведены на все языки
    const { THEMES } = require('../src/shared/catalog');
    const { EFFECTS } = require('../src/shared/effects');
    const { STYLES } = require('../src/main/wallstyles');
    const texts = [...THEMES.flatMap((t) => [t.name, t.tagline]), ...Object.values(EFFECTS).flatMap((e) => [e.name, e.desc]), ...Object.values(STYLES).flatMap((x) => [x.name, x.desc])];
    for (const lang of ['en', 'uk', 'de', 'es']) {
      const tr = I.makeTranslator(lang);
      const bad = texts.filter((x) => tr.map[x] === undefined);
      assert.deepStrictEqual(bad, [], lang + ': нет перевода');
    }
    const core = new Core({ dataDir: tmp(), hooks: { getLocale: () => 'de-DE' } });
    assert.strictEqual(core.lang(), 'de');
    let ev = null;
    core.on('lang', (l) => { ev = l; });
    core.setSettings({ language: 'es' });
    assert.deepStrictEqual([core.lang(), ev], ['es', 'es']);
    core.setSettings({ language: 'xx' });
    assert.strictEqual(core.state.settings.language, 'es');
    assert.strictEqual(core.getInit().lang, 'es');
    core.shutdown();
    core.widgetFeed.stop();
  });

  await test('конфликты и пропавшие устройства: находит SignalRGB, помнит свои устройства, считает пропажи', async () => {
    const H = require('../src/main/health');
    const names = H.parseTasklist('"System","4","Services","0","1 K"\r\n"SignalRgb.exe","120","Console","1","200 K"\r\n"lghub.exe","5","Console","1","1 K"');
    assert.deepStrictEqual(H.findConflicts(names).map((c) => c.id), ['signalrgb', 'ghub']);
    const known = H.mergeKnown([], [{ name: 'ENE DRAM', source: 'openrgb', kind: 'ram' }, { name: 'ASRock B650E', source: 'openrgb' }, { name: 'PRO WIRELESS', source: 'native' }]);
    assert.deepStrictEqual(H.missingDevices(known, [{ name: 'ASRock B650E', source: 'openrgb' }]).map((d) => d.name), ['ENE DRAM', 'PRO WIRELESS']);
    const core = new Core({ dataDir: tmp(), hooks: { listProcesses: async () => names, killProcesses: async () => true } });
    const h = await core.checkHealth();
    assert.strictEqual(h.conflicts[0].name, 'SignalRGB');
    const r = await core.closeConflict('signalrgb');
    assert.ok(r.ok);
    core.shutdown(); core.widgetFeed.stop();
  });

  await test('уведомления: вспышка цветом приложения, только для выбранных, не чаще раза в секунду', () => {
    const { classify } = require('../src/main/notify');
    assert.strictEqual(classify('com.squirrel.Discord.Discord').id, 'discord');
    assert.strictEqual(classify('TelegramDesktop.TelegramDesktop').id, 'telegram');
    assert.strictEqual(classify('Microsoft.WindowsStore').id, 'other');
    const notify = new (require('events').EventEmitter)();
    Object.assign(notify, { available: true, status: { state: 'off', message: '' }, start() {}, stop() {} });
    const core = new Core({ dataDir: tmp(), notify });
    notify.emit('notification', { app: 'discord', color: '#5865f2' });
    assert.ok(!core.flashFx, 'выключено — не мигаем');
    core.setSettings({ notify: { enabled: true, apps: { steam: true, other: false } } });
    notify.emit('notification', { app: 'discord', color: '#5865f2' });
    assert.deepStrictEqual(core.flashFx.rgb, [88, 101, 242]);
    const t0 = core.flashFx.t0;
    notify.emit('notification', { app: 'telegram', color: '#2aabee' });
    assert.strictEqual(core.flashFx.t0, t0, 'пачка уведомлений — одна вспышка');
    core.flashFx = null;
    notify.emit('notification', { app: 'other', color: null });
    assert.ok(!core.flashFx, 'другие приложения выключены');
    assert.strictEqual(core.state.settings.notify.apps.steam, true);
    // вспышка действительно окрашивает кадр
    core.flash('#ff0000'); core.flashFx.t0 = Date.now() - 400;
    core.tick();
    const any = Object.values(core.frames).some((f) => f[0] > 150 && f[1] < 120);
    assert.ok(any, 'кадр стал красным');
    core.shutdown(); core.widgetFeed.stop();
  });

  await test('цвета под музыку: палитра из обложки, подсветка берёт её, обои — нет', () => {
    const { coverPalette } = require('../src/main/media');
    const px = [];
    for (let i = 0; i < 300; i++) px.push(230, 30, 40, 255);   // красная обложка
    for (let i = 0; i < 100; i++) px.push(20, 60, 230, 255);   // немного синего
    for (let i = 0; i < 200; i++) px.push(4, 4, 4, 255);       // чёрный фон
    const pal = coverPalette(Buffer.from(px));
    assert.strictEqual(pal.length, 2);
    assert.ok(parseInt(pal[0].slice(1, 3), 16) > 200, 'первым — красный: ' + pal);
    const media = new (require('events').EventEmitter)();
    Object.assign(media, { available: true, status: { state: 'ok', message: '' }, track: { playing: false, colors: null }, start() {}, stop() {} });
    const core = new Core({ dataDir: tmp(), media });
    core.setSettings({ musicColors: true });
    media.track = { playing: true, colors: ['#ff0000', '#0000ff'], app: 'Spotify.exe' };
    media.emit('track', media.track);
    assert.deepStrictEqual(core.effective().colors, ['#ff0000', '#0000ff']);
    assert.notDeepStrictEqual(core.effective({ noCover: true }).colors, ['#ff0000', '#0000ff']);
    media.track = { playing: false, colors: ['#ff0000'] };
    assert.notDeepStrictEqual(core.effective().colors, ['#ff0000'], 'музыка на паузе — обычные цвета');
    core.shutdown(); core.widgetFeed.stop();
  });

  await test('пульт с телефона: ключ обязателен, команды работают, QR читается', async () => {
    const { qrMatrix } = require('../src/main/qr');
    const m = qrMatrix('http://192.168.1.5:47800/?t=abcdefghijklmnopqrstuv');
    assert.strictEqual(m.length, 33);
    const core = new Core({ dataDir: tmp() });
    core.state.settings.remote.port = 47831;
    core.setSettings({ remote: { enabled: true } });
    await wait(300);
    const tok = core.state.settings.remote.token, base = 'http://127.0.0.1:47831';
    assert.strictEqual((await fetch(base + '/api/state?t=nope')).status, 403);
    const r = await (await fetch(base + '/api/act?t=' + tok, { method: 'POST', body: JSON.stringify({ theme: 'lava' }) })).json();
    assert.ok(r.ok && core.state.themeId === 'lava');
    assert.strictEqual((await fetch(base + '/api/act?t=' + tok, { method: 'POST', body: '{"rm":"-rf"}' })).status, 400);
    const page = await (await fetch(base + '/?t=' + tok)).text();
    assert.ok(page.includes('Яркость') && !/__[A-Z]+__/.test(page));
    core.newRemoteLink();
    assert.notStrictEqual(core.state.settings.remote.token, tok, 'новая ссылка — старый ключ не работает');
    await wait(200);
    assert.strictEqual((await fetch(base + '/api/state?t=' + tok)).status, 403);
    core.shutdown(); core.widgetFeed.stop();
  });

  await test('отчёт о проблеме: zip читается, личное скрыто', async () => {
    const { buildReport } = require('../src/main/bugreport');
    const dir = tmp();
    const core = new Core({ dataDir: dir });
    core.setSettings({ widgets: { city: 'Казань' } });
    core.state.settings.remote.token = 'TOPSECRETTOKEN123456';
    const log = path.join(dir, 'lumen.log');
    fs.writeFileSync(log, `C:\\Users\\${require('os').userInfo().username}\\x ?t=TOPSECRETTOKEN123456`);
    const r = await buildReport({ core, logFile: log, dataDir: dir, outDir: dir, description: 'нет памяти', withHardware: false });
    const zip = fs.readFileSync(r.file);
    assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
    const all = zip.toString('latin1');
    assert.ok(!all.includes('TOPSECRET'), 'ключ не попал');
    assert.ok(r.files.includes('00-сводка.txt') && r.files.includes('lumen.log'));
    core.shutdown(); core.widgetFeed.stop();
  });

  await test('автообновление: видит новую версию, скачивает, сверяет SHA-256, испорченный файл не берёт', async () => {
    const { Updater, newer } = require('../src/main/updater');
    assert.ok(newer('2.10.0', '2.9.3') && !newer('v2.8.0', '2.8.0') && !newer('2.7.9', '2.8.0'));
    const crypto = require('crypto');
    const exe = Buffer.from('MZ fake installer ' + 'x'.repeat(5000));
    let good = true;
    const sha = crypto.createHash('sha256').update(exe).digest('hex');
    const fetchImpl = async (url) => {
      if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v2.9.0', body: 'Что нового', html_url: 'https://github.com/x/y/releases/v2.9.0',
        assets: [{ name: 'Lumen-Setup-2.9.0.exe', size: exe.length, digest: 'sha256:' + sha, browser_download_url: 'https://github.com/x/y/releases/download/v2.9.0/Lumen-Setup-2.9.0.exe' }] }), { status: 200 });
      return new Response(good ? exe : Buffer.concat([exe, Buffer.from('!')]), { status: 200, headers: { 'content-length': String(exe.length) } });
    };
    const dir = tmp();
    const u = new Updater({ repo: 'x/y', version: '2.8.0', dataDir: dir, fetchImpl, platform: 'win32' });
    let st = await u.check({ download: true });
    assert.strictEqual(st.state, 'ready', JSON.stringify(st));
    assert.strictEqual(st.version, '2.9.0');
    assert.ok(fs.existsSync(path.join(dir, 'updates', 'Lumen-Setup-2.9.0.exe')));
    good = false;
    fs.rmSync(path.join(dir, 'updates'), { recursive: true, force: true });
    st = await new Updater({ repo: 'x/y', version: '2.8.0', dataDir: dir, fetchImpl, platform: 'win32' }).check({ download: true });
    assert.strictEqual(st.state, 'error');
    assert.ok(/контрольная сумма/.test(st.message), st.message);
    st = await new Updater({ repo: 'x/y', version: '2.9.0', dataDir: dir, fetchImpl, platform: 'win32' }).check();
    assert.strictEqual(st.state, 'latest');
  });

  console.log('Сценарии');
  await test('правила: игра → тема, расписание через полночь, блокировка и простой гасят', () => {
    const exists = (id) => ['gamer', 'night'].includes(id);
    const sc = sanitizeScenarios({
      apps: [{ exe: 'C:\\Games\\CS2.EXE', themeId: 'gamer' }, { exe: 'x.exe', themeId: 'нет' }, { exe: 'плохое имя<>', themeId: 'gamer' }],
      schedule: [{ from: '23:00', to: '07:00', mode: 'off' }, { from: '18:00', to: '23:00', mode: 'theme', themeId: 'night' }, { from: '25:00', to: '07:00', mode: 'off' }],
      offOnLock: true, idleMinutes: 10,
    }, exists);
    assert.deepStrictEqual(sc.apps, [{ exe: 'cs2.exe', themeId: 'gamer' }]);
    assert.strictEqual(sc.schedule.length, 2);
    const at = (h, m) => { const d = new Date(2026, 9, 26, h, m); return d; };
    const ctx = (o) => ({ apps: new Set(), idleSec: 0, locked: false, now: at(12, 0), ...o });
    assert.strictEqual(evaluate(sc, ctx({})), null);
    assert.strictEqual(evaluate(sc, ctx({ apps: new Set(['cs2.exe']) })).themeId, 'gamer');
    assert.strictEqual(evaluate(sc, ctx({ now: at(2, 30) })).kind, 'off');
    assert.strictEqual(evaluate(sc, ctx({ now: at(23, 30) })).kind, 'off');
    assert.strictEqual(evaluate(sc, ctx({ now: at(20, 0) })).themeId, 'night');
    assert.strictEqual(evaluate(sc, ctx({ now: at(20, 0), apps: new Set(['cs2.exe']) })).themeId, 'gamer', 'игра важнее расписания');
    assert.strictEqual(evaluate(sc, ctx({ apps: new Set(['cs2.exe']), locked: true })).key, 'lock', 'блокировка важнее всего');
    assert.strictEqual(evaluate(sc, ctx({ idleSec: 601 })).key, 'idle');
  });
  await test('ядро: игра включает тему, ручное изменение ставит на паузу, после игры всё как было', () => {
    let now = new Date(2026, 9, 26, 12, 0);
    const core = new Core({ dataDir: tmp(), clock: () => now });
    core.applyTheme('ocean');
    core.setScenarios({ apps: [{ exe: 'cs2.exe', themeId: 'gamer' }], schedule: [{ from: '23:00', to: '07:00', mode: 'off' }], offOnLock: true });
    core.setRunningApps(['explorer.exe', 'CS2.exe']);
    assert.strictEqual(core.effective().effect, 'comet', 'включилась тема «Геймер»');
    assert.strictEqual(core.state.themeId, 'ocean', 'ручные настройки не тронуты');
    assert.ok(/cs2\.exe/.test(core.scenarioStatus().active.label));
    core.setState({ brightness: 40 });
    assert.strictEqual(core.effective().effect, 'comet', 'яркость не ставит сценарий на паузу');
    core.applyTheme('lava');
    assert.strictEqual(core.scenarioStatus().paused, true);
    assert.strictEqual(core.effective().effect, 'fire', 'ручной выбор темы важнее сценария');
    core.resumeScenario();
    assert.strictEqual(core.effective().effect, 'comet');
    core.setRunningApps(['explorer.exe']);
    assert.strictEqual(core.effective().effect, 'fire', 'игра закрылась — вернулась ручная тема');
    core.setLocked(true);
    assert.strictEqual(core.effective().power, false, 'блокировка гасит');
    core.setLocked(false);
    now = new Date(2026, 9, 26, 23, 30); core._evalScenarios();
    assert.strictEqual(core.effective().power, false, 'ночью по расписанию погашено');
    now = new Date(2026, 9, 27, 7, 1); core._evalScenarios();
    assert.strictEqual(core.effective().power, true);
    core.setSleeping(true);
    assert.ok(core.frames['demo:strip'].every((v) => v === 0), 'при уходе в сон сразу отправлен чёрный кадр');
    core.setSleeping(false);
    core.shutdown();
  });

  console.log('Быстрые действия, обмен темами, «Удиви меня»');
  await test('горячие клавиши: питание, темы по кругу, яркость', () => {
    const core = new Core({ dataDir: tmp() });
    assert.strictEqual(core.togglePower(), false);
    assert.strictEqual(core.togglePower(), true);
    core.applyTheme('cyberpunk');
    assert.strictEqual(core.cycleTheme(1).id, 'sunset');
    assert.strictEqual(core.cycleTheme(-1).id, 'cyberpunk');
    assert.strictEqual(core.cycleTheme(-1).id, THEMES[THEMES.length - 1].id, 'по кругу');
    core.setState({ brightness: 95 });
    assert.strictEqual(core.stepBrightness(10), 100);
    assert.strictEqual(core.stepBrightness(-30), 70);
    core.shutdown();
  });
  await test('код темы: туда-обратно, защита от мусора, добавление в «Мои»', () => {
    const t = { name: 'Вечер у <камина>', effect: 'wave', colors: ['#FF0000', '#00ff00'], speed: 40, direction: 'left' };
    const code = encodeTheme(t);
    assert.ok(code.startsWith('LUMEN1-') && !/[+/=\s]/.test(code.slice(7)));
    const back = decodeTheme('  ' + code + '\n', require('../src/shared/effects').EFFECTS);
    assert.deepStrictEqual(back, { name: 'Вечер у камина', effect: 'wave', colors: ['#ff0000', '#00ff00'], speed: 40, direction: 'left' });
    assert.throws(() => decodeTheme('привет', {}), /LUMEN1-/);
    assert.throws(() => decodeTheme('LUMEN1-@@@', {}), /повреждён/);
    const core = new Core({ dataDir: tmp() });
    const r = core.importTheme(code);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(core.state.customThemes.length, 1);
    assert.strictEqual(core.state.themeId, r.theme.id);
    assert.strictEqual(core.exportTheme(r.theme.id), encodeTheme(r.theme));
    assert.strictEqual(core.importTheme('LUMEN1-' + Buffer.from('{"e":"нет","c":["ff0000"]}').toString('base64')).ok, false);
    core.shutdown();
  });
  await test('«Удиви меня»: всегда валидная, разная и применяется', () => {
    const effects = require('../src/shared/effects').EFFECTS;
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const t = randomTheme();
      assert.ok(effects[t.effect], t.effect);
      assert.ok(t.colors.length >= 2 && t.colors.every((c) => /^#[0-9a-f]{6}$/.test(c)), t.colors.join());
      assert.ok(t.speed >= 25 && t.speed <= 70 && t.name.length > 3);
      seen.add(t.colors.join());
    }
    assert.ok(seen.size > 150, 'темы разные');
    const core = new Core({ dataDir: tmp() });
    const t = core.surprise();
    assert.strictEqual(core.state.effect, t.effect);
    assert.strictEqual(core.state.themeId, null);
    core.shutdown();
  });


  console.log('Исправления после проверки на настоящем железе');
  await test('«Цвет экрана»: у устройств с 1–2 светодиодами — средний цвет всего экрана', () => {
    const fx = require('../src/shared/effects');
    const data = [];
    for (let i = 0; i < 8; i++) data.push(...(i % 4 < 2 ? [200, 0, 0] : [0, 0, 200]));
    const dev = { id: 't', leds: [{ x: 0.5, y: 0.5 }], linear: true, aspect: 1 };
    const out = fx.renderDevice(dev, { effect: 'screen', pal: [[0, 0, 0]], direction: 'right', brightness: 100, screen: { w: 4, h: 2, data } }, 0, null, new Uint8Array(3));
    assert.deepStrictEqual([...out], [100, 0, 100], 'середина экрана тёмная не важна: берётся среднее');
  });
  await test('отчёт для диагностики: устройства, движок, оформление, без падений', () => {
    const core = new Core({ dataDir: tmp() });
    const logs = [];
    core.on('log', (m) => logs.push(m));
    const d = core.diagnostics();
    assert.ok(d.version && d.devices.length === 5);
    assert.ok(d.devices.every((x) => typeof x.leds === 'number' && Array.isArray(x.zones) && x.badLayout === false));
    assert.ok(d.look.effective.effect);
    assert.ok(JSON.stringify(d).length < 20000);
    core.setScenarios({ offOnLock: true });
    core.setLocked(true);
    assert.ok(logs.some((m) => /Сценарий: Компьютер заблокирован/.test(m)), 'события сценариев пишутся в журнал');
    core.shutdown();
  });

  mock.server.close();
  console.log(`\nПройдено: ${passed}, провалено: ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})();
