'use strict';

/**
 * smshog-twilio — CJS entry point
 *
 * Drop-in Twilio SDK interceptor for local development.
 * Routes all client.messages.create() calls to a running SMSHog instance
 * instead of the real Twilio API.
 */

const DEFAULT_URL = process.env.SMSHOG_URL || 'http://localhost:9090';

// ── Internal HTTP helper (no runtime deps) ────────────────────────────────────

async function post(url, formBody) {
  // Node 18+ has native fetch; fall back to http for older runtimes
  if (typeof fetch !== 'undefined') {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText, json: () => res.json() };
  }

  // http/https fallback (Node < 18)
  const { request } = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    };
    const req = request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          json: () => Promise.resolve(JSON.parse(raw)),
        });
      });
    });
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
}

function buildForm(params) {
  const f = new URLSearchParams();
  if (params.to)             f.set('To',             params.to);
  if (params.from)           f.set('From',           params.from);
  if (params.body)           f.set('Body',           params.body);
  if (params.mediaUrl)       f.set('MediaUrl',       params.mediaUrl);
  if (params.statusCallback) f.set('StatusCallback', params.statusCallback);
  return f.toString();
}

function shapeResponse(data) {
  return {
    sid:         data.sid,
    to:          data.to,
    from:        data.from,
    body:        data.body,
    status:      data.status,
    dateCreated: new Date(data.date_created),
    dateUpdated: new Date(data.date_created),
    uri:         data.uri,
    // Stub chainable methods twilio-node attaches so callers don't break
    fetch:  async () => shapeResponse(data),
    update: async () => shapeResponse(data),
    remove: async () => true,
  };
}

// ── patchTwilio ───────────────────────────────────────────────────────────────

/**
 * Patches an existing Twilio client so all `client.messages.create()` calls
 * are intercepted and sent to SMSHog instead of the real Twilio API.
 *
 * Safe to call multiple times — idempotent.
 * Call `unpatchTwilio(client)` to restore the original.
 *
 * @param {object}  client          - Result of `twilio(accountSid, authToken)`
 * @param {object}  [opts]
 * @param {string}  [opts.url]      - SMSHog base URL (default: $SMSHOG_URL or http://localhost:9090)
 * @param {boolean} [opts.verbose]  - Log intercepted messages to stdout (default: true)
 * @returns {object} The patched client (same reference)
 */
function patchTwilio(client, opts = {}) {
  if (client.messages.create && client.messages.create._smshogPatched) return client;

  const url     = opts.url     ?? DEFAULT_URL;
  const verbose = opts.verbose ?? true;
  const original = client.messages.create.bind(client.messages);

  client.messages.create = async function smshogInterceptor(params) {
    if (verbose) {
      process.stdout.write(
        `[smshog] intercepted → ${params.to}: ${String(params.body || '').slice(0, 60)}\n`
      );
    }
    const sid      = client.accountSid || 'ACsmshog';
    const endpoint = `${url}/2010-04-01/Accounts/${sid}/Messages.json`;
    const res      = await post(endpoint, buildForm(params));

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e   = new Error(`SMSHog error ${res.status}: ${err.message || res.statusText}`);
      e.status  = res.status;
      e.code    = err.code;
      throw e;
    }

    return shapeResponse(await res.json());
  };

  Object.defineProperties(client.messages.create, {
    _smshogPatched: { value: true, writable: false, enumerable: false },
    _restore:       { value: () => { client.messages.create = original; }, enumerable: false },
  });

  return client;
}

// ── unpatchTwilio ─────────────────────────────────────────────────────────────

/**
 * Restores the original Twilio `messages.create` method on a patched client.
 *
 * @param {object} client - A previously patched Twilio client
 */
function unpatchTwilio(client) {
  if (typeof client.messages.create._restore === 'function') {
    client.messages.create._restore();
  }
}

// ── createSmshogClient ────────────────────────────────────────────────────────

/**
 * Creates a lightweight fake Twilio client that sends all messages to SMSHog.
 * Useful in CI environments where real Twilio credentials aren't available.
 *
 * The returned object has the same surface area as a real Twilio client for
 * message creation: `client.messages.create(params)`.
 *
 * @param {object} [opts]
 * @param {string}  [opts.url]      - SMSHog base URL (default: $SMSHOG_URL or http://localhost:9090)
 * @param {string}  [opts.sid]      - Fake account SID to use in API path (default: 'ACsmshog')
 * @param {boolean} [opts.verbose]  - Log sent messages to stdout (default: true)
 * @returns {{ accountSid: string, messages: { create: Function } }}
 */
function createSmshogClient(opts = {}) {
  const url     = opts.url     ?? DEFAULT_URL;
  const sid     = opts.sid     ?? 'ACsmshog';
  const verbose = opts.verbose ?? true;

  return {
    accountSid: sid,
    messages: {
      create: async function (params) {
        if (verbose) {
          process.stdout.write(
            `[smshog] → ${params.to}: ${String(params.body || '').slice(0, 60)}\n`
          );
        }
        const endpoint = `${url}/2010-04-01/Accounts/${sid}/Messages.json`;
        const res      = await post(endpoint, buildForm(params));

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const e   = new Error(`SMSHog error ${res.status}: ${err.message || res.statusText}`);
          e.status  = res.status;
          throw e;
        }

        return shapeResponse(await res.json());
      },
    },
  };
}

module.exports = { patchTwilio, unpatchTwilio, createSmshogClient };
