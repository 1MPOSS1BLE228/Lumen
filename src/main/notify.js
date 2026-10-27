'use strict';
// Подсветка от уведомлений. Windows складывает всплывающие уведомления в свою базу
// (%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db). Раз в пару секунд смотрим,
// не появилось ли новое, и узнаём только ОТ КАКОГО приложения оно пришло — текст сообщений не читаем.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 2000;

// Приложения: как узнать по идентификатору Windows (AUMID) и каким цветом мигать
const APPS = [
  { id: 'discord', name: 'Discord', color: '#5865f2', match: /discord/i },
  { id: 'telegram', name: 'Telegram', color: '#2aabee', match: /telegram/i },
  { id: 'whatsapp', name: 'WhatsApp', color: '#25d366', match: /whatsapp/i },
  { id: 'vk', name: 'VK', color: '#0077ff', match: /(^|[.\\_-])vk([.\\_-]|$)|vkontakte|vk messenger/i },
  { id: 'mail', name: 'Почта и Teams', color: '#0078d4', match: /outlook|mail|teams|thunderbird/i },
  { id: 'steam', name: 'Steam', color: '#66c0f4', match: /steam/i },
];

function classify(aumid) {
  const a = String(aumid || '');
  return APPS.find((x) => x.match.test(a)) || { id: 'other', name: 'Другие приложения', color: null };
}

function loadSqlite() {
  try { return require('node:sqlite'); } catch (_) { return null; }
}

class NotifyWatcher extends EventEmitter {
  // dbPath и sqlite — для тестов
  constructor({ dbPath, sqlite, platform = process.platform } = {}) {
    super();
    this.platform = platform;
    this.dbPath = dbPath || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
    this.sqlite = sqlite === undefined ? loadSqlite() : sqlite;
    this.timer = null;
    this.lastId = null;
    this.lastStamp = '';
    this.status = { state: 'off', message: '' };
  }

  get available() { return !!this.sqlite && (this.platform === 'win32' || fs.existsSync(this.dbPath)); }

  _set(state, message = '') {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit('status', this.status);
  }

  start() {
    if (this.timer) return;
    if (!this.sqlite) { this._set('error', 'Эта функция недоступна в этой версии Windows'); return; }
    this.lastId = null;
    this.lastStamp = '';
    const tick = () => { this.poll(); this.timer = setTimeout(tick, POLL_MS); if (this.timer.unref) this.timer.unref(); };
    tick();
  }

  stop() { clearTimeout(this.timer); this.timer = null; this._set('off'); }

  _stamp() {
    let s = '';
    for (const ext of ['', '-wal']) {
      try { const st = fs.statSync(this.dbPath + ext); s += `${st.size}:${st.mtimeMs};`; } catch (_) { /* нет файла */ }
    }
    return s;
  }

  // Открыть базу только для чтения; если Windows держит её занятой — читаем копию
  _query(sql, args) {
    const tryOpen = (p) => {
      const db = new this.sqlite.DatabaseSync(p, { readOnly: true });
      try { return db.prepare(sql).all(...args); } finally { db.close(); }
    };
    try { return tryOpen(this.dbPath); } catch (_) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-wpn-'));
      try {
        for (const ext of ['', '-wal', '-shm']) { try { fs.copyFileSync(this.dbPath + ext, path.join(dir, 'w.db' + ext)); } catch (_) { /* нет файла */ } }
        return tryOpen(path.join(dir, 'w.db'));
      } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* не страшно */ } }
    }
  }

  poll() {
    const stamp = this._stamp();
    if (!stamp) { this._set('error', 'Не нашёл базу уведомлений Windows'); return; }
    if (stamp === this.lastStamp && this.lastId !== null) return; // ничего не менялось — даже не открываем
    this.lastStamp = stamp;
    try {
      if (this.lastId === null) {
        const r = this._query("SELECT MAX(Id) AS m FROM Notification", []);
        this.lastId = (r[0] && r[0].m) || 0;
        this._set('ok');
        return;
      }
      const rows = this._query("SELECT n.Id AS id, h.PrimaryId AS app FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Type = 'toast' AND n.Id > ? ORDER BY n.Id", [this.lastId]);
      for (const r of rows) {
        this.lastId = Math.max(this.lastId, Number(r.id));
        const app = classify(r.app);
        this.emit('notification', { app: app.id, name: app.name, color: app.color });
      }
      this._set('ok');
    } catch (e) {
      this._set('error', 'Не получилось прочитать уведомления Windows: ' + e.message);
    }
  }
}

module.exports = { NotifyWatcher, APPS, classify };
