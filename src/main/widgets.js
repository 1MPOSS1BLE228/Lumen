'use strict';
// Данные для виджетов на рабочем столе: загрузка процессора и памяти, видеокарта, погода.
// Всё опрашивается редко и только пока виджеты видны: нагрузка — раз в 3 с, погода — раз в 15 минут.
// Погода — бесплатные сервисы без ключа, по очереди: Open-Meteo, MET Norway (yr.no), wttr.in.
// Если один не отвечает или ограничил запросы, берём следующий; тот, что сработал, спрашиваем первым.
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

const UA = 'Lumen (https://github.com/1MPOSS1BLE228/Lumen)';
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Значки MET Norway (clearsky_day, lightrainshowers_night…) -> код WMO
function metCode(sym) {
  const s = String(sym || '').replace(/_(day|night|polartwilight)$/, '');
  if (/thunder/.test(s)) return 95;
  if (s === 'clearsky') return 0;
  if (s === 'fair') return 1;
  if (s === 'partlycloudy') return 2;
  if (s === 'cloudy') return 3;
  if (s === 'fog') return 45;
  if (/sleet/.test(s)) return 66;
  if (/snow/.test(s)) return /^heavy/.test(s) ? 75 : /^light/.test(s) ? 71 : 73;
  if (/rain/.test(s)) return /^heavy/.test(s) ? 65 : /^light/.test(s) ? 61 : 63;
  return 3;
}

// Коды World Weather Online (их отдаёт wttr.in) -> код WMO
function wwoCode(c) {
  const n = Number(c);
  const g = [[[113], 0], [[116], 2], [[119, 122], 3], [[143, 248], 45], [[260], 48], [[263, 266], 51], [[176, 293, 296, 353], 61], [[299, 302, 356], 63], [[305, 308, 359], 65],
    [[179, 182, 185, 281, 284, 311, 314, 317, 320, 350, 362, 365, 374, 377], 66], [[323, 326, 368], 71], [[227, 329, 332, 371], 73], [[230, 335, 338, 392, 395], 75], [[200, 386, 389], 95]];
  for (const [list, code] of g) if (list.includes(n)) return code;
  return 3;
}

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

  async _json(url, ms = 9000) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.status === 429) throw new Error('сервис погоды просит подождать');
      if (!r.ok) throw new Error(`сервис погоды ответил ${r.status}`);
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  // Координаты города: геокодер Open-Meteo, запасной — OpenStreetMap (Nominatim)
  async _geo(city, lang) {
    const q = city + '|' + lang;
    if (this.geo && this.geo.q === q) return this.geo;
    let res = null, err = null;
    try {
      const g = await this._json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=${lang}&format=json`);
      const r = g.results && g.results[0];
      if (r) res = { q, name: r.name, lat: r.latitude, lon: r.longitude };
      else err = new Error(`не нашёл город «${city}»`);
    } catch (e) { err = e; }
    if (!res) {
      try {
        const g = await this._json(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1&accept-language=${lang}`);
        const r = Array.isArray(g) && g[0];
        if (r) res = { q, name: String(r.name || r.display_name || city).split(',')[0], lat: Number(r.lat), lon: Number(r.lon) };
      } catch (e) { if (!err) err = e; }
    }
    if (!res) throw err || new Error(`не нашёл город «${city}»`);
    this.geo = res;
    return res;
  }

  async _openMeteo(city, lang) {
    const geo = await this._geo(city, lang);
    const w = await this._json(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max&timezone=auto&forecast_days=4&wind_speed_unit=ms`);
    const c = w.current || {};
    if (c.temperature_2m == null) throw new Error('пустой ответ');
    return {
      city: geo.name, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), code: c.weather_code, night: c.is_day === 0,
      wind: Math.round(c.wind_speed_10m), humidity: c.relative_humidity_2m == null ? null : Math.round(c.relative_humidity_2m),
      max: w.daily ? Math.round(w.daily.temperature_2m_max[0]) : null, min: w.daily ? Math.round(w.daily.temperature_2m_min[0]) : null,
      rain: w.daily && w.daily.precipitation_probability_max ? w.daily.precipitation_probability_max[0] : null,
      days: w.daily && w.daily.time ? w.daily.time.slice(1, 4).map((d, i) => ({ date: d, max: Math.round(w.daily.temperature_2m_max[i + 1]), min: Math.round(w.daily.temperature_2m_min[i + 1]), code: w.daily.weather_code[i + 1] })) : [],
    };
  }

  // MET Norway (yr.no): почасовой прогноз, дни собираем сами
  async _metNo(city, lang) {
    const geo = await this._geo(city, lang);
    const d = await this._json(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${(+geo.lat).toFixed(3)}&lon=${(+geo.lon).toFixed(3)}`);
    const ts = (d.properties && d.properties.timeseries) || [];
    if (!ts.length) throw new Error('пустой ответ');
    const sym = (t) => ((t.data.next_1_hours || t.data.next_6_hours || {}).summary || {}).symbol_code || '';
    const now = ts[0].data.instant.details;
    const byDay = new Map();
    for (const t of ts) {
      const day = localDate(new Date(t.time));
      const v = t.data.instant.details.air_temperature;
      const e = byDay.get(day) || { max: -Infinity, min: Infinity, code: null, noon: Infinity };
      e.max = Math.max(e.max, v); e.min = Math.min(e.min, v);
      const off = Math.abs(new Date(t.time).getHours() - 13); // значок дня — ближе к полудню
      if (off < e.noon && sym(t)) { e.noon = off; e.code = metCode(sym(t)); }
      byDay.set(day, e);
    }
    const days = [...byDay.entries()];
    const today = days[0][1];
    return {
      city: geo.name, temp: Math.round(now.air_temperature), feels: Math.round(now.air_temperature), code: metCode(sym(ts[0])), night: /_night/.test(sym(ts[0])),
      wind: Math.round(now.wind_speed), humidity: now.relative_humidity == null ? null : Math.round(now.relative_humidity),
      max: Math.round(today.max), min: Math.round(today.min), rain: null,
      days: days.slice(1, 4).map(([date, e]) => ({ date, max: Math.round(e.max), min: Math.round(e.min), code: e.code })),
    };
  }

  // wttr.in: сам ищет город по названию
  async _wttr(city, lang) {
    const d = await this._json(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=${lang}`);
    const c = d.current_condition && d.current_condition[0];
    if (!c) throw new Error('пустой ответ');
    const w = d.weather || [];
    const area = d.nearest_area && d.nearest_area[0];
    const name = (area && area.areaName && area.areaName[0] && area.areaName[0].value) || city;
    const rainOf = (x) => Math.max(0, ...(x.hourly || []).map((h) => Number(h.chanceofrain) || 0));
    const hour = new Date().getHours();
    return {
      city: name, temp: Number(c.temp_C), feels: Number(c.FeelsLikeC), code: wwoCode(c.weatherCode), night: hour < 6 || hour >= 20,
      wind: Math.round((Number(c.windspeedKmph) || 0) / 3.6), humidity: c.humidity == null ? null : Number(c.humidity),
      max: w[0] ? Number(w[0].maxtempC) : null, min: w[0] ? Number(w[0].mintempC) : null, rain: w[0] ? rainOf(w[0]) : null,
      days: w.slice(1, 4).map((x) => ({ date: x.date, max: Number(x.maxtempC), min: Number(x.mintempC), code: wwoCode((x.hourly[4] || x.hourly[0] || {}).weatherCode) })),
    };
  }

  async _weather() {
    const city = String((this.cfg && this.cfg.city) || '').trim();
    if (!city) { this.data.weather = { error: 'Укажи город в настройках виджетов', at: Date.now() }; this.emit('data', this.data); return; }
    const lang = (this.cfg && this.cfg.lang) || 'ru';
    const all = { openmeteo: () => this._openMeteo(city, lang), metno: () => this._metNo(city, lang), wttr: () => this._wttr(city, lang) };
    const order = [this.wxBest, ...Object.keys(all)].filter((k, i, a) => k && all[k] && a.indexOf(k) === i);
    let first = null;
    for (const k of order) {
      try {
        const r = await all[k]();
        this.wxBest = k;
        const [text, icon] = WMO[r.code] || ['', 'cloud'];
        this.data.weather = {
          city: r.city, temp: r.temp, feels: r.feels, wind: r.wind, text, icon: icon === 'sun' && r.night ? 'moon' : icon,
          max: r.max, min: r.min, humidity: r.humidity, rain: r.rain,
          days: (r.days || []).map((x) => ({ date: x.date, max: x.max, min: x.min, icon: (WMO[x.code] || ['', 'cloud'])[1] })),
          source: k, at: Date.now(),
        };
        this.emit('data', this.data);
        return;
      } catch (e) {
        if (/не нашёл город/.test(e.message)) { first = e; break; }
        if (!first) first = e;
      }
    }
    const e = first || new Error('нет ответа');
    const msg = e.name === 'AbortError' ? 'сервисы погоды не ответили' : /fetch failed|ENOTFOUND|net::/i.test(e.message) ? 'нет интернета' : e.message;
    // старые данные оставляем, если они свежее часа
    if (!this.data.weather || this.data.weather.error || Date.now() - this.data.weather.at > 3600000) this.data.weather = { error: 'Погода: ' + msg, at: Date.now() };
    this.emit('data', this.data);
  }

  // «Сейчас играет» — приходит от MediaWatcher
  setMedia(m) {
    const before = JSON.stringify(this.data.media || null);
    this.data.media = m || null;
    if (JSON.stringify(this.data.media) !== before) this.emit('data', this.data);
  }

  setLyrics(l) {
    if ((this.data.lyrics && this.data.lyrics.key) === (l && l.key)) return;
    this.data.lyrics = l || null;
    this.emit('data', this.data);
  }

  stop() { this.cfg = null; this._restart(); }
}

module.exports = { WidgetFeed, WMO, metCode, wwoCode };
