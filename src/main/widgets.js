'use strict';
// Данные для виджетов на рабочем столе: загрузка процессора и памяти, видеокарта, погода.
// Всё опрашивается редко и только пока виджеты видны: нагрузка — раз в 3 с, погода — раз в 15 минут.
// Погода — бесплатный сервис Open-Meteo (без ключа), город ищется через его же геокодер.
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');

const SYS_MS = 3000;
const WEATHER_MS = 15 * 60000;

// Коды погоды WMO -> подпись и значок
const WMO = {
  0: ['Ясно', 'sun'], 1: ['Почти ясно', 'sun'], 2: ['Переменная облачность', 'cloud-sun'], 3: ['Пасмурно', 'cloud'],
  45: ['Туман', 'fog'], 48: ['Изморозь', 'fog'], 51: ['Морось', 'drizzle'], 53: ['Морось', 'drizzle'], 55: ['Сильная морось', 'drizzle'],
  56: ['Ледяная морось', 'drizzle'], 57: ['Ледяная морось', 'drizzle'], 61: ['Небольшой дождь', 'rain'], 63: ['Дождь', 'rain'], 65: ['Ливень', 'rain'],
  66: ['Ледяной дождь', 'rain'], 67: ['Ледяной дождь', 'rain'], 71: ['Небольшой снег', 'snow'], 73: ['Снег', 'snow'], 75: ['Снегопад', 'snow'], 77: ['Снежная крупа', 'snow'],
  80: ['Ливень', 'rain'], 81: ['Ливень', 'rain'], 82: ['Сильный ливень', 'rain'], 85: ['Снегопад', 'snow'], 86: ['Сильный снегопад', 'snow'],
  95: ['Гроза', 'storm'], 96: ['Гроза с градом', 'storm'], 99: ['Гроза с градом', 'storm'],
};

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.irq + t.idle; }
  return { idle, total };
}

class WidgetFeed extends EventEmitter {
  // netProvider() -> Promise<{ id: [принято, отправлено] } | null> — счётчики сети
  constructor({ sensors, fetchImpl, netProvider } = {}) {
    super();
    this.sensors = sensors;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.netProvider = netProvider || null;
    this.prevNet = null;
    this.diskAt = 0;
    this.cfg = null;
    this.paused = false;
    this.sysTimer = null;
    this.wxTimer = null;
    this.prevCpu = cpuTimes();
    this.data = { cpu: null, ram: null, ramUsed: null, ramTotal: null, gpu: null, gpuTemp: null, vramUsed: null, vramTotal: null, gpuPower: null, down: null, up: null, diskFree: null, diskTotal: null, uptime: null, weather: null };
    this.geo = null; // { name, lat, lon, q }
  }

  // Нужна ли видеокарта (тогда ядро держит датчик включённым)
  get needsGpu() { const i = this.cfg && this.cfg.items; return !!(this.cfg && this.cfg.system && !this.paused && (!i || i.gpu || i.vram)); }

  configure(cfg) {
    const prevCity = this.cfg && `${this.cfg.city}|${this.cfg.lang}`;
    this.cfg = cfg && cfg.enabled ? cfg : null;
    // город поменялся — старая погода больше не годится (даже если сейчас пауза)
    if (this.cfg && prevCity !== `${this.cfg.city}|${this.cfg.lang}`) { this.geo = null; this.data.weather = null; }
    this._restart();
  }

  setPaused(p) {
    if (!!p === this.paused) return;
    this.paused = !!p;
    this._restart();
  }

  _restart() {
    clearTimeout(this.sysTimer); this.sysTimer = null;
    clearTimeout(this.wxTimer); this.wxTimer = null;
    if (!this.cfg || this.paused) return;
    if (this.cfg.system) {
      this.prevCpu = cpuTimes();
      const tick = () => { this._sys(); this.sysTimer = setTimeout(tick, SYS_MS); if (this.sysTimer.unref) this.sysTimer.unref(); };
      this.sysTimer = setTimeout(tick, 600);
    }
    if (this.cfg.weather) {
      const age = this.data.weather ? Date.now() - this.data.weather.at : Infinity;
      const run = () => { this._weather().catch(() => {}); this.wxTimer = setTimeout(run, WEATHER_MS); if (this.wxTimer.unref) this.wxTimer.unref(); };
      this.wxTimer = setTimeout(run, age > WEATHER_MS ? 300 : WEATHER_MS - age);
      if (this.wxTimer.unref) this.wxTimer.unref();
    }
    this.emit('data', this.data);
  }

  async _net() {
    if (!this.netProvider || (this.cfg.items && !this.cfg.items.net)) return;
    const c = await this.netProvider();
    const t = Date.now();
    if (!c) return;
    if (this.prevNet) {
      const dt = (t - this.prevNet.t) / 1000;
      // VPN дублирует трафик на нескольких адаптерах — берём самый загруженный, а не сумму
      let down = 0, up = 0;
      for (const [id, [r, s]] of Object.entries(c)) {
        const p = this.prevNet.c[id];
        if (!p || dt <= 0) continue;
        down = Math.max(down, Math.max(0, r - p[0]) / dt);
        up = Math.max(up, Math.max(0, s - p[1]) / dt);
      }
      this.data.down = Math.round(down);
      this.data.up = Math.round(up);
    }
    this.prevNet = { c, t };
  }

  _disk() {
    if (Date.now() - this.diskAt < 60000 || !fs.statfs) return; // место на диске меняется медленно — раз в минуту
    this.diskAt = Date.now();
    const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
    fs.statfs(root, (e, st) => {
      if (e) return;
      this.data.diskFree = Math.round((st.bavail * st.bsize) / 1073741824);
      this.data.diskTotal = Math.round((st.blocks * st.bsize) / 1073741824);
    });
  }

  async _sys() {
    await this._net().catch(() => {});
    this._disk();
    const now = cpuTimes();
    const di = now.idle - this.prevCpu.idle, dt = now.total - this.prevCpu.total;
    this.prevCpu = now;
    const total = os.totalmem(), free = os.freemem();
    const g = (this.sensors && this.sensors.data) || {};
    Object.assign(this.data, {
      cpu: dt > 0 ? Math.round(100 * (1 - di / dt)) : this.data.cpu,
      ram: Math.round(100 * (1 - free / total)),
      ramUsed: +((total - free) / 1073741824).toFixed(1),
      ramTotal: Math.round(total / 1073741824),
      gpu: g.ok ? g.gpuLoad : null,
      gpuTemp: g.ok ? g.gpuTemp : null,
      vramUsed: g.ok && g.vramUsed != null ? +(g.vramUsed / 1024).toFixed(1) : null,
      vramTotal: g.ok && g.vramTotal != null ? Math.round(g.vramTotal / 1024) : null,
      gpuPower: g.ok ? g.gpuPower : null,
      uptime: Math.round(os.uptime()),
    });
    this.emit('data', this.data);
  }

  async _json(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`сервис погоды ответил ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async _weather() {
    const city = String((this.cfg && this.cfg.city) || '').trim();
    if (!city) { this.data.weather = { error: 'Укажи город в настройках виджетов', at: Date.now() }; this.emit('data', this.data); return; }
    try {
      const lang = (this.cfg && this.cfg.lang) || 'ru';
      if (!this.geo || this.geo.q !== city + '|' + lang) {
        const g = await this._json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=${lang}&format=json`);
        const r = g.results && g.results[0];
        if (!r) throw new Error(`не нашёл город «${city}»`);
        this.geo = { q: city + '|' + lang, name: r.name, lat: r.latitude, lon: r.longitude };
      }
      const w = await this._json(`https://api.open-meteo.com/v1/forecast?latitude=${this.geo.lat}&longitude=${this.geo.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&timezone=auto&forecast_days=4&wind_speed_unit=ms`);
      const c = w.current || {};
      const [text, icon] = WMO[c.weather_code] || ['', 'cloud'];
      this.data.weather = {
        city: this.geo.name, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
        wind: Math.round(c.wind_speed_10m), text, icon: icon === 'sun' && c.is_day === 0 ? 'moon' : icon,
        max: w.daily ? Math.round(w.daily.temperature_2m_max[0]) : null, min: w.daily ? Math.round(w.daily.temperature_2m_min[0]) : null,
        humidity: c.relative_humidity_2m == null ? null : Math.round(c.relative_humidity_2m),
        rain: w.daily && w.daily.precipitation_probability_max ? w.daily.precipitation_probability_max[0] : null,
        // прогноз на 3 следующих дня
        days: w.daily && w.daily.time ? w.daily.time.slice(1, 4).map((d, i) => ({
          date: d, max: Math.round(w.daily.temperature_2m_max[i + 1]), min: Math.round(w.daily.temperature_2m_min[i + 1]),
          icon: (WMO[w.daily.weather_code[i + 1]] || ['', 'cloud'])[1],
        })) : [],
        at: Date.now(),
      };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'сервис погоды не ответил' : /fetch failed|ENOTFOUND|net::/i.test(e.message) ? 'нет интернета' : e.message;
      // старые данные оставляем, если они свежее часа
      if (!this.data.weather || this.data.weather.error || Date.now() - this.data.weather.at > 3600000) this.data.weather = { error: 'Погода: ' + msg, at: Date.now() };
    }
    this.emit('data', this.data);
  }

  stop() { this.cfg = null; this._restart(); }
}

module.exports = { WidgetFeed, WMO };
