'use strict';
// Ядро Lumen: состояние, темы, цикл эффектов, подключение к OpenRGB.
// Не зависит от Electron — поэтому его можно тестировать обычным Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { EFFECTS, DIRECTIONS, hexToRgb, speedFactor, renderDevice } = require('../shared/effects');
const { THEMES } = require('../shared/catalog');
const { OpenRGBClient, deviceLayout } = require('./openrgb');
const { createDemoDevices } = require('./devices');
const { NativeBackend } = require('./native');
const { LianLiTL } = require('./tlfan');
const { Lyrics } = require('./lyrics');
const { pickFlashColor } = require('./contrast');
const { WinTheme } = require('./wintheme');
const { pickAccent } = require('../shared/accent');
const { Sensors } = require('./sensors');
const { WidgetFeed } = require('./widgets');
const { findConflicts, mergeKnown, missingDevices, findUnsupported } = require('./health');

// Сколько светодиодов ставить разъёму ARGB, пока пользователь не указал сам. Лишние ничего не ломают:
// лента или вентилятор просто не получат «хвост» данных, а с маленьким числом светится только начало.
const DEFAULT_ZONE_LEDS = 40;
const { NotifyWatcher, APPS: NOTIFY_APPS } = require('./notify');
const { RemoteServer, newToken, DEFAULT_PORT } = require('./remote');
const { MediaWatcher } = require('./media');
const { DesktopHelper } = require('./livewall');
const { makeTranslator } = require('../shared/i18n');
const { LANGS, resolve: resolveLang } = require('../shared/i18n');
const { Wallpaper, STYLES: WALL_STYLES } = require('./wallpaper');
const { DEFAULT_SCENARIOS, sanitizeScenarios, evaluate } = require('./scenarios');
const { encodeTheme, decodeTheme } = require('../shared/share');
const { randomTheme } = require('../shared/surprise');

const FPS = 30;
const IDLE_FPS = 5;
const ORDERS = ['RGB', 'GRB', 'BRG', 'RBG', 'GBR', 'BGR'];
const TEST_STEP_MS = 1500;
const KEEPALIVE_MS = 2000;

const DEFAULTS = {
  power: true,
  brightness: 80,
  speed: 55,
  effect: 'wave',
  colors: ['#ff2bd6', '#7a2bff', '#00e5ff'],
  direction: 'right',
  themeId: 'cyberpunk',
  disabledDevices: [],
  colorOrders: {},
  zoneSizes: {},
  zoneAuto: {},
  customThemes: [],
  scenarios: DEFAULT_SCENARIOS,
  settings: {
    host: '127.0.0.1',
    port: 6742,
    autoConnect: true,
    launchOpenrgb: true,
    openrgbPath: '',
    autostart: false,
    startHidden: false,
    closeToTray: true,
    demoMode: true,
    nativeEnabled: true,
    winThemeEnabled: false,
    winForceDark: false,
    winRestoreOnExit: true,
    winWallpaper: false,
    winWallpaperStyle: 'live',
    hotkeys: true,
    engineAdmin: false,
    language: 'auto',
    knownDevices: [],
    remote: { enabled: false, port: 47800, token: '' },
    musicColors: false,
    tourDone: false,
    autoUpdate: true,
    notify: { enabled: false, apps: { discord: true, telegram: true, whatsapp: true, vk: true, mail: true, steam: false, other: false }, otherColor: '#ffffff', mode: 'auto' },
    photoPicks: {},
    hiddenHints: [],
    photoRotate: 0,
    widgets: { enabled: false, clock: true, weather: true, system: true, city: '', corner: 'tr', size: 'm', forecast: true, seconds: false,
      media: true, lyrics: true, calendar: false, note: false, noteText: '',
      style: 'glass', opacity: 'mid', clockStyle: 'thin', accent: 'theme',
      items: { cpu: true, ram: true, gpu: true, vram: false, net: true, disk: true, uptime: false } },
  },
};

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const isHex = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
function sanitizeWidgets(w) {
  const d = DEFAULTS.settings.widgets;
  w = w && typeof w === 'object' ? w : {};
  const b = (k) => (typeof w[k] === 'boolean' ? w[k] : d[k]);
  const it = w.items && typeof w.items === 'object' ? w.items : {};
  const items = {};
  for (const k of Object.keys(d.items)) items[k] = typeof it[k] === 'boolean' ? it[k] : d.items[k];
  const one = (k, list) => (list.includes(w[k]) ? w[k] : d[k]);
  return { enabled: b('enabled'), clock: b('clock'), weather: b('weather'), system: b('system'), forecast: b('forecast'), seconds: b('seconds'),
    media: b('media'), lyrics: b('lyrics'), calendar: b('calendar'), note: b('note'), noteText: String(w.noteText == null ? '' : w.noteText).replace(/[<>]/g, '').slice(0, 160),
    style: one('style', ['glass', 'solid', 'minimal', 'neon']), opacity: one('opacity', ['low', 'mid', 'high']),
    clockStyle: one('clockStyle', ['thin', 'bold', 'mono']), accent: one('accent', ['theme', 'white']),
    city: String(w.city || '').replace(/[<>]/g, '').trim().slice(0, 60), corner: ['tr', 'tl', 'br', 'bl'].includes(w.corner) ? w.corner : 'tr',
    size: ['s', 'm', 'l'].includes(w.size) ? w.size : 'm', items };
}
// Выбранное фото: только картинки каталога Wallhaven
function sanitizePhoto(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  const url = String(p.url || ''), thumb = String(p.thumb || '');
  if (!id || !/^https:\/\/w\.wallhaven\.cc\/full\/[a-z0-9]{2}\/wallhaven-[a-z0-9]+\.(jpg|png)$/i.test(url) || !/^https:\/\/th\.wallhaven\.cc\/small\/[a-z0-9]{2}\/[a-z0-9]+\.jpg$/i.test(thumb)) return null;
  return { id, url, thumb, res: String(p.res || '').slice(0, 12) };
}

class Core extends EventEmitter {
  constructor({ dataDir, version = '2.0.0', hooks = {}, native, lianli, wintheme, wallpaper, live, adminEngine, notify, media, sensors, clock, platform = process.platform, bundledEngine = '' }) {
    super();
    this.dataDir = dataDir;
    // Встроенный в установщик OpenRGB (движок для плат, видеокарт, вентиляторов и т.д.)
    this.bundledEngine = bundledEngine && fs.existsSync(bundledEngine) ? bundledEngine : '';
    this.engineChild = null;
    this.platform = platform;
    this.version = version;
    this.hooks = hooks; // { setAutostart(bool) }
    this.file = path.join(dataDir, 'lumen-settings.json');
    this.state = this._load();
    this.conn = { status: 'disconnected', message: '', count: 0 };
    this.demo = createDemoDevices();
    this.real = [];
    this.nativeList = [];
    this.devices = [];
    this.client = null;
    this.connecting = false;
    this.retryTimer = null;
    this.refreshTimer = null;
    this.saveTimer = null;
    this.lastLaunch = 0;
    this.T = 0;
    this.last = 0;
    this.wantFrames = true;
    this.frames = {};
    this.sent = new Map();
    this.audio = { bands: new Array(16).fill(0), bass: 0, level: 0 };
    this.lastAudioAt = 0;
    this.running = false;
    this._palKey = '';
    this._pal = [];
    // Встроенное управление подсветкой Windows (без сторонних программ)
    this.native = native || new NativeBackend({ dataDir });
    this.native.on('devices', (list) => { this.nativeList = list; this._rebuildDevices(); });
    this.native.on('status', (st) => { this.emit('native', st); this.log(`Windows Dynamic Lighting: ${st.state} ${st.message || ''} (устройств: ${st.count})`); });
    this.native.on('log', (m) => this.emit('log', m));
    // Вентиляторы Lian Li UNI FAN TL через их контроллер (запускается, только если контроллер подключён)
    this.tlList = [];
    this.lianli = lianli || new LianLiTL({ dataDir, platform });
    this.lianli.on('devices', (list) => { this.tlList = list; this._rebuildDevices(); });
    this.lianli.on('log', (m) => this.log(m));
    this.lianli.on('status', (st) => { if (st.state === 'error') this.lianliFailedAt = Date.now(); });
    // Цвет оформления Windows под тему подсветки
    this.wintheme = wintheme || new WinTheme({ dataDir, platform });
    this.wintheme.on('status', (st) => { this.emit('wintheme', this._winStatus()); this.log(`Цвет Windows: ${st.state} ${st.message || ''} (акцент ${this.wintheme.applied || this.wintheme.accent || '-'})`); });
    this.wallpaper = wallpaper || new Wallpaper({ dataDir, platform, getSize: hooks.getScreenSize });
    if (this.wallpaper.on) this.wallpaper.on('applied', () => this._syncLive());
    this.wallpaper.on('status', (st) => { this.emit('wintheme', this._winStatus()); this.log(`Обои: ${st.state} ${st.message || ''}`); });
    this.adminEngine = adminEngine || { available: false, status: { state: 'off', message: '' }, installed: () => false, setup: async () => ({ ok: false }), start: async () => false, stop() {} };
    if (this.adminEngine.on) this.adminEngine.on('status', () => this._setConn(this.conn.status, this.conn.message));
    this.live = live || { available: false, status: { state: 'off', message: '' }, configure() {}, setTheme() {}, shutdown() {} };
    if (this.live.on) {
      this.live.on('status', (st) => { this.emit('wintheme', this._winStatus()); this.log(`Живые обои: ${st.state} ${st.message || ''}`); });
      this.live.on('log', (m) => this.log(m));
      this.live.on('paused', (p) => this.widgetFeed.setPaused(p));
    }
    // Температура видеокарты (для эффекта «Температура»)
    this.sensors = sensors || new Sensors({ platform });
    this.sensors.on('data', (d) => this.emit('sensors', d));
    this.sensors.on('log', (m) => this.log(m));
    this.health = { conflicts: [], missing: [], unsupported: [] };
    this.notify = notify || new NotifyWatcher({ platform });
    this.media = media || new MediaWatcher({ dataDir, decode: hooks.decodeImage, Helper: DesktopHelper, platform });
    this.lyrics = new Lyrics();
    this.media.on('track', (t) => {
      this._onTrack(t);
      if (!this.state.settings.musicColors) return;
      const key = JSON.stringify([t.playing, t.colors]);
      if (key !== this._coverKey) { this._coverKey = key; if (t.playing && t.colors) this.log('Цвета под музыку: ' + t.colors.join(' ')); this._emitState(); }
    });
    this.media.on('status', (st) => { this.emit('wintheme', this._winStatus()); if (st) this.log(`Музыка: ${st.state} ${st.message || ''}`); });
    this.remote = new RemoteServer({ api: { state: () => this._remoteState(), act: (c) => this._remoteAct(c) }, page: () => this._remotePage() });
    this.remote.on('status', (st) => this.emit('remote', st));
    this.notify.on('notification', (n) => this._onNotification(n));
    this.notify.on('status', () => this.emit('wintheme', this._winStatus()));
    this.widgetFeed = new WidgetFeed({ sensors: this.sensors, netProvider: () => (this.live.netCounters ? this.live.netCounters() : Promise.resolve(null)) });
    this.widgetFeed.on('data', (d) => this.live.setWidgetData && this.live.setWidgetData(d));
    // Цвет экрана (для эффекта «Цвет экрана»)
    this.screenTarget = null;
    this.screenSmooth = null;
    // Сценарии
    this.clock = clock || (() => new Date());
    this.ctx = { apps: new Set(), idleSec: 0, locked: false };
    this.sleeping = false;
    this.override = null;
    this.pausedKey = null;
    this.scenarioTimer = null;
    this._rebuildDevices();
  }

  // --- Эффективное состояние: ручные настройки + активный сценарий ----------
  _activeOverride() { return this.override && this.override.key !== this.pausedKey ? this.override : null; }

  // noCover — без цветов обложки (для обычных и фото-обоев, чтобы не менять их на каждую песню)
  effective({ noCover = false } = {}) {
    const s = this.state;
    const e = { power: s.power, effect: s.effect, colors: s.colors, speed: s.speed, direction: s.direction, brightness: s.brightness };
    const o = this._activeOverride();
    if (o && o.kind === 'off') e.power = false;
    if (o && o.kind === 'theme') {
      const t = this.allThemes().find((x) => x.id === o.themeId);
      if (t) Object.assign(e, { effect: t.effect, colors: t.colors, speed: t.speed, direction: t.direction || 'right' });
    }
    if (this.sleeping) e.power = false;
    const tr = this.media && this.media.track;
    if (!noCover && s.settings.musicColors && tr && tr.playing && tr.colors && tr.colors.length) {
      e.colors = tr.colors.slice();
      if (e.effect === 'rainbow' || e.effect === 'screen') e.effect = 'wave'; // у этих эффектов своих цветов нет
    }
    return e;
  }

  scenarioStatus() {
    const o = this.override;
    const paused = !!(o && o.key === this.pausedKey);
    return { active: o ? { label: o.label, kind: o.kind } : null, paused, effect: o && !paused && o.kind === 'theme' ? this.effective().effect : null };
  }

  // Ручное изменение во время сценария ставит его на паузу (до смены сценария)
  _pauseScenario() {
    if (this.override && this.override.kind === 'theme' && this.pausedKey !== this.override.key) {
      this.pausedKey = this.override.key;
      this.emit('scenario', this.scenarioStatus());
    }
  }

  resumeScenario() {
    this.pausedKey = null;
    this.emit('scenario', this.scenarioStatus());
    this._syncWinAccent();
  }

  _evalScenarios() {
    const names = (id) => { const t = this.allThemes().find((x) => x.id === id); return t ? t.name : id; };
    const o = evaluate(this.state.scenarios, { ...this.ctx, now: this.clock() }, names);
    const key = o ? o.key : null;
    const cur = this.override ? this.override.key : null;
    if (key === cur && (!o || o.label === this.override.label)) return;
    this.override = o;
    if (this.pausedKey && this.pausedKey !== key) this.pausedKey = null;
    this.emit('scenario', this.scenarioStatus());
    this.log(`Сценарий: ${o ? o.label : 'нет'}`);
    this._syncWinAccent();
  }

  setRunningApps(list) {
    this.ctx.apps = new Set((list || []).map((x) => String(x).toLowerCase()));
    this._evalScenarios();
  }
  setIdle(sec) { this.ctx.idleSec = Math.max(0, Number(sec) || 0); this._evalScenarios(); }
  setLocked(v) { this.ctx.locked = !!v; this._evalScenarios(); this._suspendLive(); }
  _suspendLive() { if (this.live.setSuspended) this.live.setSuspended(this.ctx.locked || this.sysSleep); }
  setSleeping(v) {
    this.sysSleep = !!v;
    this._suspendLive();
    this.sleeping = !!v && this.state.scenarios.offOnSleep;
    if (this.sleeping) this.tick(); // сразу отправить чёрный кадр
  }

  setScenarios(raw) {
    const exists = (id) => this.allThemes().some((t) => t.id === id);
    this.state.scenarios = sanitizeScenarios(raw, exists);
    this._save();
    this._emitState();
    this._evalScenarios();
    return this.state.scenarios;
  }

  // --- Горячие клавиши и быстрые действия ----------------------------------
  togglePower() { this.setState({ power: !this.state.power }); return this.state.power; }

  cycleTheme(dir = 1) {
    const list = this.allThemes();
    if (!list.length) return null;
    const i = list.findIndex((t) => t.id === this.state.themeId);
    const next = list[(((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir) % list.length + list.length) % list.length];
    this.applyTheme(next.id);
    return next;
  }

  stepBrightness(delta) { this.setState({ brightness: this.state.brightness + delta }); return this.state.brightness; }

  // «Удиви меня»: случайная гармоничная тема (её можно потом сохранить в «Мои»)
  surprise(rand) {
    const t = randomTheme(rand);
    this.setState({ effect: t.effect, colors: t.colors, speed: t.speed, direction: t.direction, power: true });
    this.lastSurprise = t;
    return t;
  }


  // --- Обмен темами по коду ---------------------------------------------------
  exportTheme(id) {
    const t = this.allThemes().find((x) => x.id === id);
    return t ? encodeTheme(t) : null;
  }

  importTheme(code) {
    try {
      const t = decodeTheme(code, EFFECTS);
      const theme = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), tagline: 'Тема по коду', custom: true, ...t };
      this.state.customThemes.push(theme);
      this.applyTheme(theme.id);
      return { ok: true, theme };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- Цвет экрана -----------------------------------------------------------
  setScreen(frame) {
    if (!frame || !Array.isArray(frame.data) || frame.w * frame.h * 3 !== frame.data.length || frame.w > 64 || frame.h > 64) return;
    this.screenTarget = { w: frame.w, h: frame.h, data: frame.data.map((v) => Math.max(0, Math.min(255, Number(v) || 0))) };
    this.lastScreenAt = Date.now();
  }

  _screenFrame() {
    const t = this.screenTarget;
    if (!t) return null;
    let sm = this.screenSmooth;
    if (!sm || sm.w !== t.w || sm.h !== t.h) sm = this.screenSmooth = { w: t.w, h: t.h, raw: Float32Array.from(t.data), data: new Array(t.data.length) };
    for (let i = 0; i < t.data.length; i++) sm.raw[i] += (t.data[i] - sm.raw[i]) * 0.35;
    // чуть насыщеннее, чем на экране: так подсветка выглядит живее
    sm._avg = null;
    for (let i = 0; i < t.data.length; i += 3) {
      const r = sm.raw[i], g = sm.raw[i + 1], b = sm.raw[i + 2];
      const m = (r + g + b) / 3;
      sm.data[i] = Math.max(0, Math.min(255, m + (r - m) * 1.35));
      sm.data[i + 1] = Math.max(0, Math.min(255, m + (g - m) * 1.35));
      sm.data[i + 2] = Math.max(0, Math.min(255, m + (b - m) * 1.35));
    }
    return sm;
  }

  log(msg) { this.emit('log', msg); }

  // Отчёт для диагностики: всё, что нужно, чтобы понять проблему, без личных данных
  diagnostics() {
    const st = this.state.settings;
    return {
      version: this.version, platform: this.platform, os: `${os.type()} ${os.release()}`,
      engine: { bundled: !!this.bundledEngine, running: !!this.engineChild, admin: !!this.state.settings.engineAdmin, adminInstalled: this.adminEngine.installed(), conn: this.conn },
      native: this.native.status,
      lianli: this.lianli.status,
      devices: this.devices.map((d) => ({
        name: d.name, source: d.source, kind: d.kind, leds: d.leds.length, aspect: d.aspect, linear: d.linear,
        off: this.state.disabledDevices.includes(d.id), available: d.available !== false,
        zones: (d.zones || []).map((z) => `${z.name}: ${z.count}${z.resizable ? ` (${z.min}-${z.max})` : ''}${this.state.colorOrders[`${d.id}|${z.name}`] ? ' ' + this.state.colorOrders[`${d.id}|${z.name}`] : ''}`),
        badLayout: d.leds.some((L) => !Number.isFinite(L.x) || !Number.isFinite(L.y)) || !Number.isFinite(d.aspect),
      })),
      look: { theme: this.state.themeId, effect: this.state.effect, colors: this.state.colors, effective: this.effective() },
      windows: { accent: this.wintheme.status, wallpaper: this.wallpaper.status, live: this.live.status, settings: { theme: st.winThemeEnabled, dark: st.winForceDark, wallpaper: st.winWallpaper } },
      scenario: this.scenarioStatus(), scenarios: this.state.scenarios,
      sensors: this.sensors.data,
    };
  }

  _winStatus() { return { available: this.wintheme.available, ...this.wintheme.status, wallpaper: this.wallpaper.status, live: this.live.status, notify: { available: !!this.notify.available, ...this.notify.status }, media: { available: !!this.media.available, ...this.media.status, playing: !!this.media.track.playing, app: this.media.track.app, colors: this.media.track.colors } }; }

  // --- Фото под тему -------------------------------------------------------
  _photoKey(e = this.effective()) { return e.effect === 'rainbow' ? 'rainbow' : e.colors.map((c) => c.toLowerCase()).join(','); }

  // Варианты фото для текущей темы (с превью). page — с 1
  async photoOptions(page = 1) {
    const e = this.effective();
    const photos = this.wallpaper.photos;
    if (!photos) return { ok: false, message: 'Недоступно' };
    try {
      const r = await photos.search(pickAccent(e.colors, e.effect), page);
      const items = await Promise.all(r.items.map(async (it) => ({ ...it, src: await photos.thumb(it).catch(() => '') })));
      const pick = this.state.settings.photoPicks[this._photoKey(e)];
      return { ok: true, page, hasMore: r.hasMore, items: items.filter((x) => x.src), selected: pick ? pick.id : (page === 1 && items[0] ? items[0].id : '') };
    } catch (err) { return { ok: false, message: err.message }; }
  }

  pickPhoto(item) {
    const it = sanitizePhoto(item);
    if (!it) return false;
    const picks = this.state.settings.photoPicks;
    const key = this._photoKey();
    delete picks[key];
    picks[key] = it;
    const keys = Object.keys(picks);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete picks[k];
    this._save();
    this._syncWinAccent();
    this._emitState();
    return true;
  }

  // --- Здоровье: программы-конкуренты и пропавшие устройства ----------------
  _realDevices() { return this.devices.filter((d) => d.source === 'openrgb' || d.source === 'native').map((d) => ({ name: d.name, source: d.source, kind: d.kind })); }

  async checkHealth() {
    let conflicts = [];
    try { if (this.hooks.listProcesses) conflicts = findConflicts(await this.hooks.listProcesses()); } catch (_) { /* не страшно */ }
    const st = this.state.settings;
    let unsupported = [];
    try { if (this.hooks.listUsb) unsupported = findUnsupported(await this.hooks.listUsb()); } catch (_) { /* не страшно */ }
    if (unsupported.some((u) => u.id === 'lianli-tl')) {
      // Контроллер Lian Li TL подключён — пробуем управлять им сами (после ошибки — не чаще раза в 10 минут)
      if (!this.lianli.child && Date.now() - (this.lianliFailedAt || 0) > 600000) this.lianli.start();
      if (['ready', 'starting'].includes(this.lianli.status.state)) unsupported = unsupported.filter((u) => u.id !== 'lianli-tl');
    }
    unsupported = unsupported.filter((u) => !st.hiddenHints.includes(u.id));
    let missing = [];
    // Список «моих устройств» и пропажи считаем, только когда движок спокойно поработал полминуты
    const settled = this.conn.status === 'connected' && Date.now() - (this.connectedAt || Date.now()) > 25000;
    if (settled) {
      const cur = this._realDevices();
      missing = missingDevices(st.knownDevices, cur);
      if (!missing.length) {
        const merged = mergeKnown(st.knownDevices, cur);
        if (JSON.stringify(merged) !== JSON.stringify(st.knownDevices)) { st.knownDevices = merged; this._save(); }
      }
    }
    const h = { conflicts, missing, unsupported };
    if (JSON.stringify(h) !== JSON.stringify(this.health)) {
      if (conflicts.length && JSON.stringify(conflicts) !== JSON.stringify(this.health.conflicts)) this.log('Мешают программы: ' + conflicts.map((c) => c.name).join(', '));
      if (missing.length && JSON.stringify(missing) !== JSON.stringify(this.health.missing)) this.log('Не найдены устройства: ' + missing.map((d) => d.name).join(', '));
      this.health = h;
      this.emit('health', h);
    }
    return h;
  }

  // Трек сменился или идёт дальше: виджет «Сейчас играет», строчка текста, карточка в окне и на телефоне
  _onTrack(t) {
    const has = !!(t.title || t.artist);
    const np = has ? { title: t.title || '', artist: t.artist || '', app: t.app || '', cover: t.cover || '', playing: !!t.playing, pos: t.pos || 0, dur: t.dur || 0, at: t.at || Date.now() } : null;
    this.nowPlaying = np;
    const key = has ? `${t.artist}|${t.title}` : '';
    if (this.widgetFeed) {
      const w = this.state.settings.widgets;
      this.widgetFeed.setMedia(np && np.playing ? np : null);
      if (key !== this._lyricsKey) {
        this._lyricsKey = key;
        this.widgetFeed.setLyrics(null);
        if (key && w.enabled && w.media && w.lyrics) {
          this.lyrics.get({ artist: t.artist, title: t.title, dur: t.dur }).then((lines) => {
            if (this._lyricsKey !== key) return;
            if (lines === null) { this._lyricsKey = ''; return; } // нет сети — спросим при следующем опросе
            this.widgetFeed.setLyrics(lines.length ? { key, lines } : null);
          }).catch(() => {});
        }
      }
    }
    // в окно и на телефон — без обложки, если трек тот же (обложка тяжёлая)
    const sig = np ? [np.title, np.artist, np.app, np.playing, np.cover.length].join('|') : '';
    if (sig !== this._npSig) {
      this._npSig = sig;
      if (np) this.log(`Сейчас играет: трек в ${np.app || 'плеере'}${np.playing ? '' : ' (пауза)'}`); // без названия — журнал уходит в отчёты
      this.emit('nowplaying', np);
    }
  }

  mediaControl(what) { return this.media.control(what); }

  // Окно Lumen видно (для плеера на главной следим за музыкой, пока окно открыто)
  get wantFrames() { return !!this._wantFrames; }
  set wantFrames(v) { const was = this._wantFrames; this._wantFrames = !!v; if (was !== this._wantFrames && this.media && this.state) this._syncMedia(); }

  // Что играет — нужно для «цветов под музыку», виджета «Сейчас играет» и плеера в окне
  _syncMedia() {
    const st = this.state.settings;
    const want = st.musicColors || (st.widgets.enabled && st.widgets.media) || this.wantFrames || st.remote.enabled;
    if (want) this.media.start(); else this.media.stop();
  }

  // Скрыть подсказку про неподдерживаемое устройство («Понятно»)
  hideHint(id) {
    const st = this.state.settings;
    if (typeof id !== 'string' || st.hiddenHints.includes(id)) return false;
    st.hiddenHints = [...st.hiddenHints, id].slice(-20);
    this._save();
    this.health = { ...this.health, unsupported: (this.health.unsupported || []).filter((u) => u.id !== id) };
    this.emit('health', this.health);
    return true;
  }

  // «Я больше не пользуюсь этим устройством» — запомнить текущий набор как обычный
  forgetMissing() {
    this.state.settings.knownDevices = mergeKnown([], this._realDevices());
    this._save();
    this.health = { ...this.health, missing: [] };
    this.emit('health', this.health);
  }

  // Закрыть программу-конкурента и перезапустить движок, чтобы он забрал устройства себе
  async closeConflict(id) {
    const c = (this.health.conflicts || []).find((x) => x.id === id);
    if (!c || !this.hooks.killProcesses) return { ok: false };
    const ok = await this.hooks.killProcesses(c.exes);
    this.log(`Закрываю ${c.name}: ${ok ? 'готово' : 'не получилось'}`);
    setTimeout(() => { this.restartEngine(); setTimeout(() => this.checkHealth(), 3000); }, 1500);
    return { ok };
  }

  restartEngine() {
    this.log('Перезапускаю движок подсветки');
    const eng = this.engineChild;
    this.engineChild = null;
    if (eng) { try { eng.kill(); } catch (_) { /* уже */ } }
    if (this.state.settings.engineAdmin) this.adminEngine.stop();
    this.disconnect();
    this._setConn('connecting', 'Перезапускаю движок подсветки…');
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.lastLaunch = 0; this.adminFailed = false; this.launchOpenRGB(); setTimeout(() => this.connect(), 4000); }, 2500);
    return true;
  }

  // Слой рабочего стола: живые волны и/или виджеты поверх картинки обоев
  _syncLive() {
    const w = this.state.settings.widgets;
    const widgets = w.enabled && (w.clock || w.weather || w.system) ? w : null;
    this.widgetFeed.configure(widgets ? { ...widgets, enabled: true, lang: this.lang() } : null);
    const image = this.state.settings.winWallpaper && this.wallpaper.lastFile ? this.wallpaper.lastFile : null;
    if (this.live.update) this.live.update({ waves: this._liveOn(), widgets: widgets ? { ...widgets } : null, image });
    else this.live.configure(this._liveOn());
  }

  // Слайд-шоу: следующее фото для темы раз в N минут
  async _rotatePhoto() {
    const st = this.state.settings;
    if (!st.photoRotate || !st.winWallpaper || st.winWallpaperStyle !== 'photo') return;
    if (Date.now() - (this.lastRotate || 0) < st.photoRotate * 60000) return;
    this.lastRotate = Date.now();
    const e = this.effective();
    try {
      const r = await this.wallpaper.photos.search(pickAccent(e.colors, e.effect), 1);
      if (!r.items.length) return;
      const cur = st.photoPicks[this._photoKey(e)];
      const i = cur ? r.items.findIndex((x) => x.id === cur.id) : -1;
      const next = r.items[(i + 1) % r.items.length];
      if (next && (!cur || next.id !== cur.id)) { this.pickPhoto(next); this.log(`Слайд-шоу: новое фото ${next.id}`); }
    } catch (err) { this.log('Слайд-шоу: ' + err.message); }
  }

  // Язык интерфейса: выбранный в настройках или как в Windows
  lang() { return resolveLang(this.state.settings.language, this.hooks.getLocale ? this.hooks.getLocale() : ''); }

  _liveOn() { const st = this.state.settings; return !!(st.winWallpaper && st.winWallpaperStyle === 'live'); }

  _syncWinAccent() {
    const e = this.effective();
    this.wintheme.setAccent(pickAccent(e.colors, e.effect));
    const base = this.effective({ noCover: true });
    this.wallpaper.setTheme({ colors: base.colors, effect: base.effect, style: this.state.settings.winWallpaperStyle, accent: pickAccent(base.colors, base.effect), photo: this.state.settings.photoPicks[this._photoKey(base)] || null });
    this.live.setTheme({ colors: e.colors, effect: e.effect, speed: e.speed });
  }

  _applyWinCfg() {
    const st = this.state.settings;
    this._syncWinAccent();
    return this.wintheme.configure({ enabled: st.winThemeEnabled, forceDark: st.winForceDark });
  }

  // --- Состояние ---------------------------------------------------------
  _load() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* первый запуск */ }
    const s = { ...DEFAULTS, ...saved, settings: { ...DEFAULTS.settings, ...(saved.settings || {}) } };
    s.colors = Array.isArray(s.colors) && s.colors.length ? s.colors.filter(isHex).slice(0, 6) : DEFAULTS.colors;
    if (!s.colors.length) s.colors = DEFAULTS.colors.slice();
    if (!EFFECTS[s.effect]) s.effect = DEFAULTS.effect;
    if (!WALL_STYLES[s.settings.winWallpaperStyle]) s.settings.winWallpaperStyle = 'live'; // «Нейросеть» убрана
    const picks = {};
    for (const [k, v] of Object.entries(s.settings.photoPicks && typeof s.settings.photoPicks === 'object' ? s.settings.photoPicks : {}).slice(-200)) {
      const it = sanitizePhoto(v);
      if (it && typeof k === 'string' && k.length < 120) picks[k] = it;
    }
    s.settings.photoPicks = picks;
    s.settings.widgets = sanitizeWidgets(s.settings.widgets);
    s.settings.musicColors = !!s.settings.musicColors;
    {
      const r = s.settings.remote && typeof s.settings.remote === 'object' ? s.settings.remote : {};
      s.settings.remote = { enabled: !!r.enabled, port: clampInt(r.port, 1024, 65535, DEFAULT_PORT), token: typeof r.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(r.token) ? r.token : '' };
    }
    {
      const d = DEFAULTS.settings.notify, n = s.settings.notify && typeof s.settings.notify === 'object' ? s.settings.notify : {};
      const apps = {};
      for (const k of Object.keys(d.apps)) apps[k] = n.apps && typeof n.apps[k] === 'boolean' ? n.apps[k] : d.apps[k];
      s.settings.notify = { enabled: !!n.enabled, apps, otherColor: isHex(n.otherColor) ? n.otherColor : d.otherColor, mode: ['auto', 'contrast', 'app'].includes(n.mode) ? n.mode : 'auto' };
    }
    s.settings.knownDevices = (Array.isArray(s.settings.knownDevices) ? s.settings.knownDevices : [])
      .filter((d) => d && typeof d.name === 'string' && ['openrgb', 'native'].includes(d.source))
      .map((d) => ({ name: d.name.slice(0, 120), source: d.source, kind: String(d.kind || '').slice(0, 20) })).slice(-40);
    if (s.settings.language !== 'auto' && !LANGS[s.settings.language]) s.settings.language = 'auto';
    if (![0, 30, 60, 180, 1440].includes(s.settings.photoRotate)) s.settings.photoRotate = 0;
    if (!DIRECTIONS.includes(s.direction)) s.direction = 'right';
    s.brightness = clampInt(s.brightness, 0, 100, 80);
    s.speed = clampInt(s.speed, 0, 100, 50);
    s.disabledDevices = Array.isArray(s.disabledDevices) ? s.disabledDevices : [];
    const co = s.colorOrders && typeof s.colorOrders === 'object' ? s.colorOrders : {};
    s.colorOrders = {};
    const zs = s.zoneSizes && typeof s.zoneSizes === 'object' ? s.zoneSizes : {};
    s.zoneSizes = {};
    for (const [k, v] of Object.entries(zs)) if (Number.isInteger(v) && v >= 0 && v <= 1000) s.zoneSizes[k] = v;
    // До 2.8.1 поле было крошечным, и многие случайно ставили 1–2 светодиода (горело только начало вентилятора).
    // Такие размеры сбрасываем один раз — Lumen подставит разумное число сам.
    if (!s.zoneFixV1) { for (const [k, v] of Object.entries(s.zoneSizes)) if (v > 0 && v <= 2) delete s.zoneSizes[k]; s.zoneFixV1 = true; }
    const za = s.zoneAuto && typeof s.zoneAuto === 'object' ? s.zoneAuto : {};
    s.zoneAuto = {};
    for (const k of Object.keys(za)) if (za[k] === true) s.zoneAuto[k] = true;
    if (!Array.isArray(s.settings.hiddenHints)) s.settings.hiddenHints = [];
    // В 2.10.0 «Сейчас играет» был выключен по умолчанию, и его просто не находили — включаем один раз
    if (!s.widgetsV211) { s.settings.widgets.media = true; s.settings.widgets.lyrics = true; s.widgetsV211 = true; }
    for (const [k, v] of Object.entries(co)) if (ORDERS.includes(v) && v !== 'RGB') s.colorOrders[k] = v;
    s.customThemes = Array.isArray(s.customThemes) ? s.customThemes.filter((t) => t && t.id && t.name) : [];
    const exists = (id) => THEMES.some((t) => t.id === id) || s.customThemes.some((t) => t.id === id);
    s.scenarios = sanitizeScenarios(s.scenarios, exists);
    return s;
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.saveTimer);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { this.emit('log', 'Не удалось сохранить настройки: ' + e.message); }
  }

  publicState() { return JSON.parse(JSON.stringify(this.state)); }
  _emitState() { this.emit('state', this.publicState()); this._syncWinAccent(); }

  getInit() {
    return {
      state: this.publicState(),
      devices: this.deviceInfos(),
      conn: this.conn,
      native: this.native.status,
      wintheme: this._winStatus(),
      scenario: this.scenarioStatus(),
      sensors: this.sensors.data,
      catalog: { themes: THEMES, effects: EFFECTS, directions: DIRECTIONS, wallStyles: WALL_STYLES },
      lang: this.lang(), langs: LANGS, health: this.health, nowPlaying: this.nowPlaying || null, remote: this.remote.status, notifyApps: NOTIFY_APPS.map((a) => ({ id: a.id, name: a.name, color: a.color })),
      version: this.version,
      platform: this.platform,
    };
  }

  setState(patch) {
    const s = this.state;
    let identity = false;
    if (['power', 'effect', 'colors', 'direction', 'speed', 'themeId'].some((k) => k in patch)) this._pauseScenario();
    if ('power' in patch) s.power = !!patch.power;
    if ('brightness' in patch) s.brightness = clampInt(patch.brightness, 0, 100, s.brightness);
    if ('speed' in patch) s.speed = clampInt(patch.speed, 0, 100, s.speed);
    if ('effect' in patch && EFFECTS[patch.effect] && patch.effect !== s.effect) { s.effect = patch.effect; identity = true; }
    if ('direction' in patch && DIRECTIONS.includes(patch.direction) && patch.direction !== s.direction) { s.direction = patch.direction; identity = true; }
    if ('colors' in patch && Array.isArray(patch.colors)) {
      const c = patch.colors.filter(isHex).slice(0, 6);
      if (c.length && c.join() !== s.colors.join()) { s.colors = c; identity = true; }
    }
    if (identity && !('themeId' in patch)) s.themeId = null;
    if ('themeId' in patch) s.themeId = patch.themeId;
    this._save();
    this._emitState();
  }

  allThemes() { return THEMES.concat(this.state.customThemes); }

  applyTheme(id) {
    const t = this.allThemes().find((x) => x.id === id);
    if (!t) return false;
    this._pauseScenario();
    const s = this.state;
    s.effect = t.effect;
    s.colors = t.colors.slice();
    s.speed = t.speed;
    s.direction = t.direction || 'right';
    s.themeId = t.id;
    s.power = true;
    this._save();
    this._emitState();
    return true;
  }

  saveTheme(name) {
    const s = this.state;
    const clean = String(name || '').trim().slice(0, 24) || 'Моя тема';
    const t = {
      id: 'c' + Date.now().toString(36), name: clean, tagline: 'Моя тема', custom: true,
      effect: s.effect, colors: s.colors.slice(), speed: s.speed, direction: s.direction,
    };
    s.customThemes.push(t);
    s.themeId = t.id;
    this._save();
    this._emitState();
    return t;
  }

  renameTheme(id, name) {
    const t = this.state.customThemes.find((x) => x.id === id);
    const clean = String(name || '').trim().slice(0, 24);
    if (!t || !clean) return false;
    t.name = clean;
    this._save();
    this._emitState();
    return true;
  }

  // Записать в свою тему текущие эффект, цвета, скорость и направление
  updateTheme(id) {
    const s = this.state;
    const t = s.customThemes.find((x) => x.id === id);
    if (!t) return false;
    Object.assign(t, { effect: s.effect, colors: s.colors.slice(), speed: s.speed, direction: s.direction });
    s.themeId = t.id;
    this._save();
    this._emitState();
    return true;
  }

  deleteTheme(id) {
    const s = this.state;
    s.customThemes = s.customThemes.filter((t) => t.id !== id);
    if (s.themeId === id) s.themeId = null;
    this._save();
    this._emitState();
  }

  // Порядок каналов в зоне: у многих ARGB-вентиляторов он GRB, и красный горит зелёным
  setColorOrder(devId, zone, order) {
    if (!ORDERS.includes(order)) return;
    const key = `${devId}|${zone}`;
    if (order === 'RGB') delete this.state.colorOrders[key]; else this.state.colorOrders[key] = order;
    this.sent.delete(devId);
    this._save();
    this._emitState();
  }

  // Проверка зоны: красный → зелёный → синий по 1,5 секунды, остальное гаснет
  testZone(devId, zone) {
    this.test = { devId, zone, t0: Date.now() };
    return { steps: ['красный', 'зелёный', 'синий'], stepMs: TEST_STEP_MS };
  }

  // Сколько светодиодов подключено к «ручной» зоне (ARGB-разъёмы плат). Хранится в Lumen и
  // повторно применяется при каждом подключении — так работает и на другом компьютере.
  setZoneSize(devId, zone, size) {
    const d = this.real.find((x) => x.id === devId);
    const z = d && d.zones.find((x) => x.name === zone);
    if (!z || !z.resizable) return false;
    const n = Math.max(z.min, Math.min(z.max, Math.round(Number(size)) || 0));
    this.state.zoneSizes[`${devId}|${zone}`] = n;
    delete this.state.zoneAuto[`${devId}|${zone}`];
    this._save();
    this._emitState();
    if (this.client && n !== z.count) {
      this.client.resizeZone(d.openrgbIdx, z.index, n);
      this._scheduleRefresh();
    }
    return true;
  }

  setDeviceEnabled(id, enabled) {
    const set = new Set(this.state.disabledDevices);
    if (enabled) set.delete(id); else set.add(id);
    this.state.disabledDevices = [...set];
    this._save();
    this._emitState();
  }

  setSettings(patch) {
    const st = this.state.settings;
    const before = { host: st.host, port: st.port, demoMode: st.demoMode };
    if ('host' in patch) st.host = String(patch.host || '').trim() || '127.0.0.1';
    if ('port' in patch) st.port = clampInt(patch.port, 1, 65535, 6742);
    for (const k of ['autoConnect', 'launchOpenrgb', 'autostart', 'startHidden', 'closeToTray', 'demoMode', 'nativeEnabled', 'winThemeEnabled', 'winForceDark', 'winRestoreOnExit', 'winWallpaper', 'hotkeys', 'tourDone', 'autoUpdate']) {
      if (k in patch) st[k] = !!patch[k];
    }
    if ('openrgbPath' in patch) st.openrgbPath = String(patch.openrgbPath || '').trim();
    if ('winWallpaperStyle' in patch && WALL_STYLES[patch.winWallpaperStyle]) st.winWallpaperStyle = patch.winWallpaperStyle;
    if ('language' in patch && (patch.language === 'auto' || LANGS[patch.language])) { st.language = patch.language; this._langChanged = true; }
    if ('photoRotate' in patch) { st.photoRotate = [0, 30, 60, 180, 1440].includes(Number(patch.photoRotate)) ? Number(patch.photoRotate) : 0; this.lastRotate = Date.now(); }
    if ('musicColors' in patch) { st.musicColors = !!patch.musicColors; this._coverKey = null; this._syncMedia(); }
    if ('remote' in patch) {
      const pr = patch.remote || {};
      st.remote = { ...st.remote, enabled: 'enabled' in pr ? !!pr.enabled : st.remote.enabled };
      this._syncRemote();
    }
    if ('notify' in patch) {
      const pn = patch.notify || {};
      const cur = st.notify;
      const apps = { ...cur.apps };
      for (const [k, v] of Object.entries(pn.apps || {})) if (k in apps) apps[k] = !!v;
      st.notify = { enabled: 'enabled' in pn ? !!pn.enabled : cur.enabled, apps, otherColor: isHex(pn.otherColor) ? pn.otherColor.toLowerCase() : cur.otherColor, mode: ['auto', 'contrast', 'app'].includes(pn.mode) ? pn.mode : cur.mode };
      this._syncNotify();
    }
    if ('widgets' in patch) { const pw = patch.widgets || {}; st.widgets = sanitizeWidgets({ ...st.widgets, ...pw, items: { ...st.widgets.items, ...(pw.items || {}) } }); this._syncMedia(); }
    this._save();
    if (this._langChanged) { this._langChanged = false; this.emit('lang', this.lang()); this._syncLive(); }
    if ('autostart' in patch && this.hooks.setAutostart) this.hooks.setAutostart(st.autostart, st.startHidden);
    if ('startHidden' in patch && st.autostart && this.hooks.setAutostart) this.hooks.setAutostart(st.autostart, st.startHidden);
    if (before.demoMode !== st.demoMode) this._rebuildDevices();
    if ('nativeEnabled' in patch) { if (st.nativeEnabled) this.native.start(); else this.native.stop(); }
    if ('winThemeEnabled' in patch || 'winForceDark' in patch) this._applyWinCfg();
    if ('winWallpaper' in patch) { this._syncWinAccent(); this.wallpaper.configure(st.winWallpaper); }
    if ('winWallpaperStyle' in patch) this._syncWinAccent();
    if ('winWallpaper' in patch || 'winWallpaperStyle' in patch || 'widgets' in patch) this._syncLive();
    this._emitState();
    if (before.host !== st.host || before.port !== st.port) {
      this.disconnect();
      if (st.autoConnect) this.connect();
    } else if ('autoConnect' in patch && st.autoConnect && !this.client) this.connect();
    else if ('autoConnect' in patch && !st.autoConnect) clearTimeout(this.retryTimer);
  }

  setAudio(bands) {
    if (!Array.isArray(bands)) return;
    const a = this.audio;
    for (let i = 0; i < a.bands.length; i++) {
      const v = Math.min(1, Math.max(0, Number(bands[i]) || 0));
      a.bands[i] = Math.max(v, a.bands[i] * 0.8);
    }
    a.bass = (a.bands[0] + a.bands[1] + a.bands[2]) / 3;
    this.lastAudioAt = Date.now();
  }

  // --- Устройства --------------------------------------------------------
  _rebuildDevices() {
    const hasReal = this.nativeList.length > 0 || this.tlList.length > 0 || !!this.client;
    const demoOn = this.state.settings.demoMode && !hasReal; // демо — пока нет настоящих устройств
    this.devices = (demoOn ? this.demo : []).concat(this.nativeList, this.tlList, this.real);
    const alive = new Set(this.devices.map((d) => d.id));
    for (const k of this.sent.keys()) if (!alive.has(k)) this.sent.delete(k);
    this.frames = {};
    for (const d of this.devices) this.frames[d.id] = new Uint8Array(d.leds.length * 3);
    this.emit('devices', this.deviceInfos());
  }

  deviceInfos() {
    return this.devices.map((d) => ({
      id: d.id, name: d.name, kind: d.kind, vendor: d.vendor, source: d.source,
      count: d.leds.length, available: d.available !== false, aspect: d.aspect, linear: d.linear, plate: !!d.plate, leds: d.leds,
      zones: (d.zones || []).filter((z) => z.count > 0 || z.resizable).map((z) => ({ name: z.name, count: z.count, resizable: !!z.resizable, min: z.min, max: z.max })),
    }));
  }

  // --- Цикл эффектов -----------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this.last = Date.now();
    const loop = () => {
      if (!this.running) return;
      const t0 = Date.now();
      try { this.tick(); } catch (e) { this.emit('log', 'tick: ' + e.stack); }
      // Ничего не движется (один цвет, подсветка выключена, окно закрыто и связи нет) — 5 кадров в секунду вместо 30
      const fps = this._idleTick ? IDLE_FPS : FPS;
      this.timer = setTimeout(loop, Math.max(1, Math.round(1000 / fps) - (Date.now() - t0)));
    };
    loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); }

  _palette(colors = this.state.colors) {
    const key = colors.join();
    if (key !== this._palKey) { this._palKey = key; this._pal = colors.map(hexToRgb); }
    return this._pal;
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const s = this.state;
    const e = this.effective();
    this.T += dt * speedFactor(e.speed);
    // датчики опрашиваем, только пока они нужны
    const needGpu = e.effect === 'temperature' || this.widgetFeed.needsGpu;
    if (needGpu && !this.sensors.timer) this.sensors.start(e.effect === 'temperature' ? 2 : 3);
    else if (!needGpu && this.sensors.timer) this.sensors.stop();

    if (now - this.lastAudioAt > 300) {
      const a = this.audio;
      for (let i = 0; i < a.bands.length; i++) a.bands[i] *= 0.88;
      a.bass *= 0.88;
    }

    const orgbLive = this.conn.status === 'connected' && !!this.client;
    const nativeLive = (this.nativeList.length > 0 && this.native.status.state === 'ready') || (this.tlList.length > 0 && this.lianli.status.state === 'ready');
    const still = !e.power || e.effect === 'static' || e.brightness === 0;
    // при открытом окне держим 30 кадров, чтобы ползунки отзывались мгновенно
    this._idleTick = (still && !this.test && !this.wantFrames) || (!this.wantFrames && !orgbLive && !nativeLive);
    if (!this.wantFrames && !orgbLive && !nativeLive) return;

    const params = {
      effect: e.effect, pal: this._palette(e.colors), direction: e.direction, brightness: e.brightness,
      screen: e.effect === 'screen' ? this._screenFrame() : null, sensors: this.sensors.data,
    };
    const off = new Set(s.disabledDevices);
    let flash = this.flashFx;
    if (flash && now - flash.t0 > flash.ms) flash = this.flashFx = null;
    if (flash) this._idleTick = false;
    for (const d of this.devices) {
      const out = this.frames[d.id];
      if (!out) continue;
      if (!e.power || off.has(d.id)) out.fill(0);
      else renderDevice(d, params, this.T, this.audio, out);
      if (flash && e.power && !off.has(d.id)) this._applyFlash(out, flash, now);
      if (this.test && this.test.devId === d.id) this._applyTest(d, out, now);
      if ((d.source === 'openrgb' && orgbLive) || ((d.source === 'native' || d.source === 'lianli') && nativeLive)) this._sendToHardware(d, out, now);
    }
    if (this.wantFrames) this.emit('frames', this.frames);
  }

  // Вспышка поверх эффекта: два мягких импульса цветом приложения
  // Две вспышки; перед каждой подсветка на мгновение темнеет — так вспышку видно на любом фоне
  _applyFlash(out, f, now) {
    const q = (((now - f.t0) / f.ms) * 2) % 1; // фаза внутри одной вспышки
    const DIP = 0.16;
    if (q < DIP) {
      const dim = 1 - 0.85 * Math.sin((Math.PI / 2) * (q / DIP));
      for (let i = 0; i < out.length; i++) out[i] *= dim;
      return;
    }
    const k = Math.pow(Math.sin(Math.PI * ((q - DIP) / (1 - DIP))), 1.2);
    for (let i = 0; i < out.length; i += 3) {
      out[i] = out[i] * 0.15 * (1 - k) + f.rgb[0] * k;
      out[i + 1] = out[i + 1] * 0.15 * (1 - k) + f.rgb[1] * k;
      out[i + 2] = out[i + 2] * 0.15 * (1 - k) + f.rgb[2] * k;
    }
  }

  // Мигнуть всей подсветкой (уведомление или «Проверить»)
  flash(color) {
    if (!isHex(color)) return false;
    const now = Date.now();
    if (this.flashFx && now - this.flashFx.t0 < 900) return false; // пачка уведомлений — одна вспышка
    // цвет приложения — если он заметен на фоне подсветки, иначе самый контрастный к ней
    const e = this.effective();
    const rgb = pickFlashColor(hexToRgb(color), (e.colors || []).filter(isHex).map(hexToRgb), this.state.settings.notify.mode, e.effect === 'rainbow');
    this.flashFx = { rgb, t0: now, ms: 1700 };
    return true;
  }

  _onNotification(n) {
    const cfg = this.state.settings.notify;
    if (!cfg.enabled || !cfg.apps[n.app]) return;
    const e = this.effective();
    if (!e.power || this.sleeping || this.ctx.locked) return;
    this.flash(n.color || cfg.otherColor);
  }

  // --- Управление с телефона -------------------------------------------------
  _remoteState() {
    const s = this.state, e = this.effective();
    const t = makeTranslator(this.lang()).t;
    const themes = this.allThemes();
    const cur = themes.find((x) => x.id === s.themeId);
    const np = this.nowPlaying;
    return { power: e.power, brightness: s.brightness, speed: s.speed, themeId: s.themeId, themeName: cur ? t(cur.name) : '', colors: e.colors,
      media: np ? { title: np.title, artist: np.artist, playing: np.playing } : null,
      themes: themes.map((x) => ({ id: x.id, name: t(x.name), colors: x.effect === 'rainbow' ? ['#ff2a2a', '#ffb000', '#9dff00', '#00e5a0', '#00a2ff', '#8b3dff'] : x.colors.length > 1 ? x.colors : [x.colors[0], x.colors[0]] })) };
  }

  _remoteAct(c) {
    const num = (v) => Number.isFinite(Number(v));
    if ('power' in c) this.setState({ power: !!c.power });
    else if ('brightness' in c && num(c.brightness)) this.setState({ brightness: clampInt(c.brightness, 0, 100, this.state.brightness) });
    else if ('speed' in c && num(c.speed)) this.setState({ speed: clampInt(c.speed, 1, 100, this.state.speed) });
    else if ('theme' in c && this.allThemes().some((x) => x.id === c.theme)) this.applyTheme(String(c.theme));
    else if (c.surprise) this.surprise();
    else if (['play', 'next', 'prev'].includes(c.media)) this.mediaControl(c.media);
    else return false;
    return true;
  }

  _remotePage() {
    if (!this._remoteTpl) this._remoteTpl = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8');
    const lang = this.lang();
    const t = makeTranslator(lang).t;
    const L = { LANG: lang, POWER: t('Включить или выключить подсветку'), BRIGHT: t('Яркость'), SPEED: t('Скорость'), SURPRISE: t('Удиви меня'), THEMES: t('Темы'), LOST: t('Нет связи с Lumen. Проверь, что компьютер включён и телефон в той же сети Wi-Fi.') };
    return this._remoteTpl.replace(/__([A-Z]+)__/g, (m, k) => (k in L ? String(L[k]).replace(/[<>&"]/g, '') : m));
  }

  _syncRemote() {
    const r = this.state.settings.remote;
    if (r.enabled && !r.token) { r.token = newToken(); this._save(); }
    this.remote.configure(r.enabled ? { enabled: true, port: r.port, token: r.token } : null);
  }

  newRemoteLink() {
    this.state.settings.remote.token = newToken();
    this._save();
    this._syncRemote();
    return true;
  }

  _syncNotify() {
    const cfg = this.state.settings.notify;
    if (cfg.enabled) this.notify.start(); else this.notify.stop();
  }

  _applyTest(d, out, now) {
    const step = Math.floor((now - this.test.t0) / TEST_STEP_MS);
    if (step > 2) { this.test = null; return; }
    const z = (d.zones || []).find((x) => x.name === this.test.zone);
    const c = [[255, 0, 0], [0, 255, 0], [0, 0, 255]][step];
    out.fill(0);
    const from = z ? z.start : 0, to = z ? z.start + z.count : d.leds.length;
    for (let i = from; i < to && i < d.leds.length; i++) { out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
  }

  // Переставить каналы по зонам согласно настройке (на превью не влияет)
  _hwBuffer(d, out) {
    if (!d.zones || !d.zones.length) return out;
    let buf = null;
    for (const z of d.zones) {
      const o = this.state.colorOrders[`${d.id}|${z.name}`];
      if (!o) continue;
      if (!buf) buf = Uint8Array.from(out);
      const idx = [...o].map((ch) => 'RGB'.indexOf(ch));
      for (let i = z.start; i < z.start + z.count && i < d.leds.length; i++) {
        const p = i * 3, src = [out[p], out[p + 1], out[p + 2]];
        buf[p] = src[idx[0]]; buf[p + 1] = src[idx[1]]; buf[p + 2] = src[idx[2]];
      }
    }
    return buf || out;
  }

  _sendToHardware(d, out, now) {
    const buf = this._hwBuffer(d, out);
    const prev = this.sent.get(d.id);
    if (prev && now - prev.t < KEEPALIVE_MS && Buffer.compare(prev.buf, buf) === 0) return;
    const ok = d.source === 'native' ? this.native.setLeds(d.id, buf) : d.source === 'lianli' ? this.lianli.setLeds(d.id, buf) : this.client.setLeds(d.openrgbIdx, buf);
    if (ok) this.sent.set(d.id, { buf: Buffer.from(buf), t: now });
  }

  // --- OpenRGB -----------------------------------------------------------
  _setConn(status, message = '') {
    const ae = this.adminEngine || { available: false, status: {} };
    if (status === 'connected' && (!this.conn || this.conn.status !== 'connected')) {
      this.connectedAt = Date.now();
      clearTimeout(this.healthSoon);
      this.healthSoon = setTimeout(() => this.checkHealth(), 26000);
      if (this.healthSoon.unref) this.healthSoon.unref();
    }
    this.conn = { status, message, count: this.real.length, bundled: !!this.bundledEngine, admin: { available: !!ae.available, on: !!(this.state && this.state.settings.engineAdmin), ...ae.status } };
    if (status !== 'connecting') this.log(`Движок: ${status} ${message}`);
    this.emit('conn', this.conn);
  }

  findOpenRGB() {
    if (this.bundledEngine) return this.bundledEngine;
    const p = this.state.settings.openrgbPath;
    if (p && fs.existsSync(p)) return p;
    if (process.platform !== 'win32') return '';
    const env = process.env;
    const cands = [
      path.join(env['ProgramFiles'] || 'C:\\Program Files', 'OpenRGB', 'OpenRGB.exe'),
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'OpenRGB', 'OpenRGB.exe'),
      path.join(env['LOCALAPPDATA'] || '', 'Programs', 'OpenRGB', 'OpenRGB.exe'),
      path.join(os.homedir(), 'OpenRGB', 'OpenRGB.exe'),
      path.join(os.homedir(), 'Desktop', 'OpenRGB', 'OpenRGB.exe'),
      path.join(os.homedir(), 'Downloads', 'OpenRGB', 'OpenRGB.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || '';
  }

  launchOpenRGB() {
    const exe = this.findOpenRGB();
    if (!exe) return { ok: false, error: 'Не нашёл OpenRGB.exe — укажи путь в настройках' };
    try {
      const port = String(this.state.settings.port);
      let child;
      if (exe === this.bundledEngine && this._adminReady()) {
        // Движок с правами администратора (видит оперативную память) — через задачу планировщика
        this.lastLaunch = Date.now();
        this.adminEngine.start(port).then((ok) => {
          if (ok) return;
          this.log('Движок с правами администратора не запустился — запускаю обычный');
          this.adminFailed = true;
          this.launchOpenRGB();
        });
        return { ok: true, path: exe, admin: true };
      }
      if (exe === this.bundledEngine) {
        // Встроенный движок: без окна (только сервер), живёт вместе с Lumen
        if (this.engineChild) return { ok: true, path: exe };
        child = spawn(exe, ['--server', '--server-port', port], { stdio: 'ignore', cwd: path.dirname(exe), windowsHide: true });
        this.engineChild = child;
        child.on('exit', () => { if (this.engineChild === child) this.engineChild = null; });
      } else {
        child = spawn(exe, ['--server', '--startminimized', '--server-port', port], {
          detached: true, stdio: 'ignore', cwd: path.dirname(exe), windowsHide: false,
        });
        child.unref();
      }
      child.on('error', () => {});
      this.lastLaunch = Date.now();
      return { ok: true, path: exe };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  _adminReady() { return !!(this.state.settings.engineAdmin && !this.adminFailed && this.adminEngine.installed()); }

  // Включить/выключить подсветку памяти: движок с правами администратора и драйвером PawnIO
  async setEngineAdmin(on) {
    const st = this.state.settings;
    if (on) {
      if (!this.adminEngine.installed() || !st.engineAdmin) {
        const r = await this.adminEngine.setup();
        if (!r.ok) { this._setConn(this.conn.status, this.conn.message); return r; }
      }
      st.engineAdmin = true;
    } else {
      st.engineAdmin = false;
      this.adminEngine.stop();
    }
    this.adminFailed = false;
    this._save();
    this.log(`Подсветка памяти (движок с правами администратора): ${on ? 'включена' : 'выключена'}`);
    // перезапускаем движок в новом режиме
    const eng = this.engineChild;
    this.engineChild = null;
    if (eng) { try { eng.kill(); } catch (_) { /* уже */ } }
    this.disconnect();
    setTimeout(() => { this.lastLaunch = 0; this.launchOpenRGB(); setTimeout(() => this.connect(), 4000); }, on ? 1500 : 2500);
    this._setConn('connecting', 'Перезапускаю движок подсветки…');
    this._emitState();
    return { ok: true };
  }

  _friendly(e) {
    const code = e && e.code;
    if (code === 'ECONNREFUSED' && this.bundledEngine) return 'Движок подсветки не отвечает';
    if (code === 'ECONNREFUSED') return 'OpenRGB не запущен или в нём выключен SDK-сервер';
    if (code === 'ENOTFOUND') return 'Не удалось найти компьютер по этому адресу';
    return (e && e.message) || 'Не удалось подключиться';
  }

  async connect({ manual = false } = {}) {
    if (this.client || this.connecting) return;
    clearTimeout(this.retryTimer);
    this.connecting = true;
    const st = this.state.settings;
    this._setConn('connecting', this.bundledEngine ? 'Подключаюсь к движку подсветки…' : 'Подключаюсь к OpenRGB…');
    const client = new OpenRGBClient({ host: st.host, port: st.port, name: 'Lumen' });
    try {
      await client.connect();
      let list = await client.listDevices();
      if (this._applyZoneSizes(client, list)) { await new Promise((r) => setTimeout(r, 400)); list = await client.listDevices(); }
      client.on('close', () => this._onClosed(client));
      client.on('soft-error', () => {});
      client.on('devices-changed', () => this._scheduleRefresh());
      this.client = client;
      this._applyReal(list);
      this._setConn('connected', '');
    } catch (e) {
      client.close();
      this.client = null;
      const refused = e && e.code === 'ECONNREFUSED';
      const starting = refused && Date.now() - this.lastLaunch < 45000; // движок ещё ищет устройства
      if (starting) this._setConn('connecting', 'Запускаю движок подсветки, ищу устройства…');
      else this._setConn('error', this._friendly(e));
      if (refused && (manual || st.launchOpenrgb || this.bundledEngine) && Date.now() - this.lastLaunch > 60000) {
        const r = this.launchOpenRGB();
        if (r.ok) this._setConn('connecting', this.bundledEngine ? 'Запускаю движок подсветки, ищу устройства…' : 'Запускаю OpenRGB…');
        else if (manual) this._setConn('error', r.error);
      }
      this._scheduleRetry(manual ? 3000 : 5000);
    } finally {
      this.connecting = false;
    }
  }

  _scheduleRetry(ms) {
    clearTimeout(this.retryTimer);
    if (!this.state.settings.autoConnect) return;
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  _scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      if (!this.client) return;
      try {
        let list = await this.client.listDevices();
        if (this._applyZoneSizes(this.client, list)) { await new Promise((r) => setTimeout(r, 400)); if (!this.client) return; list = await this.client.listDevices(); }
        this._applyReal(list);
        this._setConn('connected', '');
      } catch (_) { /* ждём следующего события */ }
    }, 500);
  }

  _orgbId(c) { return `orgb:${c.name}|${c.location || c.serial || c.index}`; }

  // Отправить сохранённые размеры зон, если в движке они другие. true — если что-то поменяли.
  _applyZoneSizes(client, list) {
    let changed = false;
    for (const c of list) {
      c.zones.forEach((z, zi) => {
        const key = `${this._orgbId(c)}|${z.name}`;
        let want = this.state.zoneSizes[key];
        // Разъём ARGB без размера (0–2 светодиода): ставим разумное число сами и подсказываем уточнить
        if (want == null && z.ledsMin !== z.ledsMax && z.ledsCount <= 2 && z.ledsMax >= 8) {
          want = Math.max(z.ledsMin, Math.min(z.ledsMax, DEFAULT_ZONE_LEDS));
          this.state.zoneSizes[key] = want;
          this.state.zoneAuto[key] = true;
          this.log(`Зона «${z.name}» (${c.name}): размер не указан, ставлю ${want} светодиодов`);
          this._save();
          this._emitState();
        }
        if (want == null || z.ledsMin === z.ledsMax || want === z.ledsCount || want < z.ledsMin || want > z.ledsMax) return;
        client.resizeZone(c.index, zi, want);
        changed = true;
      });
    }
    return changed;
  }

  _applyReal(list) {
    this.real = list.map((c) => {
      const lay = deviceLayout(c);
      let start = 0;
      const zones = [];
      c.zones.forEach((z, index) => {
        zones.push({ name: z.name, index, start, count: z.ledsCount, min: z.ledsMin, max: z.ledsMax, resizable: z.ledsMin !== z.ledsMax });
        start += z.ledsCount;
      });
      return {
        zones,
        id: this._orgbId(c),
        openrgbIdx: c.index, name: c.name, kind: c.kind, vendor: c.vendor || 'OpenRGB', source: 'openrgb',
        leds: lay.leds, aspect: lay.aspect, linear: lay.linear, plate: c.kind === 'keyboard' || c.kind === 'mouse',
      };
    }).filter((d) => d.leds.length > 0 || d.zones.some((z) => z.resizable));
    for (const d of this.real) this.client.setCustomMode(d.openrgbIdx);
    this.log('Устройства движка: ' + this.real.map((d) => `${d.name} [${d.kind}, ${d.leds.length} св., зоны: ${d.zones.map((z) => z.name + '=' + z.count).join(', ')}]`).join('; '));
    this.conn = { ...this.conn, count: this.real.length };
    this._rebuildDevices();
  }

  _onClosed(client) {
    if (this.client !== client) return;
    this.client = null;
    this.real = [];
    this._rebuildDevices();
    this._setConn('disconnected', 'Связь с OpenRGB потеряна');
    this._scheduleRetry(3000);
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    const c = this.client;
    this.client = null;
    if (c) c.close();
    this.real = [];
    this._rebuildDevices();
    this._setConn('disconnected', '');
  }

  // Выключить подсветку на реальном железе (при выходе из приложения)
  shutdown({ lightsOff = false } = {}) {
    this.stop();
    clearInterval(this.scenarioTimer);
    clearInterval(this.rotateTimer);
    clearInterval(this.healthTimer);
    this.notify.stop();
    this.remote.stop();
    this.media.stop();
    clearTimeout(this.healthSoon);
    clearTimeout(this.restartTimer);
    this.sensors.stop();
    clearTimeout(this.refreshTimer);
    this.native.stop();
    this.lianli.stop();
    if (lightsOff && this.client) {
      for (const d of this.real) this.client.setLeds(d.openrgbIdx, new Uint8Array(d.leds.length * 3));
    }
    this.flush();
    clearTimeout(this.retryTimer);
    const c = this.client;
    this.client = null;
    if (c) setTimeout(() => c.close(), 80);
    const eng = this.engineChild;
    this.engineChild = null;
    if (eng) setTimeout(() => { try { eng.kill(); } catch (_) { /* уже закрыт */ } }, 150);
    if (this.state.settings.engineAdmin) setTimeout(() => this.adminEngine.stop(), 150);
  }

  // Полное завершение: ещё и возвращаем оформление Windows, если так настроено
  async finalize() {
    this.shutdown({ lightsOff: false });
    const st = this.state.settings;
    await Promise.race([
      Promise.all([
        this.wintheme.shutdown({ restore: st.winThemeEnabled && st.winRestoreOnExit }),
        this.wallpaper.shutdown({ restore: st.winWallpaper && st.winRestoreOnExit }),
        Promise.resolve(this.live.shutdown()),
        Promise.resolve(this.widgetFeed.stop()),
      ]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }

  begin() {
    this.start();
    const st = this.state.settings;
    if (st.nativeEnabled) this.native.start();
    this._syncWinAccent();
    if (st.winThemeEnabled) this._applyWinCfg();
    else if (this.wintheme.available && this.wintheme.hasBackup()) this.wintheme.restore(); // остаток после аварийного закрытия
    if (st.winWallpaper) this.wallpaper.configure(true);
    else if (this.wallpaper.available && this.wallpaper.hasBackup()) this.wallpaper.restore();
    this._syncLive();
    this._evalScenarios();
    this.scenarioTimer = setInterval(() => this._evalScenarios(), 5000);
    this.lastRotate = Date.now();
    this.rotateTimer = setInterval(() => this._rotatePhoto(), 60000);
    this._syncNotify();
    this._syncRemote();
    this._syncMedia();
    this.healthTimer = setInterval(() => this.checkHealth(), 60000);
    if (this.healthTimer.unref) this.healthTimer.unref();
    setTimeout(() => this.checkHealth(), 12000).unref();
    if (this.rotateTimer.unref) this.rotateTimer.unref();
    if (this.scenarioTimer.unref) this.scenarioTimer.unref();
    if (st.autoConnect || this.bundledEngine) {
      if (this.bundledEngine) this.launchOpenRGB(); // сразу, чтобы движок успел найти устройства
      setTimeout(() => this.connect(), this.bundledEngine ? 2500 : 0);
    }
  }
}

module.exports = { Core, DEFAULTS };
