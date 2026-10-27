'use strict';
// Поддельный сервер OpenRGB (протокол v3) для тестов: отдаёт два устройства
// и запоминает все присланные кадры.
const net = require('net');

function str(s) {
  const b = Buffer.from(s + '\0', 'utf8');
  const l = Buffer.alloc(2); l.writeUInt16LE(b.length);
  return Buffer.concat([l, b]);
}
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

function mode(name, value) {
  return Buffer.concat([
    str(name), i32(value), u32(0), // name, value, flags
    u32(0), u32(100), u32(0), u32(100), // speed min/max, brightness min/max
    u32(0), u32(0), u32(50), u32(100), // colors min/max, speed, brightness
    u32(0), u32(0), u16(0), // direction, color_mode, num_colors
  ]);
}

function controller(def) {
  const parts = [
    i32(def.type), str(def.name), str('MockVendor'), str('desc'), str('1.0'), str(def.serial), str(def.location),
    u16(2), i32(0), mode('Direct', 0), mode('Static', 1),
    u16(def.zones.length),
  ];
  for (const z of def.zones) {
    const zone = [str(z.name), i32(z.matrix ? 2 : 1), u32(z.min ?? z.count), u32(z.max ?? z.count), u32(z.count)];
    if (z.matrix) {
      const { w, h, cells } = z.matrix;
      zone.push(u16(8 + w * h * 4), u32(h), u32(w), ...cells.map(u32));
    } else zone.push(u16(0));
    parts.push(...zone);
  }
  const total = def.zones.reduce((a, z) => a + z.count, 0);
  parts.push(u16(total));
  for (let i = 0; i < total; i++) parts.push(str('LED ' + i), u32(i));
  parts.push(u16(total));
  for (let i = 0; i < total; i++) parts.push(Buffer.from([0, 0, 0, 0]));
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 4), body]);
}

const DEVICES = [
  {
    type: 5, name: 'Mock Keyboard', serial: 'KB1', location: 'USB 1',
    zones: [{ name: 'Keys', count: 6, matrix: { w: 3, h: 2, cells: [0, 1, 2, 3, 4, 5] } }],
  },
  {
    type: 4, name: 'Mock Strip', serial: 'ST1', location: 'COM3',
    zones: [{ name: 'Strip', count: 10, min: 0, max: 100 }, { name: 'Header 2', count: 0, min: 0, max: 100 }],
  },
];

function startMock({ port = 0, protocol = 3 } = {}) {
  const log = { clientName: null, updates: [], customModes: [], versionRequests: [], resizes: [] };
  const devs = JSON.parse(JSON.stringify(DEVICES));
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const reply = (dev, pkt, payload) => {
      const h = Buffer.alloc(16);
      h.write('ORGB', 0); h.writeUInt32LE(dev, 4); h.writeUInt32LE(pkt, 8); h.writeUInt32LE(payload.length, 12);
      sock.write(Buffer.concat([h, payload]));
    };
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const dev = buf.readUInt32LE(4), pkt = buf.readUInt32LE(8), size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const payload = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        if (pkt === 50) log.clientName = payload.toString('utf8').replace(/\0.*$/, '');
        else if (pkt === 40) { log.versionRequests.push(payload.readUInt32LE(0)); reply(0, 40, u32(Math.min(protocol, payload.readUInt32LE(0)))); }
        else if (pkt === 0) reply(0, 0, u32(devs.length));
        else if (pkt === 1) reply(dev, 1, controller(devs[dev]));
        else if (pkt === 1100) log.customModes.push(dev);
        else if (pkt === 1000) {
          const zi = payload.readInt32LE(0), size = payload.readInt32LE(4);
          log.resizes.push({ dev, zi, size });
          devs[dev].zones[zi].count = size;
          reply(0, 100, Buffer.alloc(0)); // DEVICE_LIST_UPDATED
        }
        else if (pkt === 1050) {
          const n = payload.readUInt16LE(4);
          const rgb = [];
          for (let i = 0; i < n; i++) rgb.push(payload[6 + i * 4], payload[7 + i * 4], payload[8 + i * 4]);
          log.updates.push({ dev, n, rgb, size: payload.readUInt32LE(0), len: payload.length });
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, devs, port: server.address().port })));
}

module.exports = { startMock, DEVICES };
