'use strict';
// Клиент сетевого протокола OpenRGB SDK (TCP, порт 6742 по умолчанию).
// OpenRGB — бесплатная программа, которая умеет управлять подсветкой
// материнских плат, памяти, видеокарт, клавиатур, мышей и т.д. от сотен моделей.
const net = require('net');
const { EventEmitter } = require('events');

const MAGIC = Buffer.from('ORGB');
const PKT = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  RESIZEZONE: 1000,
  UPDATELEDS: 1050,
  SETCUSTOMMODE: 1100,
};
// Мы говорим на версии 3: она есть и у старых, и у новых серверов OpenRGB
const CLIENT_PROTOCOL = 3;

const DEVICE_TYPES = {
  0: 'motherboard', 1: 'ram', 2: 'gpu', 3: 'cooler', 4: 'strip', 5: 'keyboard', 6: 'mouse',
  7: 'mousemat', 8: 'headset', 9: 'headset-stand', 10: 'gamepad', 11: 'light', 12: 'speaker',
  13: 'virtual', 14: 'storage', 15: 'case', 16: 'keypad',
};

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  str() {
    const len = this.u16();
    if (this.o + len > this.b.length) throw new RangeError('string out of range');
    const s = this.b.toString('utf8', this.o, this.o + Math.max(0, len - 1));
    this.o += len;
    return s;
  }
  skip(n) { this.o += n; }
}

// Разбор описания устройства (формат протокола версий 0..3)
function parseController(buf, version, index) {
  const r = new Reader(buf);
  r.u32(); // размер данных
  const type = r.i32();
  const name = r.str();
  const vendor = version >= 1 ? r.str() : '';
  const description = r.str();
  const fwVersion = r.str();
  const serial = r.str();
  const location = r.str();

  const numModes = r.u16();
  const activeMode = r.i32();
  const modes = [];
  for (let m = 0; m < numModes; m++) {
    const mode = { name: r.str(), value: r.i32(), flags: r.u32() };
    r.u32(); r.u32(); // speed_min, speed_max
    if (version >= 3) { r.u32(); r.u32(); } // brightness_min, brightness_max
    r.u32(); r.u32(); // colors_min, colors_max
    r.u32(); // speed
    if (version >= 3) r.u32(); // brightness
    r.u32(); r.u32(); // direction, color_mode
    const nc = r.u16();
    r.skip(nc * 4);
    modes.push(mode);
  }

  const numZones = r.u16();
  const zones = [];
  for (let z = 0; z < numZones; z++) {
    const zone = { name: r.str(), type: r.i32() };
    zone.ledsMin = r.u32();
    zone.ledsMax = r.u32();
    zone.ledsCount = r.u32();
    const matrixLen = r.u16();
    zone.matrix = null;
    if (matrixLen > 0) {
      const start = r.o;
      const height = r.u32();
      const width = r.u32();
      const cells = [];
      for (let k = 0; k < height * width; k++) cells.push(r.u32());
      zone.matrix = { height, width, cells };
      r.o = start + matrixLen;
    }
    if (version >= 4) {
      const ns = r.u16();
      for (let s = 0; s < ns; s++) { r.str(); r.i32(); r.u32(); r.u32(); }
    }
    zones.push(zone);
  }

  const numLeds = r.u16();
  const leds = [];
  for (let l = 0; l < numLeds; l++) { leds.push({ name: r.str(), value: r.u32() }); }

  return {
    index, type, kind: DEVICE_TYPES[type] || 'unknown', name, vendor, description,
    version: fwVersion, serial, location, activeMode, modes, zones, leds, ledCount: numLeds,
  };
}

// Положение светодиодов устройства для превью и пространственных эффектов
function deviceLayout(ctrl) {
  const n = ctrl.ledCount;
  const pos = new Array(n).fill(null);
  let offset = 0;
  const zones = ctrl.zones.filter((z) => z.ledsCount > 0);
  const linearZones = [];
  let matrixSeen = null;

  zones.forEach((z, zi) => {
    if (z.matrix && z.matrix.width > 0 && z.matrix.height > 0) {
      const { width, height, cells } = z.matrix;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          const v = cells[row * width + col];
          if (v === 0xffffffff || v >= z.ledsCount) continue;
          const idx = offset + v;
          if (idx < n) pos[idx] = { x: width > 1 ? col / (width - 1) : 0.5, y: height > 1 ? row / (height - 1) : 0.5 };
        }
      }
      matrixSeen = matrixSeen || { width, height };
    } else {
      linearZones.push({ z, offset, zi });
    }
    offset += z.ledsCount;
  });

  const rows = Math.max(1, linearZones.length);
  linearZones.forEach(({ z, offset: off }, li) => {
    const cnt = z.ledsCount;
    for (let j = 0; j < cnt; j++) {
      if (off + j >= n) break;
      pos[off + j] = { x: cnt > 1 ? j / (cnt - 1) : 0.5, y: rows > 1 ? li / (rows - 1) : 0.5 };
    }
  });

  // Всё, что не попало ни в одну зону, раскладываем по линии
  const missing = [];
  pos.forEach((p, i) => { if (!p) missing.push(i); });
  missing.forEach((idx, j) => { pos[idx] = { x: missing.length > 1 ? j / (missing.length - 1) : 0.5, y: 0.5 }; });

  // Клавиатура без матрицы — выложим сеткой 6 рядов
  if (ctrl.kind === 'keyboard' && !matrixSeen && linearZones.length === 1 && n > 30) {
    const rowsK = 6;
    const cols = Math.ceil(n / rowsK);
    for (let i = 0; i < n; i++) pos[i] = { x: (i % cols) / (cols - 1), y: Math.floor(i / cols) / (rowsK - 1) };
  }

  let aspect = 4;
  if (matrixSeen) aspect = Math.max(0.6, Math.min(5, (matrixSeen.width / matrixSeen.height) * 1.1));
  else if (ctrl.kind === 'keyboard') aspect = 3;
  else if (ctrl.kind === 'mouse') aspect = 0.7;
  else if (ctrl.kind === 'strip') aspect = 6;

  const ys = pos.map((p) => p.y);
  const linear = Math.max(...ys) - Math.min(...ys) < 0.2;
  return { leds: pos, aspect, linear };
}

class OpenRGBClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 6742, name = 'Lumen' } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.name = name;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.version = 0;
    this.connected = false;
  }

  async connect(timeoutMs = 3000) {
    await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      this.sock = s;
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; s.destroy(); reject(new Error('Нет ответа от OpenRGB (таймаут)')); } }, timeoutMs);
      s.once('connect', () => { settled = true; clearTimeout(t); resolve(); });
      s.on('error', (e) => {
        if (!settled) { settled = true; clearTimeout(t); reject(e); } else this.emit('soft-error', e);
      });
    });
    const s = this.sock;
    s.setNoDelay(true);
    s.on('data', (d) => this._onData(d));
    s.on('close', () => {
      this._failAll(new Error('Соединение закрыто'));
      if (this.connected) { this.connected = false; this.emit('close'); }
    });
    this.connected = true;
    this._send(0, PKT.SET_CLIENT_NAME, Buffer.from(this.name + '\0', 'utf8'));
    try {
      const v = Buffer.alloc(4); v.writeUInt32LE(CLIENT_PROTOCOL);
      const reply = await this._request(0, PKT.REQUEST_PROTOCOL_VERSION, v, 1500);
      this.version = Math.min(CLIENT_PROTOCOL, reply.readUInt32LE(0));
    } catch (_) {
      this.version = 0; // очень старый сервер без согласования версии
    }
  }

  async listDevices() {
    const cnt = (await this._request(0, PKT.REQUEST_CONTROLLER_COUNT, null, 3000)).readUInt32LE(0);
    const out = [];
    for (let i = 0; i < cnt; i++) {
      let payload = null;
      if (this.version >= 1) { payload = Buffer.alloc(4); payload.writeUInt32LE(this.version); }
      const data = await this._request(i, PKT.REQUEST_CONTROLLER_DATA, payload, 5000);
      try { out.push(parseController(data, this.version, i)); } catch (e) { this.emit('soft-error', e); }
    }
    return out;
  }

  // Размер «ручной» зоны (ARGB-разъёмы плат): сколько светодиодов подключено
  resizeZone(devIdx, zoneIdx, size) {
    if (!this.connected) return;
    const p = Buffer.alloc(8);
    p.writeInt32LE(zoneIdx, 0);
    p.writeInt32LE(size, 4);
    this._send(devIdx, PKT.RESIZEZONE, p);
  }

  setCustomMode(devIdx) { if (this.connected) this._send(devIdx, PKT.SETCUSTOMMODE, null); }

  // rgb — Uint8Array из троек r,g,b
  setLeds(devIdx, rgb) {
    if (!this.connected || !this.sock || this.sock.destroyed) return false;
    if (this.sock.writableLength > 512 * 1024) return false; // сервер не успевает — пропускаем кадр
    const n = rgb.length / 3;
    const p = Buffer.alloc(6 + n * 4);
    p.writeUInt32LE(p.length, 0);
    p.writeUInt16LE(n, 4);
    for (let i = 0; i < n; i++) {
      p[6 + i * 4] = rgb[i * 3];
      p[7 + i * 4] = rgb[i * 3 + 1];
      p[8 + i * 4] = rgb[i * 3 + 2];
    }
    this._send(devIdx, PKT.UPDATELEDS, p);
    return true;
  }

  close() {
    this.connected = false;
    this._failAll(new Error('Отключено'));
    if (this.sock) { this.sock.removeAllListeners('data'); this.sock.destroy(); this.sock = null; }
  }

  _send(devIdx, pktId, payload) {
    if (!this.sock || this.sock.destroyed) return;
    const p = payload || Buffer.alloc(0);
    const h = Buffer.alloc(16);
    MAGIC.copy(h, 0);
    h.writeUInt32LE(devIdx, 4);
    h.writeUInt32LE(pktId, 8);
    h.writeUInt32LE(p.length, 12);
    this.sock.write(p.length ? Buffer.concat([h, p]) : h);
  }

  _request(devIdx, pktId, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { devIdx, pktId, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('Нет ответа от OpenRGB'));
      }, timeoutMs);
      this.waiters.push(w);
      this._send(devIdx, pktId, payload);
    });
  }

  _failAll(err) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.reject(err); }
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 16) return;
      if (this.buf.compare(MAGIC, 0, 4, 0, 4) !== 0) {
        const at = this.buf.indexOf(MAGIC, 1);
        this.buf = at < 0 ? Buffer.alloc(0) : this.buf.subarray(at);
        continue;
      }
      const devIdx = this.buf.readUInt32LE(4);
      const pktId = this.buf.readUInt32LE(8);
      const size = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + size) return;
      const payload = Buffer.from(this.buf.subarray(16, 16 + size));
      this.buf = this.buf.subarray(16 + size);
      const wi = this.waiters.findIndex((w) => w.pktId === pktId && (pktId !== PKT.REQUEST_CONTROLLER_DATA || w.devIdx === devIdx));
      if (wi >= 0) {
        const [w] = this.waiters.splice(wi, 1);
        clearTimeout(w.timer);
        w.resolve(payload);
      } else if (pktId === PKT.DEVICE_LIST_UPDATED) {
        this.emit('devices-changed');
      }
    }
  }
}

module.exports = { OpenRGBClient, parseController, deviceLayout, PKT, DEVICE_TYPES };
