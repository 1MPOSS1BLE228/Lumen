'use strict';
// Прогон интерфейса в настоящем Chromium (Playwright). Мост window.lumen
// подключён к настоящему ядру Lumen и к поддельному серверу OpenRGB —
// как в Electron, только без Electron.
//   node test/ui-harness.js [папка-для-скриншотов]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const { Core } = require('../src/main/core');
const { NativeBackend } = require('../src/main/native');
const { WinTheme } = require('../src/main/wintheme');
const { startMock } = require('./mock-openrgb');

const outDir = process.argv[2] || path.join(os.tmpdir(), 'lumen-shots');
fs.mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const WITH_NATIVE = process.env.HARNESS_NATIVE === '1';
  const mock = await startMock();
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ui-'));
  const winCalls = [];
  const coreOpts = { dataDir: dir0, version: '1.1.0' };
  if (WITH_NATIVE) {
    process.env.LUMEN_MOCK_LOG = path.join(dir0, 'bridge.log');
    process.env.LUMEN_MOCK_MODE = 'normal';
    coreOpts.platform = 'win32';
    coreOpts.native = new NativeBackend({ dataDir: dir0, command: process.execPath, args: [path.join(__dirname, 'mock-bridge.js')] });
    coreOpts.wallpaper = new (require('../src/main/wallpaper').Wallpaper)({ dataDir: dir0, platform: 'win32', runner: async (a) => { winCalls.push(a); return a[1] === 'Read' ? JSON.stringify({ path: '', style: '10', tile: '0', jpeg: -1, transcoded: '' }) : '{"ok":true}'; }, getSize: () => ({ width: 2560, height: 1440 }) });
    coreOpts.wintheme = new WinTheme({ dataDir: dir0, platform: 'win32', runner: async (a) => { winCalls.push(a); return a[1] === 'Read' ? '{}' : '{"ok":true}'; } });
  }
  const core = new Core(coreOpts);
  core.setSettings({ autoConnect: false, launchOpenrgb: false, port: mock.port, tourDone: true });
  if (WITH_NATIVE) core.begin(); else core.start();

  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const handlers = {
    init: () => core.getInit(),
    setState: (p) => core.setState(p), applyTheme: (id) => core.applyTheme(id), saveTheme: (n) => core.saveTheme(n),
    deleteTheme: (id) => core.deleteTheme(id), renameTheme: (id, n) => core.renameTheme(id, n), updateTheme: (id) => core.updateTheme(id), setDeviceEnabled: (id, e) => core.setDeviceEnabled(id, e),
    setSettings: (p) => core.setSettings(p), connect: () => { core.disconnect(); return core.connect({ manual: true }); },
    setColorOrder: (i, z, o) => core.setColorOrder(i, z, o), setZoneSize: (i, z, n) => core.setZoneSize(i, z, n), testZone: (i, z) => core.testZone(i, z),
    disconnect: () => core.disconnect(), pickOpenRGB: () => null, launchOpenRGB: () => ({}), openExternal: () => true,
    openLightingSettings: () => { core.__lightingOpened = true; return true; }, rescanNative: () => { core.native.rescan(); return true; },
    exportTheme: (id) => { const c = core.exportTheme(id); core.__clipboard = c; return c; }, importTheme: (c) => core.importTheme(c), surprise: () => core.surprise(),
    setScenarios: (sc) => core.setScenarios(sc), resumeScenario: () => core.resumeScenario(), listApps: () => ['cs2.exe', 'discord.exe', 'vlc.exe'],
    mediaControl: (w) => { core.__media = (core.__media || []).concat(w); return true; },
    photoOptions: (pg) => core.photoOptions(pg), pickPhoto: (it) => core.pickPhoto(it), newRemoteLink: () => core.newRemoteLink(), flash: (c) => core.flash(c), restartEngine: () => true, closeConflict: () => ({ ok: true }), forgetMissing: () => true, checkHealth: () => core.checkHealth(), bugReport: () => ({ ok: true }),
    hotkeysInfo: () => ({ list: [{ keys: 'Ctrl+Alt+L', label: 'Включить или выключить подсветку' }, { keys: 'Ctrl+Alt+R', label: 'Удиви меня (случайная тема)' }], failed: ['Ctrl+Alt+R'] }),
  };
  await page.exposeFunction('__screen', (f) => { core.setScreen(f); core.__screenFrames = (core.__screenFrames || 0) + 1; });
  await page.exposeFunction('__call', async (name, args) => {
    const r = await handlers[name](...args);
    return r === undefined ? null : JSON.parse(JSON.stringify(r));
  });
  await page.exposeFunction('__audio', () => {});
  await page.addInitScript(() => {
    const subs = { nowplaying: [], remote: [], health: [], state: [], devices: [], conn: [], frames: [], native: [], wintheme: [], scenario: [], sensors: [], hotkeys: [] };
    const sub = (ch) => (cb) => { subs[ch].push(cb); return () => {}; };
    window.__push = (ch, data) => {
      if (ch === 'frames') for (const k of Object.keys(data)) data[k] = Uint8Array.from(data[k]);
      subs[ch].forEach((cb) => cb(data));
    };
    const call = (n) => (...a) => window.__call(n, a);
    // «Поддельный экран»: слева красный, справа синий — как будто это картинка монитора
    if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const x = c.getContext('2d');
      const draw = () => { x.fillStyle = '#ff1010'; x.fillRect(0, 0, 160, 180); x.fillStyle = '#1010ff'; x.fillRect(160, 0, 160, 180); };
      draw(); setInterval(draw, 100);
      return c.captureStream(15);
    };
    window.lumen = {
      init: call('init'), setState: call('setState'), applyTheme: call('applyTheme'), saveTheme: call('saveTheme'),
      deleteTheme: call('deleteTheme'), renameTheme: call('renameTheme'), updateTheme: call('updateTheme'), setDeviceEnabled: call('setDeviceEnabled'), setSettings: call('setSettings'),
      connect: call('connect'), disconnect: call('disconnect'), setColorOrder: call('setColorOrder'), setZoneSize: call('setZoneSize'), testZone: call('testZone'), pickOpenRGB: call('pickOpenRGB'),
      launchOpenRGB: call('launchOpenRGB'), openExternal: call('openExternal'), openLightingSettings: call('openLightingSettings'), rescanNative: call('rescanNative'),
      exportTheme: call('exportTheme'), importTheme: call('importTheme'), surprise: call('surprise'), setScenarios: call('setScenarios'), copyReport: async () => 1, openLog: async () => '', reportError: (m) => console.error('renderer:', m),
      photoOptions: call('photoOptions'), pickPhoto: call('pickPhoto'), newRemoteLink: call('newRemoteLink'), flash: call('flash'), restartEngine: call('restartEngine'), closeConflict: call('closeConflict'), forgetMissing: call('forgetMissing'), checkHealth: call('checkHealth'), bugReport: call('bugReport'), onRemote: sub('remote'), onNowPlaying: sub('nowplaying'), mediaControl: call('mediaControl'), onHealth: sub('health'), resumeScenario: call('resumeScenario'), listApps: call('listApps'), hotkeysInfo: call('hotkeysInfo'), sendScreen: (f) => window.__screen(f),
      sendAudio: (b) => window.__audio(b), setFramesWanted: () => {},
      onState: sub('state'), onDevices: sub('devices'), onConn: sub('conn'), onFrames: sub('frames'), onNative: sub('native'), onWinTheme: sub('wintheme'),
      onScenario: sub('scenario'), onSensors: sub('sensors'), onHotkeys: sub('hotkeys'),
    };
  });
  const push = (ch, data) => page.evaluate(([c, d]) => window.__push(c, d), [ch, data]).catch(() => {});
  core.on('state', (s) => push('state', s));
  core.on('devices', (d) => push('devices', d));
  core.on('conn', (c) => push('conn', c));
  core.on('native', (n) => push('native', n));
  core.on('wintheme', (w) => push('wintheme', w));
  core.on('scenario', (w) => push('scenario', w));
  core.on('sensors', (w) => push('sensors', w));
  core.on('remote', (w) => push('remote', w));
  core.on('health', (w) => push('health', w));
  let last = 0;
  core.on('frames', (f) => {
    if (Date.now() - last < 60) return;
    last = Date.now();
    const o = {};
    for (const k of Object.keys(f)) o[k] = Array.from(f[k]);
    push('frames', o);
  });

  await page.goto('file://' + path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await page.waitForSelector('.theme');
  const shot = async (name) => { await wait(450); await page.screenshot({ path: path.join(outDir, name + '.png') }); console.log('снимок', name); };
  const check = (cond, msg) => { if (!cond) { errors.push('ПРОВЕРКА: ' + msg); console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); };

  if (WITH_NATIVE) {
    await wait(1200);
    check(core.devices.length === 2 && core.devices.every((d) => d.source === 'native'), 'на сцене два устройства Windows вместо демо');
    check((await page.textContent('#pill-text')).includes('Устройств: 2'), 'в левом углу: «Устройств: 2»');
    await shot('n1-home');
    await page.click('.nav[data-page="devices"]');
    await wait(400);
    check((await page.textContent('.view, main, #view')).includes('Windows: устройства подключены'), 'на странице «Устройства» статус встроенного управления');
    await shot('n2-devices');
    await page.click('.nav[data-page="settings"]');
    await wait(400);
    check((await page.$$('input[data-set="winThemeEnabled"]')).length === 1, 'в настройках есть блок «Оформление Windows»');
    await shot('n3-settings');
    await page.click('input[data-widget="enabled"]').catch((e) => console.log('click err', e.message));
    await wait(500);
    check(core.state.settings.widgets.enabled === true, 'тумблер «Показывать виджеты» в интерфейсе включает виджеты');
    core.setSettings({ widgets: { city: 'Москва' } });
    await wait(500);
    const wg = await page.$('input[data-widget="city"]');
    check(!!wg, 'в настройках есть виджеты и поле города');
    if (wg) { await wg.scrollIntoViewIfNeeded(); await shot('n3b-widgets'); }
    core.setSettings({ widgets: { enabled: false } });
    await page.click('input[data-set="winForceDark"]');
    await page.click('input[data-set="winThemeEnabled"]');
    await wait(500);
    check(core.state.settings.winThemeEnabled === true && core.state.settings.winForceDark === true, 'тумблеры цвета Windows сохраняются');
    await page.click('.nav[data-page="home"]');
    await page.click('.theme[data-id="aurora"]');
    await wait(2200);
    const ap = winCalls.filter((c) => c[1] === 'Apply').pop();
    check(!!ap && ap.includes('-Dark'), 'после выбора темы цвет Windows применён вместе с тёмной темой: ' + (ap ? ap.slice(2).join(' ') : 'нет'));
    await page.click('.nav[data-page="settings"]');
    await wait(300);
    await page.click('input[data-set="winThemeEnabled"]');
    await wait(500);
    check(winCalls.some((c) => c[1] === 'Restore'), 'выключение тумблера возвращает прежнее оформление');
    await page.click('[data-act="open-lighting"]');
    await wait(200);
    check(core.__lightingOpened === true, 'кнопка «Открыть параметры Windows» вызывает системное действие');
    if (process.env.HARNESS_I18N === '1') {
      core.setSettings({ language: 'en', winWallpaper: true, winWallpaperStyle: 'photo', widgets: { enabled: true, items: { vram: true, uptime: true } } });
      await page.reload();
      await page.waitForSelector('.theme');
      const left = new Set();
      for (const pg of ['home', 'effects', 'devices', 'scenes', 'settings']) {
        await page.click(`.nav[data-page="${pg}"]`);
        await wait(1500);
        const t = await page.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (/[А-Яа-яЁё]/.test(n.nodeValue) && !n.parentNode.closest('[data-noi18n]')) out.push(n.nodeValue.trim()); for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v && /[А-Яа-яЁё]/.test(v)) out.push('@' + v); } return out; });
        t.forEach((x) => left.add(pg + ': ' + x));
      }
      console.log('НЕ ПЕРЕВЕДЕНО:\n' + [...left].join('\n'));
      core.setSettings({ language: 'ru', widgets: { enabled: false } });
      await page.reload();
      await page.waitForSelector('.theme');
    }
    if (process.env.HARNESS_PHOTOS === '1') {
      await page.click('.nav[data-page="home"]');
      core.setSettings({ winWallpaper: true, winWallpaperStyle: 'photo' });
      await page.waitForSelector('.ph img', { timeout: 30000 }).catch(() => {});
      await wait(800);
      const n = (await page.$$('.ph')).length;
      check(n >= 4, 'варианты фото под тему показаны: ' + n);
      await shot('16-photos');
      await page.click('.ph[data-i="1"]');
      await wait(400);
      const pk = Object.values(core.state.settings.photoPicks)[0];
      check(pk && /wallhaven/.test(pk.url), 'выбор фото сохранён для темы');
      await wait(20000);
      const set = winCalls.filter((c) => c[1] === 'Set').pop();
      check(set && pk && set[3].includes(pk.id), 'выбранное фото поставлено на рабочий стол: ' + (set && set[3]));
      await page.click('.theme[data-id="ocean"]');
      await wait(500);
      await page.waitForSelector('.ph img', { timeout: 30000 }).catch(() => {});
      await wait(800);
      await shot('17-photos-ocean');
    }
    console.log(errors.length ? '\nПроблемы:\n' + errors.join('\n') : '\nОшибок нет');
    await browser.close();
    await core.finalize();
    mock.server.close();
    process.exit(errors.length ? 1 : 0);
  }

  await wait(600);
  await shot('01-home');
  await page.setViewportSize({ width: 1000, height: 680 });
  await shot('01b-home-min');
  await page.setViewportSize({ width: 1180, height: 820 });
  await wait(300);
  check((await page.$$('.theme')).length === 19, '19 готовых тем на главной');
  check((await page.$$('canvas[data-dev]')).length === 5, '5 демо-устройств на сцене');

  // тема меняет эффект и палитру
  await page.click('.theme[data-id="lava"]');
  await wait(300);
  check(core.state.effect === 'fire' && core.state.themeId === 'lava', 'клик по теме «Лава» применил эффект «Огонь»');
  check(await page.$eval('.theme[data-id="lava"]', (e) => e.classList.contains('on')), 'карточка темы подсвечена как активная');
  await shot('02-lava');

  // ползунок яркости
  const box = await (await page.$('input[data-slider="brightness"]')).boundingBox();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
  await wait(200);
  check(core.state.brightness >= 25 && core.state.brightness <= 35, 'ползунок яркости двигает значение: ' + core.state.brightness);

  // питание
  await page.click('.js-power');
  await wait(200);
  check(core.state.power === false, 'кнопка питания выключает подсветку');
  await page.click('.js-power');
  await wait(200);
  check(core.state.power === true, 'и включает обратно');

  // сохранение темы
  await page.click('[data-act="savetheme"]');
  await page.fill('#theme-name', 'Мой вечер');
  await page.click('#m-ok');
  await wait(400);
  check(core.state.customThemes.length === 1, 'своя тема сохранилась');
  check((await page.$$('.theme')).length === 1 && (await page.textContent('.tabs .on')).includes('Мои'), 'после сохранения открылась вкладка «Мои» с этой темой');
  await page.click('[data-act="renametheme"]');
  await page.fill('#theme-name', 'Вечер у камина');
  await page.click('#m-ok');
  await wait(300);
  check(core.state.customThemes[0].name === 'Вечер у камина', 'тему можно переименовать');
  await page.click('.tabs [data-id="ready"]');
  await page.click('.theme[data-id="ocean"]');
  await page.click('.tabs [data-id="mine"]');
  await page.click('[data-act="updtheme"]');
  await wait(300);
  check(core.state.customThemes[0].effect === 'wave' && core.state.customThemes[0].colors[0] === '#0034ff', '«Обновить» записывает в тему текущие настройки');
  await shot('03-custom-theme');
  await page.click('[data-act="deltheme"]');
  await page.click('#m-ok');
  await wait(300);
  check(core.state.customThemes.length === 0, 'своя тема удаляется (с подтверждением)');
  check((await page.textContent('.mine-empty')).includes('Своих тем пока нет'), 'пустая вкладка «Мои» объясняет, что делать');
  await shot('03b-mine-empty');
  await page.click('.tabs [data-id="ready"]');

  // эффекты
  await page.click('.nav[data-page="effects"]');
  await wait(300);
  await shot('04-effects');
  await page.click('.fx[data-id="comet"]');
  await wait(300);
  check(core.state.effect === 'comet', 'выбор эффекта «Комета»');
  await page.click('.seg button[data-id="left"]');
  await wait(200);
  check(core.state.direction === 'left', 'смена направления');
  await page.click('[data-act="addcolor"]');
  await wait(200);
  const n1 = core.state.colors.length;
  await page.$eval('input[data-color="0"]', (el) => { el.value = '#00ff00'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(300);
  check(core.state.colors[0] === '#00ff00', 'выбор цвета палитры, цветов: ' + n1);
  await page.click('.fx[data-id="rainbow"]');
  await wait(300);
  check((await page.textContent('.side')).includes('весь спектр'), 'у радуги палитра скрыта');
  await page.click('.fx[data-id="music"]');
  await wait(900);
  await shot('05-music');
  check((await page.textContent('.side')).includes('Звук'), 'у «Музыки» показан блок со звуком');

  // устройства: подключение к OpenRGB
  await page.click('.nav[data-page="devices"]');
  await wait(300);
  await shot('06-devices-demo');
  await page.click('[data-act="connect"]');
  await wait(1500);
  check(core.conn.status === 'connected', 'кнопка «Подключиться» подключила (поддельный OpenRGB)');
  check((await page.$$('.row')).length === 2, 'в списке два реальных устройства вместо демо');
  await shot('07-devices-connected');
  check(await page.$eval('.row:nth-child(2) details.zones', (e) => e.open), 'зоны с нулём светодиодов раскрыты сами и просят указать количество');
  await page.fill('input[data-size-zone="Header 2"]', '12');
  await page.press('input[data-size-zone="Header 2"]', 'Enter');
  await page.$eval('input[data-size-zone="Header 2"]', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await wait(1200);
  check(core.devices.find((d) => d.name === 'Mock Strip').leds.length === 22, 'ввод количества светодиодов меняет зону в движке');
  await page.selectOption('select[data-order-zone="Strip"]', 'GRB');
  await wait(300);
  check(Object.values(core.state.colorOrders).includes('GRB'), 'выбор порядка цветов сохраняется');
  await page.click('.row:nth-child(2) [data-act="testzone"]');
  await wait(400);
  check(!!core.test, 'кнопка «Проверить» запускает проверку зоны');
  await shot('07b-zone-order');
  await page.click('.row:nth-child(2) .tg');
  await wait(300);
  check(core.state.disabledDevices.length === 1, 'тумблер выключает подсветку устройства');
  await page.click('.nav[data-page="home"]');
  await wait(800);
  await shot('08-home-connected');

  // настройки
  await page.click('.nav[data-page="settings"]');
  await wait(300);
  await shot('09-settings');
  await page.click('input[data-set="autostart"]');
  await wait(300);
  check(core.state.settings.autostart === true, 'тумблер автозапуска сохраняется в настройках');
  check((await page.textContent('.keys')).includes('Ctrl') && (await page.textContent('.keys')).includes('занято'), 'список горячих клавиш и предупреждение о занятых');
  await page.evaluate(() => document.querySelector('.keys').scrollIntoView());
  await shot('09b-hotkeys');

  // «Удиви меня», обмен темами
  await page.click('.nav[data-page="home"]');
  await wait(300);
  await page.click('[data-act="surprise"]');
  await wait(400);
  check(core.state.themeId === null && core.lastSurprise && core.state.effect === core.lastSurprise.effect, '«Удиви меня» применяет случайную тему');
  await shot('10-surprise');
  await page.click('[data-act="savetheme"]');
  check((await page.inputValue('#theme-name')) === core.lastSurprise.name, 'при сохранении подставлено имя случайной темы');
  await page.click('#m-ok');
  await wait(400);
  await page.click('[data-act="sharetheme"]');
  await wait(300);
  check(/^LUMEN1-/.test(core.__clipboard || ''), '«Поделиться» копирует код темы');
  const code = core.__clipboard;
  await page.click('[data-act="deltheme"]'); await page.click('#m-ok'); await wait(300);
  await page.click('[data-act="importtheme"]');
  await page.fill('#theme-name', code);
  await page.click('#m-ok');
  await wait(400);
  check(core.state.customThemes.length === 1 && core.state.customThemes[0].name === core.lastSurprise.name, 'тема добавлена по коду');
  await page.click('[data-act="importtheme"]');
  await page.fill('#theme-name', 'ерунда');
  await page.click('#m-ok');
  await wait(300);
  check((await page.textContent('#toast')).includes('LUMEN1-'), 'неверный код — понятная ошибка');

  // Сценарии
  await page.click('.nav[data-page="scenes"]');
  await wait(300);
  await shot('11-scenes-empty');
  await page.click('[data-act="sc-load-apps"]');
  await wait(400);
  await page.fill('#sc-exe', 'cs2.exe');
  await page.selectOption('#sc-theme', 'gamer');
  await page.click('[data-act="sc-add-app"]');
  await wait(300);
  check(core.state.scenarios.apps.length === 1 && core.state.scenarios.apps[0].exe === 'cs2.exe', 'правило «игра → тема» добавлено');
  await page.click('[data-act="sc-add-sched"]');
  await wait(300);
  await page.selectOption('select[data-sc-sched="mode"]', 'theme:night');
  await wait(300);
  check(core.state.scenarios.schedule[0].mode === 'theme' && core.state.scenarios.schedule[0].themeId === 'night', 'расписание: выбрана тема');
  await page.selectOption('select[data-sc-idle]', '15');
  await page.click('input[data-sc-bool="offOnLock"]');
  await wait(300);
  check(core.state.scenarios.idleMinutes === 15 && core.state.scenarios.offOnLock === true, 'автогашение сохраняется');
  core.setRunningApps(['cs2.exe']);
  await wait(400);
  check((await page.textContent('.scn-banner')).includes('cs2.exe'), 'плашка: работает сценарий игры');
  check(core.effective().effect === 'comet', 'во время игры горит «Геймер»');
  await shot('12-scenes');
  await page.click('.nav[data-page="home"]');
  await wait(300);
  await page.click('.tabs [data-id="ready"]');
  await page.click('.theme[data-id="ocean"]');
  await wait(300);
  check((await page.textContent('.scn-banner')).includes('на паузе'), 'ручной выбор ставит сценарий на паузу');
  await shot('13-scenario-paused');
  await page.click('[data-act="resume"]');
  await wait(300);
  check(core.effective().effect === 'comet', '«Вернуть сценарий» возвращает тему игры');
  core.setRunningApps([]);
  await wait(300);

  // Цвет экрана и температура
  await page.click('.nav[data-page="effects"]');
  await page.click('.fx[data-id="screen"]');
  await wait(2500);
  const st = await page.textContent('.side');
  check(/Смотрю на основной монитор/.test(st), 'у «Цвета экрана» захват экрана работает');
  const kb = core.devices.find((d) => d.name === 'Mock Keyboard'); // сетка 3×2: светодиод 0 слева, 2 справа
  const sf = core.frames[kb.id];
  check(sf[0] > sf[2] + 40 && sf[8] > sf[6] + 40, 'клавиатура: слева красная, справа синяя — как на «экране» (' + [...sf.slice(0, 3)] + ' / ' + [...sf.slice(6, 9)] + ')');
  console.log('    (кадров экрана получено ядром: ' + (core.__screenFrames || 0) + ')');
  await shot('14-screen');
  await page.click('.fx[data-id="temperature"]');
  await wait(2500);
  check(/nvidia-smi|°C|Читаю/.test(await page.textContent('.side')), 'у «Температуры» показан статус датчика');
  await shot('15-temperature');

  // Мини-гайд: кнопка «Как пользоваться», шаги, подсветка элементов
  await page.click('#help-btn');
  await wait(600);
  check(!!(await page.$('.tour-card')), 'гайд открывается по кнопке');
  await shot('22-tour-1');
  for (let k = 0; k < 2; k++) { await page.click('.tour-next'); await wait(450); }
  await shot('23-tour-3');
  const n = await page.textContent('.tour-n');
  check(/3 \/ 10/.test(n), 'гайд листается: ' + n);
  await page.keyboard.press('Escape');
  await wait(300);
  check(!(await page.$('.tour')), 'гайд закрывается');
  // Пульт на телефоне и предупреждения
  core.state.settings.remote.port = 47823;
  core.setSettings({ remote: { enabled: true } });
  core.health = { conflicts: [{ id: 'signalrgb', name: 'SignalRGB', exes: ['signalrgb.exe'] }], missing: [{ name: 'ENE DRAM', source: 'openrgb', kind: 'ram' }], unsupported: [] };
  core.checkHealth = async () => core.health; // фоновые проверки не должны перетирать подставленное
  core.emit('health', core.health);
  await wait(600);
  await page.click('.nav[data-page="devices"]');
  await wait(500);
  check((await page.textContent('#view')).includes('SignalRGB'), 'на «Устройствах» предупреждение о SignalRGB');
  check((await page.textContent('#view')).includes('ENE DRAM'), 'на «Устройствах» видно, какого устройства не хватает');
  await shot('24-health');
  await page.click('.nav[data-page="settings"]');
  await wait(600);
  const qr = await page.$('.remote-qr svg');
  check(!!qr, 'в настройках QR-код для телефона');
  if (qr) { await qr.scrollIntoViewIfNeeded(); await shot('25-remote'); }
  core.setSettings({ remote: { enabled: false } });
  core.health = { conflicts: [], missing: [] };
  core.emit('health', core.health);
  await page.click('.nav[data-page="home"]');

  // Плеер на главной
  await page.click('.nav[data-page="home"]');
  await push('nowplaying', { title: 'Ночной город', artist: 'Пример', app: 'Spotify.exe', cover: '', playing: true, pos: 0, dur: 0, at: Date.now() });
  await wait(400);
  check((await page.textContent('.player')).includes('Ночной город'), 'на главной карточка «Сейчас играет»');
  await page.click('.player [data-m="next"]');
  await wait(200);
  check(JSON.stringify(core.__media) === '["next"]', 'кнопка «следующий трек» уходит в плеер');
  await shot('27-player');
  await push('nowplaying', null);
  await wait(300);
  check(!(await page.$('.player')), 'музыка выключена — карточка исчезла');

  // Поиск: Ctrl+K, находим настройку, переходим к ней; тема — применяется
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.search input');
  await page.fill('.search input', 'пульт');
  await wait(200);
  const firstHit = await page.textContent('.search .sr li.on');
  check(/Пульт на телефоне|Управление с телефона/.test(firstHit), 'поиск «пульт» нашёл пульт на телефоне: ' + firstHit.replace(/\s+/g, ' '));
  await shot('26-search');
  await page.keyboard.press('Enter');
  await wait(700);
  check(await page.$eval('.nav[data-page="settings"]', (e) => e.classList.contains('on')), 'Enter открыл «Настройки»');
  check((await page.$$('#view .found')).length === 1, 'найденный пункт подсвечен');
  await page.click('#search-btn');
  await page.fill('.search input', 'лава');
  await wait(200);
  await page.keyboard.press('Enter');
  await wait(600);
  check(core.state.themeId === 'lava', 'поиск «лава» включил тему Лава');
  await page.keyboard.press('Control+K');
  await page.fill('.search input', 'вфывфывфы');
  await wait(150);
  check((await page.textContent('.search .sr')).includes('Ничего не нашлось'), 'пустой поиск — понятная надпись');
  await page.keyboard.press('Escape');
  check(!(await page.$('.search')), 'Esc закрывает поиск');

  // Другие языки: переключаем и перезагружаем окно (в приложении это делает main.js)
  for (const [lang, word] of [['en', 'Lighting'], ['de', 'Beleuchtung']]) {
    core.setSettings({ language: lang });
    await page.reload();
    await page.waitForSelector('.theme');
    await wait(500);
    const nav = await page.textContent('.rail');
    check(nav.includes(word), `язык ${lang}: меню «${word}»`);
    await page.click('.nav[data-page="settings"]');
    await wait(500);
    const body = await page.textContent('.view, main, #view');
    const cyr = (body.match(/[А-Яа-яЁё]{3,}[^<]{0,30}/g) || []).filter((x) => !/Русский|Українська|Как в Windows/.test(x));
    check(cyr.length <= 2, `язык ${lang}: в настройках почти не осталось русского (${cyr.slice(0, 6).join(' | ')})`);
    await shot('20-settings-' + lang);
    await page.click('.nav[data-page="home"]');
    await wait(400);
    await shot('21-home-' + lang);
  }
  core.setSettings({ language: 'ru' });

  console.log(errors.length ? '\nПроблемы:\n' + errors.join('\n') : '\nОшибок нет');
  await browser.close();
  core.shutdown();
  mock.server.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
