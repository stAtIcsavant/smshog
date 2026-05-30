/**
 * db.js — SQLite persistence layer for SMSHog
 *
 * All writes are synchronous (better-sqlite3) so there's no async
 * complexity in the hot path, and the file is safe across restarts.
 *
 * Data file location:
 *   $SMSHOG_DATA_DIR/smshog.db   (default: /app/data/smshog.db in container)
 *   Falls back to ./smshog.db for local dev.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.SMSHOG_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'smshog.db'));

// WAL mode for concurrent reads without blocking writes
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    sid              TEXT NOT NULL,
    "to"             TEXT NOT NULL,
    "from"           TEXT NOT NULL DEFAULT '',
    body             TEXT NOT NULL DEFAULT '',
    media_url        TEXT,
    status           TEXT NOT NULL DEFAULT 'queued',
    source           TEXT NOT NULL DEFAULT 'custom-api',
    status_callback_url TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    status_history   TEXT NOT NULL DEFAULT '[]',
    deleted          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id         TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_status TEXT,
    last_code   INTEGER,
    last_error  TEXT,
    last_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Idempotent ALTER for legacy webhooks tables that predate the result columns
for (const col of [
  ['last_status', 'TEXT'], ['last_code', 'INTEGER'],
  ['last_error', 'TEXT'],  ['last_at', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE webhooks ADD COLUMN ${col[0]} ${col[1]}`); } catch (_) { /* already exists */ }
}

// Seed default settings if first run
const defaultSettings = {
  deliverySimEnabled: 'true',
  deliveryDelayMs: '1500',
  deliveryFailRate: '0.05',
};
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sid: row.sid,
    to: row.to,
    from: row.from,
    body: row.body,
    mediaUrl: row.media_url || null,
    status: row.status,
    source: row.source,
    statusCallbackUrl: row.status_callback_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusHistory: JSON.parse(row.status_history || '[]'),
  };
}

function rowToWebhook(row) {
  return {
    id: row.id, url: row.url, active: !!row.active, createdAt: row.created_at,
    lastStatus: row.last_status || null,
    lastCode: row.last_code ?? null,
    lastError: row.last_error || null,
    lastAt: row.last_at || null,
  };
}

// ── Messages ──────────────────────────────────────────────────────────────────

const stmts = {
  insertMsg: db.prepare(`
    INSERT INTO messages (id, sid, "to", "from", body, media_url, status, source,
      status_callback_url, created_at, updated_at, status_history)
    VALUES (@id, @sid, @to, @from, @body, @mediaUrl, @status, @source,
      @statusCallbackUrl, @createdAt, @updatedAt, @statusHistory)
  `),
  updateStatus: db.prepare(`
    UPDATE messages SET status = @status, updated_at = @updatedAt,
      status_history = @statusHistory WHERE id = @id
  `),
  deleteMsg: db.prepare(`UPDATE messages SET deleted = 1 WHERE id = ?`),
  clearMsgs: db.prepare(`UPDATE messages SET deleted = 1`),
  getMsg: db.prepare(`SELECT * FROM messages WHERE id = ? AND deleted = 0`),
  getMsgBySid: db.prepare(`SELECT * FROM messages WHERE sid = ? AND deleted = 0`),
  listMsgs: db.prepare(`SELECT * FROM messages WHERE deleted = 0 ORDER BY created_at DESC`),
  searchMsgs: db.prepare(`
    SELECT * FROM messages WHERE deleted = 0
    AND (body LIKE @q OR "to" LIKE @q OR "from" LIKE @q)
    ORDER BY created_at DESC
  `),
  setCallbackUrl: db.prepare(`UPDATE messages SET status_callback_url = ? WHERE id = ?`),

  insertWebhook: db.prepare(`INSERT INTO webhooks (id, url, active, created_at) VALUES (@id, @url, @active, @createdAt)`),
  updateWebhook: db.prepare(`UPDATE webhooks SET url = @url, active = @active WHERE id = @id`),
  updateWebhookResult: db.prepare(`UPDATE webhooks SET last_status = @lastStatus, last_code = @lastCode, last_error = @lastError, last_at = @lastAt WHERE id = @id`),
  deleteWebhook: db.prepare(`DELETE FROM webhooks WHERE id = ?`),
  listWebhooks: db.prepare(`SELECT * FROM webhooks ORDER BY created_at ASC`),
  getWebhook: db.prepare(`SELECT * FROM webhooks WHERE id = ?`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),
  allSettings: db.prepare(`SELECT key, value FROM settings`),
};

// Messages
module.exports.insertMessage = (msg) => stmts.insertMsg.run({
  ...msg,
  statusHistory: JSON.stringify(msg.statusHistory),
  mediaUrl: msg.mediaUrl || null,
  statusCallbackUrl: msg.statusCallbackUrl || null,
});
module.exports.updateMessageStatus = (id, status, updatedAt, statusHistory) =>
  stmts.updateStatus.run({ id, status, updatedAt, statusHistory: JSON.stringify(statusHistory) });
module.exports.deleteMessage = (id) => stmts.deleteMsg.run(id);
module.exports.clearMessages = () => stmts.clearMsgs.run();
module.exports.getMessage = (id) => rowToMessage(stmts.getMsg.get(id));
module.exports.getMessageBySid = (sid) => rowToMessage(stmts.getMsgBySid.get(sid));
module.exports.listMessages = (q) => {
  if (q) return stmts.searchMsgs.all({ q: `%${q}%` }).map(rowToMessage);
  return stmts.listMsgs.all().map(rowToMessage);
};
module.exports.setCallbackUrl = (id, url) => stmts.setCallbackUrl.run(url, id);

// Webhooks
module.exports.insertWebhook = (h) => stmts.insertWebhook.run({ ...h, active: h.active ? 1 : 0 });
module.exports.updateWebhook = (h) => stmts.updateWebhook.run({ ...h, active: h.active ? 1 : 0 });
module.exports.updateWebhookResult = (id, r) => stmts.updateWebhookResult.run({
  id, lastStatus: r.lastStatus, lastCode: r.lastCode ?? null, lastError: r.lastError ?? null, lastAt: r.lastAt,
});
module.exports.deleteWebhook = (id) => stmts.deleteWebhook.run(id);
module.exports.listWebhooks = () => stmts.listWebhooks.all().map(rowToWebhook);
module.exports.getWebhook = (id) => { const r = stmts.getWebhook.get(id); return r ? rowToWebhook(r) : null; };

// Settings
module.exports.getSetting = (key) => { const r = stmts.getSetting.get(key); return r ? r.value : null; };
module.exports.setSetting = (key, value) => stmts.setSetting.run(key, String(value));
module.exports.getAllSettings = () => {
  const rows = stmts.allSettings.all();
  const out = {};
  for (const r of rows) {
    // Coerce booleans and numbers back from string storage
    if (r.value === 'true') out[r.key] = true;
    else if (r.value === 'false') out[r.key] = false;
    else if (!isNaN(r.value) && r.value !== '') out[r.key] = Number(r.value);
    else out[r.key] = r.value;
  }
  return out;
};
module.exports.patchSettings = (patch) => {
  for (const [k, v] of Object.entries(patch)) module.exports.setSetting(k, v);
  return module.exports.getAllSettings();
};

module.exports.db = db; // expose for graceful shutdown
