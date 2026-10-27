'use strict';
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, session, desktopCapturer,
  globalShortcut, powerMonitor, clipboard, screen, net,
} = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

// Журнал: %APPDATA%\Lumen\lumen.log (последние ~1 МБ)
let logFile = '';
function writeLog(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}\n`;
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'lumen.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch (_) { /* журнал не критичен */ }
}
process.on('uncaughtException', (e) => writeLog('Ошибка: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => writeLog('Ошибка (promise): ' + (e && e.stack || e)));
const { Core } = require('./core');
const { LiveWallpaper } = require('./livewall');
const { AdminEngine } = require('./adminengine');
const { makeTranslator } = require('../shared/i18n');
const { parseTasklist, parseUsbIds } = require('./health');
const { buildReport } = require('./bugreport');
const { Updater } = require('./updater');
const PKG = require('../../package.json');
let updater = null;
// Перевод строк главного процесса (меню в трее, окна выбора файла)
let T = (s) => s;
const { THEMES } = require('../shared/catalog');

const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const TRAY = path.join(ROOT, 'assets', 'tray.png');
const ALLOWED_LINKS = ['https://openrgb.org', 'https://openrgb.org/', 'https://nodejs.org', 'https://codeberg.org/OpenRGB/OpenRGB'];

let win = null;
let tray = null;
let core = null;
let quitting = false;
let framesWanted = true;

// Горячие клавиши (работают в любой программе, в том числе в играх)
const HOTKEYS = [
  { keys: 'Control+Alt+L', label: 'Включить или выключить подсветку', run: () => core.togglePower() },
  { keys: 'Control+Alt+PageUp', label: 'Следующая тема', run: () => core.cycleTheme(1) },
  { keys: 'Control+Alt+PageDown', label: 'Предыдущая тема', run: () => core.cycleTheme(-1) },
  { keys: 'Control+Alt+=', label: 'Ярче', run: () => core.stepBrightness(10) },
  { keys: 'Control+Alt+-', label: 'Тусклее', run: () => core.stepBrightness(-10) },
  { keys: 'Control+Alt+R', label: 'Удиви меня (случайная тема)', run: () => core.surprise() },
];
let hotkeysOn = null;
let hotkeysFailed = [];
function applyHotkeys() {
  const want = !!core.state.settings.hotkeys;
  if (want === hotkeysOn) return;
  hotkeysOn = want;
  globalShortcut.unregisterAll();
  hotkeysFailed = [];
  if (!want) return;
  for (const h of HOTKEYS) {
    try { if (!globalShortcut.register(h.keys, h.run)) hotkeysFailed.push(h.keys); } catch (_) { hotkeysFailed.push(h.keys); }
  }
  send('hotkeys', hotkeysInfo());
}
const hotkeysInfo = () => ({ list: HOTKEYS.map((h) => ({ keys: h.keys.replace('Control', 'Ctrl'), label: h.label })), failed: hotkeysFailed.map((k) => k.replace('Control', 'Ctrl')) });

// Запущенные программы — для сценариев «запустил игру → тема»
// Обложка трека -> маленькая картинка 40×40 в пикселях (BGRA) для «Цветов под музыку»
function decodeImage(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  return { data: img.resize({ width: 40, height: 40, quality: 'good' }).toBitmap(), bgr: true };
}

// Список запущенных процессов (имена) — для поиска программ, которые мешают подсветке
function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(new Set()); return; }
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? new Set() : parseTasklist(out)));
  });
}
// USB-устройства компьютера (VID:PID) — чтобы подсказать про контроллеры, которые движок не знает.
// Спрашиваем Windows не чаще раза в 10 минут.
let usbCache = { t: 0, ids: new Set() };
function listUsb() {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  if (Date.now() - usbCache.t < 600000) return Promise.resolve(usbCache.ids);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like '*VID_*' } | ForEach-Object { $_.InstanceId }"], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      usbCache = { t: Date.now(), ids: err ? usbCache.ids : parseUsbIds(out) };
      resolve(usbCache.ids);
    });
  });
}
// Закрыть программу по именам процессов (только по кнопке пользователя)
function killProcesses(exes) {
  return Promise.all(exes.map((e) => new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/IM', e], { windowsHide: true }, (err) => resolve(!err));
  }))).then((r) => r.some(Boolean));
}

function pollApps() {
  if (process.platform !== 'win32' || !core.state.scenarios.apps.length) return;
  execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    const names = String(out).split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean);
    core.setRunningApps(names);
  });
}
// Программы с окнами — чтобы удобно выбрать игру из списка
function listWindowApps() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve([]); return; }
    const ps = "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + '.exe' } | Sort-Object -Unique";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 }, (err, out) => {
      resolve(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function showWindow() {
  clearTimeout(sleepTimer);
  if (!win || win.isDestroyed()) { createWindow(false); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Экономия: когда окно спрятано в трей, через 20 секунд закрываем его целиком (освобождается
// память и всё, что делает интерфейс). Lumen при этом работает: подсветка, обои, сценарии.
// Окно не закрываем, только если оно нужно эффекту («Музыка» и «Цвет экрана» слушают звук/экран в нём).
let sleepTimer = null;
const SLEEP_MS = 20000;
function needsRenderer() {
  const e = core && core.effective();
  return !!(e && e.power && (e.effect === 'music' || e.effect === 'screen'));
}
function scheduleSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  if (!win || win.isDestroyed() || quitting) return;
  if (win.isVisible() && !win.isMinimized()) return;
  if (needsRenderer()) return;
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    if (!win || win.isDestroyed() || quitting || (win.isVisible() && !win.isMinimized()) || needsRenderer()) return;
    const w = win;
    win = null;
    core.wantFrames = false;
    w.destroy();
    writeLog('Окно в трее закрыто для экономии памяти');
  }, SLEEP_MS);
}
// Эффекту нужен интерфейс (музыка/экран), а окна нет — поднимаем его скрытым
function wakeForEffect() {
  if (needsRenderer() && (!win || win.isDestroyed())) createWindow(true);
  else scheduleSleep();
}

function send(channel, data) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow(startHidden) {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#07070c',
    title: 'Lumen',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07070c', symbolColor: '#c8c8dc', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // нужно, чтобы реакция на музыку работала из трея
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  win.on('close', (e) => {
    if (!quitting && core.state.settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  const updateWanted = () => {
    core.wantFrames = framesWanted && win && win.isVisible() && !win.isMinimized();
  };
  win.on('show', () => { updateWanted(); clearTimeout(sleepTimer); });
  win.on('hide', () => { updateWanted(); scheduleSleep(); });
  win.on('minimize', () => { updateWanted(); scheduleSleep(); });
  win.on('restore', () => { updateWanted(); clearTimeout(sleepTimer); });
  if (startHidden) scheduleSleep();
  // Выключение Windows: погасить подсветку, если так настроено
  win.on('session-end', () => core.shutdown({ lightsOff: core.state.scenarios.offOnSleep }));

  // Любые ссылки и новые окна — только в системный браузер и только из белого списка
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ALLOWED_LINKS.includes(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildTray() {
  const img = nativeImage.createFromPath(TRAY);
  tray = new Tray(img);
  tray.setToolTip('Lumen');
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

let trayKey = '';
function refreshTrayMenu() {
  if (!tray) return;
  const s = core.state;
  // Меню перестраиваем только когда изменилось то, что в нём видно
  const key = [core.lang(), s.power, s.themeId, s.customThemes.map((t) => t.id + t.name).join()].join('|');
  if (key === trayKey) return;
  trayKey = key;
  const themes = core.allThemes();
  const menu = Menu.buildFromTemplate([
    { label: T('Открыть Lumen'), click: () => showWindow() },
    { type: 'separator' },
    { label: T(s.power ? 'Выключить подсветку' : 'Включить подсветку'), click: () => core.setState({ power: !s.power }) },
    {
      label: T('Темы'),
      submenu: themes.map((t) => ({
        label: T(t.name), type: 'radio', checked: s.themeId === t.id, click: () => core.applyTheme(t.id),
      })),
    },
    { label: T('Удиви меня'), click: () => core.surprise() },
    { type: 'separator' },
    { label: T('Выйти'), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function applyAutostart(enabled, hidden) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: hidden ? ['--hidden'] : [] });
  } catch (_) { /* не критично */ }
}

function registerIpc() {
  ipcMain.handle('init', () => core.getInit());
  ipcMain.handle('state:set', (_e, patch) => { core.setState(patch || {}); return true; });
  ipcMain.handle('theme:apply', (_e, id) => core.applyTheme(String(id)));
  ipcMain.handle('theme:save', (_e, name) => core.saveTheme(name));
  ipcMain.handle('theme:rename', (_e, { id, name }) => core.renameTheme(String(id), name));
  ipcMain.handle('theme:update', (_e, id) => core.updateTheme(String(id)));
  ipcMain.handle('theme:export', (_e, id) => { const code = core.exportTheme(String(id)); if (code) clipboard.writeText(code); return code; });
  ipcMain.handle('theme:import', (_e, code) => core.importTheme(String(code || '')));
  ipcMain.handle('theme:surprise', () => core.surprise());
  ipcMain.handle('scenarios:set', (_e, sc) => core.setScenarios(sc));
  ipcMain.handle('scenario:resume', () => { core.resumeScenario(); return true; });
  ipcMain.handle('apps:list', () => listWindowApps());
  ipcMain.handle('hotkeys:info', () => hotkeysInfo());
  ipcMain.handle('diag:copy', () => {
    const d = { ...core.diagnostics(), electron: process.versions.electron, hotkeys: hotkeysInfo().failed, logTail: '' };
    try { d.logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n'); } catch (_) { /* нет журнала */ }
    const text = 'Отчёт Lumen\n' + JSON.stringify(d, null, 2);
    clipboard.writeText(text);
    writeLog('Отчёт скопирован');
    return text.length;
  });
  ipcMain.handle('diag:bugreport', async (_e, text, hw) => {
    try {
      const r = await buildReport({ core, logFile, dataDir: app.getPath('userData'), outDir: app.getPath('desktop'), description: String(text || ''), withHardware: hw !== false, extra: { electron: process.versions.electron, hotkeysFailed: hotkeysInfo().failed } });
      writeLog('Собран отчёт о проблеме: ' + path.basename(r.file));
      shell.showItemInFolder(r.file);
      return { ok: true, file: r.file };
    } catch (e) { writeLog('Отчёт о проблеме не собрался: ' + e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('diag:open-log', () => { writeLog('Открыт журнал'); return shell.openPath(logFile); });
  ipcMain.on('renderer:error', (_e, msg) => writeLog('Ошибка интерфейса: ' + String(msg).slice(0, 2000)));
  ipcMain.handle('theme:delete', (_e, id) => { core.deleteTheme(String(id)); return true; });
  ipcMain.handle('device:order', (_e, { id, zone, order }) => { core.setColorOrder(String(id), String(zone), String(order)); return true; });
  ipcMain.handle('device:size', (_e, { id, zone, size }) => core.setZoneSize(String(id), String(zone), Number(size)));
  ipcMain.handle('device:test', (_e, { id, zone }) => core.testZone(String(id), String(zone)));
  ipcMain.handle('device:enable', (_e, { id, enabled }) => { core.setDeviceEnabled(String(id), !!enabled); return true; });
  ipcMain.handle('settings:set', (_e, patch) => { core.setSettings(patch || {}); return true; });
  ipcMain.handle('conn:connect', () => { core.disconnect(); return core.connect({ manual: true }); });
  ipcMain.handle('conn:disconnect', () => { core.disconnect(); return true; });
  ipcMain.handle('openrgb:launch', () => core.launchOpenRGB());
  ipcMain.handle('engine:admin', (_e, on) => core.setEngineAdmin(!!on));
  ipcMain.handle('engine:restart', () => core.restartEngine());
  ipcMain.handle('fx:flash', (_e, color) => core.flash(String(color || '')));
  ipcMain.handle('media:ctl', (_e, what) => core.mediaControl(String(what || '')));
  ipcMain.handle('remote:newlink', () => core.newRemoteLink());
  ipcMain.handle('update:status', () => (updater ? { ...updater.status, current: app.getVersion(), available: updater.available } : null));
  ipcMain.handle('update:check', async () => { if (!updater) return null; const st = await updater.check({ download: true }); return st; });
  ipcMain.handle('update:install', () => {
    if (!updater || !updater.install()) return false;
    writeLog('Ставлю обновление ' + updater.status.version);
    setTimeout(() => { quitting = true; app.quit(); }, 400); // установщик дождётся закрытия Lumen
    return true;
  });
  ipcMain.handle('health:check', () => core.checkHealth());
  ipcMain.handle('health:hide', (_e, id) => core.hideHint(id));
  ipcMain.handle('health:close', (_e, id) => core.closeConflict(String(id)));
  ipcMain.handle('health:forget', () => { core.forgetMissing(); return true; });
  ipcMain.handle('photos:list', (_e, page) => core.photoOptions(Math.max(1, Math.min(50, Number(page) || 1))));
  ipcMain.handle('photos:pick', (_e, item) => core.pickPhoto(item));
  ipcMain.handle('openrgb:pick', async () => {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: T('Где лежит OpenRGB.exe?'),
      properties: ['openFile'],
      filters: [{ name: 'OpenRGB', extensions: ['exe'] }, { name: T('Все файлы'), extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    core.setSettings({ openrgbPath: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('native:rescan', () => { core.native.rescan(); return true; });
  ipcMain.handle('open:lighting-settings', () => { shell.openExternal('ms-settings:personalization-lighting'); return true; });
  ipcMain.handle('open:external', (_e, url) => {
    if (ALLOWED_LINKS.includes(url)) { shell.openExternal(url); return true; }
    return false;
  });
  ipcMain.on('audio:levels', (_e, bands) => core.setAudio(bands));
  ipcMain.on('screen:frame', (_e, frame) => core.setScreen(frame));
  ipcMain.on('frames:wanted', (_e, on) => {
    framesWanted = !!on;
    core.wantFrames = framesWanted && win && win.isVisible() && !win.isMinimized();
  });
}

function setupAudioCapture() {
  // Реакция на музыку: перехватываем звук, который идёт на колонки (Windows loopback)
  // и «Цвет экрана»: картинка основного монитора
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources.length) { callback({}); return; }
        const r = { video: sources[0] };
        if (request.audioRequested) r.audio = 'loopback';
        callback(r);
      })
      .catch(() => callback({}));
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  const bundledEngine = app.isPackaged
    ? path.join(process.resourcesPath, 'OpenRGB', 'OpenRGB.exe')
    : path.join(ROOT, 'vendor', 'OpenRGB', 'OpenRGB.exe');
  const getScreenSize = () => {
    const d = screen.getPrimaryDisplay();
    return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  };
  const adminEngine = new AdminEngine({
    dataDir: app.getPath('userData'),
    engineDir: path.dirname(bundledEngine),
    pawnio: app.isPackaged ? path.join(process.resourcesPath, 'PawnIO', 'PawnIO_setup.exe') : path.join(ROOT, 'vendor', 'PawnIO', 'PawnIO_setup.exe'),
  });
  const live = new LiveWallpaper({ electron: { BrowserWindow, screen }, dataDir: app.getPath('userData') });
  core = new Core({ dataDir: app.getPath('userData'), version: app.getVersion(), hooks: { setAutostart: applyAutostart, getScreenSize, listProcesses, listUsb, killProcesses, decodeImage, getLocale: () => (app.getPreferredSystemLanguages()[0] || app.getLocale()) }, bundledEngine, live, adminEngine });
  T = makeTranslator(core.lang()).t;
  live.setLang(core.lang());
  // Сменили язык: перевод главного процесса, меню, обои-виджеты и окно (перезагружаем — так проще всего)
  core.on('lang', (lang) => {
    T = makeTranslator(lang).t;
    live.setLang(lang);
    refreshTrayMenu();
    if (win && !win.isDestroyed()) win.webContents.reload();
    writeLog('Язык интерфейса: ' + lang);
  });
  // Фото-обои качаем через сетевой стек Electron: он учитывает системный прокси и VPN
  if (core.wallpaper.photos) core.wallpaper.photos.fetch = (u, o) => net.fetch(u, o);
  core.widgetFeed.fetch = (u, o) => net.fetch(u, o);
  // Автообновление с GitHub (выпуски репозитория Lumen)
  updater = new Updater({ repo: (PKG.lumen || {}).updateRepo, version: app.getVersion(), dataDir: app.getPath('userData'), fetchImpl: (u, o) => net.fetch(u, o) });
  updater.on('status', (st) => { send('update', st); if (['ready', 'error'].includes(st.state)) writeLog(`Обновление: ${st.state} ${st.version || ''} ${st.message || ''}`); });
  updater.start(app.isPackaged && core.state.settings.autoUpdate);
  let autoUpd = core.state.settings.autoUpdate;
  core.on('state', (s) => { if (s.settings.autoUpdate !== autoUpd) { autoUpd = s.settings.autoUpdate; updater.start(app.isPackaged && autoUpd); } });
  // Скрытый старт — только при автозапуске вместе с Windows (аргумент добавляется в applyAutostart)
  const startHidden = process.argv.includes('--hidden');

  let lastFx = '';
  core.on('state', (s) => {
    send('state', s); refreshTrayMenu(); applyHotkeys();
    const fx = needsRenderer() ? 'need' : '';
    if (fx !== lastFx) { lastFx = fx; wakeForEffect(); }
  });
  core.on('scenario', (st) => { send('scenario', st); wakeForEffect(); });
  core.on('sensors', (d) => send('sensors', d));
  core.on('health', (h) => send('health', h));
  core.on('remote', (r) => send('remote', r));
  core.on('nowplaying', (n) => send('nowplaying', n));
  core.on('devices', (d) => send('devices', d));
  core.on('conn', (c) => send('conn', c));
  core.on('native', (n) => send('native', n));
  core.on('wintheme', (w) => send('wintheme', w));
  core.on('frames', (f) => { if (core.wantFrames) send('frames', f); });
  core.on('log', (m) => { console.log('[lumen]', m); writeLog(m); });

  registerIpc();
  setupAudioCapture();
  createWindow(startHidden);
  buildTray();
  writeLog(`=== Lumen ${app.getVersion()} запущен (Windows ${os.release()}, Electron ${process.versions.electron}) ===`);
  core.wantFrames = !startHidden;
  core.begin();
  applyHotkeys();

  // Сценарии: программы, простой, блокировка, сон
  setInterval(pollApps, 5000);
  pollApps();
  setInterval(() => core.setIdle(powerMonitor.getSystemIdleTime()), 10000);
  powerMonitor.on('lock-screen', () => core.setLocked(true));
  powerMonitor.on('unlock-screen', () => core.setLocked(false));
  powerMonitor.on('suspend', () => core.setSleeping(true));
  powerMonitor.on('resume', () => core.setSleeping(false));
});

app.on('will-quit', () => globalShortcut.unregisterAll());

let finalizing = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (!core || finalizing) return;
  finalizing = true;
  e.preventDefault(); // даём вернуть оформление Windows и корректно закрыть мост подсветки
  core.finalize().catch(() => {}).finally(() => app.quit());
});

app.on('window-all-closed', () => { /* живём в трее */ });
void THEMES;
