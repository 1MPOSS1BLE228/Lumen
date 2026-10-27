'use strict';
// Управление с телефона: маленький веб-сервер в домашней сети. Телефон открывает ссылку из QR-кода
// и переключает подсветку. В ссылке секретный ключ — без него сервер ничего не делает.
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { qrSvg } = require('./qr');

const DEFAULT_PORT = 47800;

function newToken() { return crypto.randomBytes(16).toString('base64url'); }

// Адрес компьютера в домашней сети (Wi-Fi или кабель), без виртуальных адаптеров
function lanAddress() {
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(ifs)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      const virt = /virtual|vmware|vbox|hyper-v|vethernet|wsl|tap|tun|wintun|wireguard|zerotier|tailscale|hamachi|radmin|loopback/i.test(name);
      const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      cands.push({ ip, score: (priv ? 2 : 0) + (virt ? -3 : 1) + (/^192\.168\./.test(ip) ? 1 : 0) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.length ? cands[0].ip : '';
}

class RemoteServer extends EventEmitter {
  // api: { state(), act(cmd) } — что показать и что сделать; page(lang) -> html
  constructor({ api, page }) {
    super();
    this.api = api;
    this.page = page;
    this.server = null;
    this.cfg = null;
    this.status = { state: 'off', message: '', url: '', qr: '' };
  }

  _set(state, message = '') {
    const ip = lanAddress();
    const url = this.cfg && state === 'ok' && ip ? `http://${ip}:${this.cfg.port}/?t=${this.cfg.token}` : '';
    this.status = { state, message, url, qr: url ? qrSvg(url) : '' };
    this.emit('status', this.status);
  }

  configure(cfg) {
    const want = cfg && cfg.enabled ? { port: cfg.port || DEFAULT_PORT, token: cfg.token } : null;
    const same = this.cfg && want && this.cfg.port === want.port && this.cfg.token === want.token;
    if (same && this.server) return;
    this.stop(!!want);
    this.cfg = want;
    if (want) this._listen();
  }

  _ok(t) {
    if (!this.cfg || typeof t !== 'string') return false;
    const a = Buffer.from(t), b = Buffer.from(this.cfg.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _listen() {
    const srv = http.createServer((req, res) => this._handle(req, res));
    srv.on('error', (e) => this._set('error', e.code === 'EADDRINUSE' ? `Порт ${this.cfg.port} занят другой программой` : e.message));
    srv.listen(this.cfg.port, '0.0.0.0', () => this._set('ok'));
    this.server = srv;
  }

  _send(res, code, type, body) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(body);
  }

  _handle(req, res) {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (_) { this._send(res, 400, 'text/plain', 'bad'); return; }
    const token = u.searchParams.get('t') || req.headers['x-lumen-key'];
    if (!this._ok(token)) { this._send(res, 403, 'text/plain; charset=utf-8', 'Lumen: open the link from the QR code in Lumen settings.'); return; }
    if (req.method === 'GET' && u.pathname === '/') { this._send(res, 200, 'text/html; charset=utf-8', this.page()); return; }
    if (req.method === 'GET' && u.pathname === '/api/state') { this._send(res, 200, 'application/json', JSON.stringify(this.api.state())); return; }
    if (req.method === 'POST' && u.pathname === '/api/act') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let cmd = null;
        try { cmd = JSON.parse(body); } catch (_) { /* мусор */ }
        const ok = cmd && typeof cmd === 'object' ? this.api.act(cmd) : false;
        this._send(res, ok ? 200 : 400, 'application/json', JSON.stringify({ ok: !!ok, state: this.api.state() }));
      });
      return;
    }
    this._send(res, 404, 'text/plain', 'not found');
  }

  stop(keepStatus) {
    if (this.server) { try { this.server.close(); } catch (_) { /* уже */ } this.server = null; }
    if (!keepStatus) { this.cfg = null; this._set('off'); }
  }
}

module.exports = { RemoteServer, newToken, lanAddress, DEFAULT_PORT };
