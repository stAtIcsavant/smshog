const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const axios = require('axios').default;
const qs = require('qs');
const db = require('./db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Settings (in-memory cache, synced with DB) ────────────────────────────────

let settings = db.getAllSettings();

// ── Message lifecycle ─────────────────────────────────────────────────────────

function createMessage({ to, from, body, mediaUrl, source, statusCallbackUrl, initialStatus = 'queued' }) {
  const now = new Date().toISOString();
  const msg = {
    id: uuid(),
    sid: 'SM' + uuid().replace(/-/g, '').slice(0, 32),
    to: to || '',
    from: from || '',
    body: body || '',
    mediaUrl: mediaUrl || null,
    status: initialStatus,
    source,
    statusCallbackUrl: statusCallbackUrl || null,
    createdAt: now,
    updatedAt: now,
    statusHistory: [{ status: initialStatus, at: now }],
  };
  db.insertMessage(msg);
  if (initialStatus === 'queued' && settings.deliverySimEnabled) simulateDelivery(msg);
  forwardToWebhooks(msg);
  return msg;
}

function updateStatus(msgId, status) {
  const msg = db.getMessage(msgId);
  if (!msg) return null;
  const updatedAt = new Date().toISOString();
  const statusHistory = [...msg.statusHistory, { status, at: updatedAt }];
  db.updateMessageStatus(msgId, status, updatedAt, statusHistory);
  return { ...msg, status, updatedAt, statusHistory };
}

// Rewrite host-local URLs so the container can reach the developer's machine.
// Inside the container, `localhost` is the container itself; the host is
// reachable as `host.docker.internal` on Docker Desktop.
function containerOutboundUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
      u.hostname = 'host.docker.internal';
      return u.toString();
    }
  } catch (_) { /* leave malformed URLs alone */ }
  return url;
}

// ── Delivery simulation ───────────────────────────────────────────────────────

async function simulateDelivery(msg) {
  const delay = settings.deliveryDelayMs;
  await sleep(delay * 0.3);
  updateStatus(msg.id, 'sending');

  await sleep(delay * 0.7);
  const failed = Math.random() < settings.deliveryFailRate;
  const finalStatus = failed ? 'failed' : 'delivered';
  updateStatus(msg.id, finalStatus);

  if (msg.statusCallbackUrl) {
    try {
      await axios.post(containerOutboundUrl(msg.statusCallbackUrl), qs.stringify({
        MessageSid: msg.sid,
        MessageStatus: finalStatus,
        To: msg.to,
        From: msg.from,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 });
    } catch (e) {
      console.warn('[smshog] status callback failed:', e.message);
    }
  }
}

// ── Webhook forwarding ────────────────────────────────────────────────────────

async function deliverToWebhook(hook, payload) {
  const at = new Date().toISOString();
  try {
    const res = await axios.post(containerOutboundUrl(hook.url), payload, { timeout: 8000 });
    db.updateWebhookResult(hook.id, { lastStatus: 'ok', lastCode: res.status, lastError: null, lastAt: at });
    return { ok: true, code: res.status };
  } catch (e) {
    const code = e.response?.status || null;
    const err = e.response ? `HTTP ${e.response.status}` : e.message;
    db.updateWebhookResult(hook.id, { lastStatus: 'error', lastCode: code, lastError: err, lastAt: at });
    console.warn(`[smshog] webhook ${hook.id} failed:`, err);
    return { ok: false, code, error: err };
  }
}

function webhookPayload(msg) {
  return {
    id: msg.id, sid: msg.sid,
    to: msg.to, from: msg.from,
    body: msg.body, status: msg.status,
    createdAt: msg.createdAt,
  };
}

async function forwardToWebhooks(msg) {
  const payload = webhookPayload(msg);
  for (const hook of db.listWebhooks().filter(h => h.active)) {
    await deliverToWebhook(hook, payload);
  }
}

// ── Twilio-compatible API ─────────────────────────────────────────────────────

app.post('/2010-04-01/Accounts/:sid/Messages.json', (req, res) => {
  const { To, From, Body, MediaUrl, StatusCallback } = req.body;
  if (!To || !Body) return res.status(400).json({ code: 21211, message: 'To and Body are required' });

  const msg = createMessage({ to: To, from: From, body: Body, mediaUrl: MediaUrl, source: 'twilio-api', statusCallbackUrl: StatusCallback });

  res.status(201).json({
    sid: msg.sid, to: msg.to, from: msg.from,
    body: msg.body, status: msg.status,
    date_created: msg.createdAt,
    uri: `/2010-04-01/Accounts/${req.params.sid}/Messages/${msg.sid}.json`,
  });
});

app.get('/2010-04-01/Accounts/:sid/Messages.json', (req, res) => {
  const messages = db.listMessages();
  res.json({ messages: messages.map(twilioShape), end: messages.length - 1 });
});

app.get('/2010-04-01/Accounts/:sid/Messages/:msgSid.json', (req, res) => {
  const msg = db.getMessageBySid(req.params.msgSid);
  if (!msg) return res.status(404).json({ code: 20404, message: 'The requested resource was not found' });
  res.json(twilioShape(msg));
});

function twilioShape(msg) {
  return {
    sid: msg.sid, to: msg.to, from: msg.from,
    body: msg.body, status: msg.status,
    date_created: msg.createdAt, date_updated: msg.updatedAt,
    uri: `/2010-04-01/Accounts/ACsmshog/Messages/${msg.sid}.json`,
  };
}

// ── Custom simple API ─────────────────────────────────────────────────────────

app.post('/api/sms', (req, res) => {
  const { to, from, body, mediaUrl, statusCallbackUrl } = req.body;
  if (!to || !body) return res.status(400).json({ error: '`to` and `body` are required' });
  const msg = createMessage({ to, from, body, mediaUrl, source: 'custom-api', statusCallbackUrl });
  res.status(201).json(msg);
});

// ── Management API (used by UI) ───────────────────────────────────────────────

app.get('/api/messages', (req, res) => {
  res.json(db.listMessages(req.query.q));
});

app.delete('/api/messages', (req, res) => {
  db.clearMessages();
  res.json({ ok: true });
});

app.delete('/api/messages/:id', (req, res) => {
  if (!db.getMessage(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.deleteMessage(req.params.id);
  res.json({ ok: true });
});

app.post('/api/messages/:id/status', (req, res) => {
  const { status } = req.body;
  const valid = ['queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const msg = updateStatus(req.params.id, status);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  res.json(msg);
});

app.post('/api/messages/:id/reply', async (req, res) => {
  const { body, replyCallbackUrl } = req.body;
  const orig = db.getMessage(req.params.id);
  if (!orig) return res.status(404).json({ error: 'Not found' });
  if (!body || !body.trim()) return res.status(400).json({ error: '`body` is required' });

  const reply = createMessage({
    to: orig.from, from: orig.to, body,
    source: 'simulated-reply', initialStatus: 'delivered',
  });

  if (replyCallbackUrl) {
    try {
      await axios.post(containerOutboundUrl(replyCallbackUrl), qs.stringify({
        MessageSid: reply.sid, From: reply.from, To: reply.to, Body: reply.body,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 });
    } catch (e) {
      console.warn('[smshog] reply callback failed:', e.message);
    }
  }
  res.status(201).json(reply);
});

// ── Webhook management ────────────────────────────────────────────────────────

app.get('/api/webhooks', (req, res) => res.json(db.listWebhooks()));

app.post('/api/webhooks', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '`url` is required' });
  const hook = { id: uuid(), url, active: true, createdAt: new Date().toISOString() };
  db.insertWebhook(hook);
  res.status(201).json(hook);
});

app.delete('/api/webhooks/:id', (req, res) => {
  if (!db.getWebhook(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.deleteWebhook(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/webhooks/:id', (req, res) => {
  const hook = db.getWebhook(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  const updated = {
    ...hook,
    active: typeof req.body.active === 'boolean' ? req.body.active : hook.active,
    url: req.body.url || hook.url,
  };
  db.updateWebhook(updated);
  res.json(updated);
});

app.post('/api/webhooks/:id/test', async (req, res) => {
  const hook = db.getWebhook(req.params.id);
  if (!hook) return res.status(404).json({ error: 'Not found' });
  const result = await deliverToWebhook(hook, {
    test: true,
    sid: 'SMtest' + Date.now(),
    to: '+15551234567',
    from: '+15559999',
    body: 'SMSHog webhook test payload',
    status: 'delivered',
    createdAt: new Date().toISOString(),
  });
  res.json({ ...result, hook: db.getWebhook(req.params.id) });
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => res.json(settings));

app.patch('/api/settings', (req, res) => {
  settings = db.patchSettings(req.body);
  res.json(settings);
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => res.json({ ok: true, version: '1.0.0' }));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 9090);
const SOCKET = '/run/guest-services/smshog.sock';

// TCP server — used by external apps sending SMS to the capture API
const tcpServer = http.createServer(app);
tcpServer.listen(PORT, '0.0.0.0', () => console.log(`[smshog] listening on :${PORT}`));

// Unix socket server — used by Docker Desktop extension UI via ddClient proxy
const socketServer = http.createServer(app);
try {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  try { fs.unlinkSync(SOCKET); } catch (_) {}
  socketServer.listen(SOCKET, () => {
    try { fs.chmodSync(SOCKET, '777'); } catch (_) {}
    console.log(`[smshog] listening on ${SOCKET}`);
  });
  socketServer.on('error', err => console.warn('[smshog] socket error:', err.message));
} catch (e) {
  console.warn('[smshog] socket setup failed:', e.message);
}

process.on('SIGTERM', () => {
  db.db.close();
  try { fs.unlinkSync(SOCKET); } catch (_) {}
  process.exit(0);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
