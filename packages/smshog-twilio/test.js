/**
 * Unit tests for smshog-twilio (Node built-in test runner, Node 18+)
 * Run: node --test test.js
 *
 * These tests mock the HTTP layer so no SMSHog instance is required.
 */

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── Stub fetch before requiring the module ────────────────────────────────────

const FAKE_RESPONSE = {
  sid: 'SMabc123',
  to: '+15555550100',
  from: '+15555550199',
  body: 'Hello',
  status: 'queued',
  date_created: new Date().toISOString(),
  uri: '/2010-04-01/Accounts/ACsmshog/Messages/SMabc123.json',
};

function makeFetch(overrides = {}) {
  return async (_url, _opts) => ({
    ok: overrides.ok ?? true,
    status: overrides.status ?? 201,
    statusText: overrides.statusText ?? 'Created',
    json: async () => overrides.body ?? FAKE_RESPONSE,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('patchTwilio: intercepts messages.create and returns shaped result', async () => {
  global.fetch = makeFetch();
  const { patchTwilio } = require('./index.js');

  const fakeClient = {
    accountSid: 'ACtest',
    messages: {
      create: async () => { throw new Error('should not reach real Twilio'); },
    },
  };

  patchTwilio(fakeClient, { verbose: false });
  const result = await fakeClient.messages.create({ to: '+15555550100', from: '+15555550199', body: 'Hello' });

  assert.equal(result.sid, FAKE_RESPONSE.sid);
  assert.equal(result.to, FAKE_RESPONSE.to);
  assert.equal(result.body, FAKE_RESPONSE.body);
  assert.ok(result.dateCreated instanceof Date, 'dateCreated should be a Date');
  assert.ok(typeof result.fetch === 'function', 'should expose .fetch()');
  assert.ok(typeof result.remove === 'function', 'should expose .remove()');
});

test('patchTwilio: is idempotent (patching twice does not double-wrap)', async () => {
  global.fetch = makeFetch();
  const { patchTwilio } = require('./index.js');

  const fakeClient = {
    accountSid: 'ACtest',
    messages: { create: async () => ({}) },
  };

  patchTwilio(fakeClient, { verbose: false });
  const ref1 = fakeClient.messages.create;
  patchTwilio(fakeClient, { verbose: false });
  const ref2 = fakeClient.messages.create;

  assert.equal(ref1, ref2, 'second patchTwilio call should be a no-op');
});

test('unpatchTwilio: restores original create method', async () => {
  global.fetch = makeFetch();
  const { patchTwilio, unpatchTwilio } = require('./index.js');

  // Track calls to verify the original is restored by behaviour, not reference.
  // (patchTwilio stores a .bind() copy internally, so reference equality won't hold.)
  let originalCalled = false;
  const fakeClient = {
    accountSid: 'ACtest',
    messages: { create: async () => { originalCalled = true; return { sid: 'original' }; } },
  };

  patchTwilio(fakeClient, { verbose: false });
  assert.ok(fakeClient.messages.create._smshogPatched, 'should be patched');

  unpatchTwilio(fakeClient);
  assert.ok(!fakeClient.messages.create._smshogPatched, 'patch flag should be gone');

  // Calling the restored function should hit our original, not SMSHog
  await fakeClient.messages.create({});
  assert.ok(originalCalled, 'original create should be called after unpatch');
});

test('createSmshogClient: sends to SMSHog and returns shaped result', async () => {
  global.fetch = makeFetch();
  const { createSmshogClient } = require('./index.js');

  const client = createSmshogClient({ verbose: false });
  const result = await client.messages.create({ to: '+15555550100', from: '+15555550199', body: 'Hello' });

  assert.equal(result.sid, FAKE_RESPONSE.sid);
  assert.ok(result.dateCreated instanceof Date);
});

test('createSmshogClient: throws on non-2xx response', async () => {
  global.fetch = makeFetch({ ok: false, status: 400, body: { message: 'Bad request', code: 21211 } });
  const { createSmshogClient } = require('./index.js');

  const client = createSmshogClient({ verbose: false });
  await assert.rejects(
    () => client.messages.create({ to: '+1...', body: 'Hi' }),
    (err) => {
      assert.ok(err.message.includes('400'));
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('patchTwilio: uses custom url option', async () => {
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push(url);
    return { ok: true, status: 201, statusText: 'Created', json: async () => FAKE_RESPONSE };
  };

  const { patchTwilio, unpatchTwilio } = require('./index.js');
  const fakeClient = { accountSid: 'ACtest', messages: { create: async () => {} } };
  patchTwilio(fakeClient, { url: 'http://smshog-custom:9999', verbose: false });
  await fakeClient.messages.create({ to: '+1...', body: 'Hi' });

  assert.ok(seen[0].startsWith('http://smshog-custom:9999'), `unexpected URL: ${seen[0]}`);
  unpatchTwilio(fakeClient);
});
