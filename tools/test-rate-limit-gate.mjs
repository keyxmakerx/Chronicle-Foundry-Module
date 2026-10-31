#!/usr/bin/env node
/**
 * Pins the shared 429 pause (scripts/_rate-limit-gate.mjs) and how
 * api-client.mjs uses it: a rate-limited request waits for Chronicle's
 * Retry-After and is sent again a bounded number of times, never in a
 * tight loop, and every other request waits on the same pause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETRY_AFTER_MS, MAX_RATE_LIMIT_RETRIES, MAX_RETRY_AFTER_MS, RateLimitGate, parseRetryAfter,
} from '../scripts/_rate-limit-gate.mjs';

test('Retry-After: seconds, an HTTP date, or a safe default; clamped', () => {
  const now = Date.parse('2026-10-25T04:40:00Z');
  assert.equal(parseRetryAfter('12', now), 12_000);
  assert.equal(parseRetryAfter('Sun, 25 Oct 2026 04:40:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter(null, now), DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter('soon', now), DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter('0', now), 1000);
  assert.equal(parseRetryAfter('3600', now), MAX_RETRY_AFTER_MS);
});

test('the gate keeps the longest pause and waits it out', async () => {
  const gate = new RateLimitGate();
  gate.block(5000, 1000);
  gate.block(2000, 1000);
  assert.equal(gate.remaining(1000), 5000);
  assert.equal(gate.remaining(7000), 0);
  const slept = [];
  let clock = 1000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    await gate.wait(async (ms) => { slept.push(ms); clock += ms; });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(slept, [5000]);
});

// --- api-client: stub Foundry and fetch, then import --------------------

const SETTINGS = {
  apiUrl: 'https://chronicle.example.test',
  apiKey: 'k',
  campaignId: '11111111-2222-3333-4444-555555555555',
};
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (cls) => cls } },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.game = {
  settings: { get: (_m, key) => SETTINGS[key] ?? '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
};
const { ChronicleAPI } = await import('../scripts/api-client.mjs');

function reply(status, { retryAfter, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'Retry-After' ? retryAfter ?? null : null) },
    text: async () => body,
  };
}

function apiWith(replies) {
  const api = new ChronicleAPI();
  const sent = [];
  const pauses = [];
  globalThis.fetch = async (url, opts) => { sent.push(opts.method); return replies.shift() ?? reply(200, { body: '{}' }); };
  // Record the pause instead of sleeping through it.
  api.rateLimit.wait = async () => { pauses.push(api.rateLimit.remaining()); api.rateLimit.until = 0; };
  return { api, sent, pauses };
}

test('a 429 waits for Retry-After and is sent again', async () => {
  const { api, sent, pauses } = apiWith([
    reply(429, { retryAfter: '7', body: '{"error":"rate_limit_exceeded"}' }),
    reply(200, { body: '{"ok":true}' }),
  ]);
  assert.deepEqual(await api.get('/entity-types'), { ok: true });
  assert.equal(sent.length, 2);
  assert.ok(pauses[1] > 6000 && pauses[1] <= 7000, `paused ${pauses[1]}ms`);
  assert.equal(api.health.restErrorCount, 0);
});

test('writes are retried too: Chronicle refuses them before running them', async () => {
  const { api, sent } = apiWith([reply(429, { retryAfter: '1' }), reply(200, { body: '{}' })]);
  await api.post('/sync/history', { a: 1 });
  assert.deepEqual(sent, ['POST', 'POST']);
});

test('retries are bounded, then the caller gets the 429', async () => {
  const many = Array.from({ length: 10 }, () => reply(429, { retryAfter: '1', body: '{"error":"rate_limit_exceeded"}' }));
  const { api, sent } = apiWith(many);
  await assert.rejects(api.get('/maps'), (err) => err.status === 429 && err.code === 'rate_limit_exceeded');
  assert.equal(sent.length, MAX_RATE_LIMIT_RETRIES + 1);
  assert.equal(api.health.restErrorCount, 1);
});

test('after a 429 every request waits on the same pause', async () => {
  const api = new ChronicleAPI();
  api.rateLimit.block(30_000);
  let sent = 0;
  globalThis.fetch = async () => { sent++; return reply(200, { body: '{}' }); };
  const waits = [];
  api.rateLimit.wait = async () => { waits.push(api.rateLimit.remaining()); };
  await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
  assert.equal(sent, 3);
  assert.ok(waits.every((ms) => ms > 29_000), 'each request saw the shared pause');
});

test('map pictures and uploads wait on the pause, and a 429 on one closes it', async () => {
  const api = new ChronicleAPI();
  api.rateLimit.block(30_000);
  const waits = [];
  api.rateLimit.wait = async () => { waits.push(api.rateLimit.remaining()); api.rateLimit.until = 0; };
  globalThis.fetch = async () => reply(429, { retryAfter: '9' });
  await assert.rejects(api.getBlob('/media/x'), (err) => err.status === 429);
  assert.ok(waits[0] > 29_000, 'the picture waited for the open pause');
  const left = api.rateLimit.remaining();
  assert.ok(left > 8000 && left <= 9000, `picture 429 paused the rest for ${left}ms`);
  api.rateLimit.until = 0;
  await assert.rejects(api.uploadMedia(new Blob(['x']), 'a.png'), /Media upload failed: 429/);
  assert.ok(api.rateLimit.remaining() > 8000, 'an upload 429 pauses the rest too');
});

// --- retry queue: a replay never sends a stale write ---------------------

test('a newer queued write to the same place replaces the older one', async () => {
  const api = new ChronicleAPI();
  api.queueForRetry('PUT', '/entities/a', { entry: 'old' });
  api.queueForRetry('PUT', '/entities/b', { entry: 'other' });
  api.queueForRetry('PUT', '/entities/a', { entry: 'new' });
  assert.deepEqual(api._retryQueue.map((q) => [q.path, JSON.parse(q.body).entry]), [['/entities/b', 'other'], ['/entities/a', 'new']]);
});

test('a write that went through drops the queued older one, so reconnect does not replay it', async () => {
  const api = new ChronicleAPI();
  api.queueForRetry('PUT', '/entities/a', { entry: 'old' });
  api.clearRetry('PUT', '/entities/a');
  const sent = [];
  globalThis.fetch = async (url, opts) => { sent.push(opts.body); return reply(200, { body: '{}' }); };
  api.rateLimit.wait = async () => {};
  assert.deepEqual(await api.processRetryQueue(), { success: 0, failed: 0 });
  assert.equal(sent.length, 0);
});

test('a queued write replays only into the campaign it was made in', async () => {
  const api = new ChronicleAPI();
  api.queueForRetry('PUT', '/entities/a', { entry: 'x' });
  const was = SETTINGS.campaignId;
  SETTINGS.campaignId = '22222222-2222-4222-8222-222222222222';
  const sent = [];
  globalThis.fetch = async (url) => { sent.push(url); return reply(200, { body: '{}' }); };
  api.rateLimit.wait = async () => {};
  try {
    assert.deepEqual(await api.processRetryQueue(), { success: 0, failed: 1 });
  } finally {
    SETTINGS.campaignId = was;
  }
  assert.deepEqual(sent, [], 'nothing sent to the new campaign');
  assert.equal(api.getRetryQueueSize(), 0);
});

test('a 409 on replay goes to the conflict handler once, and is never retried', async () => {
  const api = new ChronicleAPI();
  const seen = [];
  api.queueForRetry('PUT', '/entities/a', { entry: 'x', expected_updated_at: 'V1' }, 3, { onConflict: async (body) => { seen.push(body); } });
  api.queueForRetry('PUT', '/entities/b', { entry: 'y', expected_updated_at: 'V1' });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(409, { body: '{"message":"stale"}' }); };
  api.rateLimit.wait = async () => {};
  assert.deepEqual(await api.processRetryQueue(), { success: 1, failed: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(seen, [{ entry: 'x', expected_updated_at: 'V1' }]);
  assert.equal(api.getRetryQueueSize(), 0, 'a 409 without a handler is final, not retried');
});
