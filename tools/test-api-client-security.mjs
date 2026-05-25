#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-6 (G-S1 / G-S2 / G-S3 from the
 * Foundry-side security audit, §3 + §4 Chunk 6).
 *
 * `api-client.mjs` is the SINGLE auth-construction point for every
 * Chronicle call this module makes. The chronicle#323 incident was
 * a wire-contract drift caught at this seam — the consumer-side pin
 * for that lesson is here:
 *
 *   - REST methods build their URL as
 *     `${apiUrl}/api/v1/campaigns/${campaignId}${path}` (never bare
 *     `/api/`, never `/syncapi/`).
 *   - Every REST method sends `Authorization: Bearer ${apiKey}` from
 *     `getSetting('apiKey')`.
 *   - WebSocket connect uses `?token=${apiKey}` query — NOT the Bearer
 *     header (browsers don't allow setting headers on the upgrade
 *     anyway, but pinning the absence of Bearer in the WS URL guards
 *     against any future refactor that tries to "be clever").
 *   - WebSocket message dispatch silently ignores any `type` that
 *     doesn't match an entry in `ALLOWED_WS_TYPE_PREFIXES`.
 *
 * A failure here means the auth contract drifted. Per the audit §3:
 *   - G-S1: every REST method routes through the same authenticated
 *     fetch.
 *   - G-S2: the auth model is Bearer-for-REST + token-for-WS, never
 *     cross-used.
 *   - G-S3: the WS message dispatch is allowlisted, not denylisted.
 *
 * Run: `node --test tools/test-api-client-security.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------
// Fixture values — chosen so failure messages are obvious. The
// campaignId MUST be a valid UUID because api-client.mjs calls
// `_validateCampaignIdOrThrow` on it (FM-SEC-CHUNK-5 / P-7).
// ---------------------------------------------------------------------

const FIXTURE = {
  apiUrl: 'https://chronicle.example.test',
  apiKey: 'fixture-api-key-DO-NOT-LEAK',
  campaignId: '11111111-2222-3333-4444-555555555555',
};

const SETTINGS_VALUES = {
  apiUrl: FIXTURE.apiUrl,
  apiKey: FIXTURE.apiKey,
  campaignId: FIXTURE.campaignId,
};

// ---------------------------------------------------------------------
// Stub Foundry globals BEFORE importing api-client.mjs. The module
// reads getSetting() through settings.mjs at call time (not import
// time), so we install the stubs first and let the import chain run
// without throwing.
// ---------------------------------------------------------------------

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (cls) => cls } },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.game = {
  settings: {
    get: (_module, key) => SETTINGS_VALUES[key] ?? '',
    set: () => {},
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
};

// ---------------------------------------------------------------------
// Fetch stub — records every call so the test can assert URL + headers.
// Returns a minimal Response-like object. Reset between tests.
// ---------------------------------------------------------------------

let fetchCalls = [];
const originalFetch = globalThis.fetch;
function installFetchStub() {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    };
  };
}
function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
}

// ---------------------------------------------------------------------
// WebSocket stub — captures the constructor URL, exposes a handle so
// the test can fire onmessage manually.
// ---------------------------------------------------------------------

let wsInstances = [];
function installWebSocketStub() {
  wsInstances = [];
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      wsInstances.push(this);
    }
    send() { /* no-op */ }
    close() { /* no-op */ }
  };
}
function uninstallWebSocketStub() {
  delete globalThis.WebSocket;
}

// ---------------------------------------------------------------------
// Import after stubs are in place
// ---------------------------------------------------------------------

const { ChronicleAPI } = await import('../scripts/api-client.mjs');

function makeApi() {
  return new ChronicleAPI();
}

function expectedUrlPrefix() {
  return `${FIXTURE.apiUrl}/api/v1/campaigns/${FIXTURE.campaignId}`;
}

function assertBearerHeader(call, methodLabel) {
  const auth = call.options?.headers?.Authorization
    ?? call.options?.headers?.authorization;
  assert.equal(
    auth, `Bearer ${FIXTURE.apiKey}`,
    `${methodLabel}: Authorization header must be exactly "Bearer ${FIXTURE.apiKey}" (got ${JSON.stringify(auth)})`,
  );
}

function assertUrlShape(call, path, methodLabel) {
  assert.equal(
    call.url, `${expectedUrlPrefix()}${path}`,
    `${methodLabel}: URL must be /api/v1/campaigns/<campaignId>${path}`,
  );
  assert.ok(
    !call.url.includes('/syncapi/'),
    `${methodLabel}: URL must NOT route to /syncapi/ — that's the chronicle#323 drift shape`,
  );
}

function assertNoTokenInRestUrl(call, methodLabel) {
  // REST should put the token in the Bearer header, never as a query param.
  assert.ok(
    !/[?&]token=/i.test(call.url),
    `${methodLabel}: REST URL must NOT carry ?token=… — Bearer header is the only auth carrier for REST`,
  );
}

// =====================================================================
// G-S1 / G-S2: REST method auth invariants
// =====================================================================

test('get(): builds /api/v1/campaigns/{id}/<path> + Bearer header', async () => {
  installFetchStub();
  try {
    await makeApi().get('/entities');
    assert.equal(fetchCalls.length, 1, 'should call fetch exactly once');
    assertUrlShape(fetchCalls[0], '/entities', 'get()');
    assertBearerHeader(fetchCalls[0], 'get()');
    assertNoTokenInRestUrl(fetchCalls[0], 'get()');
    assert.equal(fetchCalls[0].options.method, 'GET');
  } finally { restoreFetch(); }
});

test('post(): builds /api/v1/campaigns/{id}/<path> + Bearer header', async () => {
  installFetchStub();
  try {
    await makeApi().post('/entities', { name: 'x' });
    assertUrlShape(fetchCalls[0], '/entities', 'post()');
    assertBearerHeader(fetchCalls[0], 'post()');
    assertNoTokenInRestUrl(fetchCalls[0], 'post()');
    assert.equal(fetchCalls[0].options.method, 'POST');
  } finally { restoreFetch(); }
});

test('put(): builds /api/v1/campaigns/{id}/<path> + Bearer header', async () => {
  installFetchStub();
  try {
    await makeApi().put('/entities/123', { name: 'x' });
    assertUrlShape(fetchCalls[0], '/entities/123', 'put()');
    assertBearerHeader(fetchCalls[0], 'put()');
    assertNoTokenInRestUrl(fetchCalls[0], 'put()');
    assert.equal(fetchCalls[0].options.method, 'PUT');
  } finally { restoreFetch(); }
});

test('patch(): builds /api/v1/campaigns/{id}/<path> + Bearer header', async () => {
  installFetchStub();
  try {
    await makeApi().patch('/entities/123', { name: 'x' });
    assertUrlShape(fetchCalls[0], '/entities/123', 'patch()');
    assertBearerHeader(fetchCalls[0], 'patch()');
    assertNoTokenInRestUrl(fetchCalls[0], 'patch()');
    assert.equal(fetchCalls[0].options.method, 'PATCH');
  } finally { restoreFetch(); }
});

test('delete(): builds /api/v1/campaigns/{id}/<path> + Bearer header', async () => {
  installFetchStub();
  try {
    await makeApi().delete('/entities/123');
    assertUrlShape(fetchCalls[0], '/entities/123', 'delete()');
    assertBearerHeader(fetchCalls[0], 'delete()');
    assertNoTokenInRestUrl(fetchCalls[0], 'delete()');
    assert.equal(fetchCalls[0].options.method, 'DELETE');
  } finally { restoreFetch(); }
});

test('getNotes(): routes through get() — same URL + header shape', async () => {
  installFetchStub();
  try {
    await makeApi().getNotes('/notes');
    assertUrlShape(fetchCalls[0], '/notes', 'getNotes()');
    assertBearerHeader(fetchCalls[0], 'getNotes()');
    assertNoTokenInRestUrl(fetchCalls[0], 'getNotes()');
  } finally { restoreFetch(); }
});

test('postNote(): routes through post() — same URL + header shape', async () => {
  installFetchStub();
  try {
    await makeApi().postNote('/notes', { title: 'x' });
    assertUrlShape(fetchCalls[0], '/notes', 'postNote()');
    assertBearerHeader(fetchCalls[0], 'postNote()');
    assertNoTokenInRestUrl(fetchCalls[0], 'postNote()');
  } finally { restoreFetch(); }
});

test('putNote(): routes through put() — same URL + header shape', async () => {
  installFetchStub();
  try {
    await makeApi().putNote('/notes/abc', { title: 'x' });
    assertUrlShape(fetchCalls[0], '/notes/abc', 'putNote()');
    assertBearerHeader(fetchCalls[0], 'putNote()');
    assertNoTokenInRestUrl(fetchCalls[0], 'putNote()');
  } finally { restoreFetch(); }
});

test('deleteNote(): routes through delete() — same URL + header shape', async () => {
  installFetchStub();
  try {
    await makeApi().deleteNote('/notes/abc');
    assertUrlShape(fetchCalls[0], '/notes/abc', 'deleteNote()');
    assertBearerHeader(fetchCalls[0], 'deleteNote()');
    assertNoTokenInRestUrl(fetchCalls[0], 'deleteNote()');
  } finally { restoreFetch(); }
});

test('uploadMedia(): builds /api/v1/campaigns/{id}/media + Bearer header', async () => {
  installFetchStub();
  try {
    // Minimal Blob-like fixture so api-client.uploadMedia can append it.
    const fakeBlob = new Blob(['stub content'], { type: 'application/octet-stream' });
    await makeApi().uploadMedia(fakeBlob, 'fixture.bin');
    assert.equal(fetchCalls.length, 1, 'should call fetch exactly once');
    assert.equal(
      fetchCalls[0].url,
      `${expectedUrlPrefix()}/media`,
      'uploadMedia must target /api/v1/campaigns/{id}/media',
    );
    assertBearerHeader(fetchCalls[0], 'uploadMedia()');
    assertNoTokenInRestUrl(fetchCalls[0], 'uploadMedia()');
    assert.equal(fetchCalls[0].options.method, 'POST');
  } finally { restoreFetch(); }
});

// =====================================================================
// G-S2: WebSocket auth — token in URL, NOT Bearer
// =====================================================================

test('WS connect: URL contains ?token=<apiKey>', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    assert.equal(wsInstances.length, 1, 'connect() must instantiate exactly one WebSocket');
    const url = wsInstances[0].url;
    assert.ok(
      url.includes(`token=${encodeURIComponent(FIXTURE.apiKey)}`),
      `WS URL must carry token=<apiKey> as query param (got: ${url})`,
    );
  } finally { uninstallWebSocketStub(); }
});

test('WS connect: URL upgrades http→ws (or https→wss)', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    const url = wsInstances[0].url;
    assert.ok(
      url.startsWith('wss://') || url.startsWith('ws://'),
      `WS URL must use ws:// or wss:// scheme (got: ${url})`,
    );
    // Specifically for the https fixture, must be wss.
    assert.ok(url.startsWith('wss://'), `https fixture must upgrade to wss:// (got: ${url})`);
  } finally { uninstallWebSocketStub(); }
});

test('WS connect: URL does NOT contain "Bearer" in any form', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    const url = wsInstances[0].url;
    assert.ok(
      !/bearer/i.test(url),
      `WS URL must NOT carry "Bearer" in any casing — Bearer is REST-only (got: ${url})`,
    );
  } finally { uninstallWebSocketStub(); }
});

test('WS connect: URL hits /ws path, not a /api/ subpath', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    const url = wsInstances[0].url;
    assert.ok(/\/ws\?/.test(url), `WS URL must use /ws path (got: ${url})`);
    assert.ok(
      !url.includes('/api/'),
      'WS URL must NOT route under /api/ — that is the REST surface',
    );
  } finally { uninstallWebSocketStub(); }
});

// =====================================================================
// G-S3: WebSocket message dispatch — allowlist enforcement
// =====================================================================

function dispatch(api, payload) {
  // Drive onmessage on the underlying fake socket.
  const ws = wsInstances[wsInstances.length - 1];
  ws.onmessage({ data: JSON.stringify(payload) });
}

test('WS dispatch: allowed type prefix → listener fires', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    let received = null;
    api.on('entity.updated', (msg) => { received = msg; });
    dispatch(api, { type: 'entity.updated', payload: { id: 'x' } });
    assert.ok(received, 'listener for entity.updated should fire');
    assert.equal(received.type, 'entity.updated');
    assert.equal(received.payload?.id, 'x');
  } finally { uninstallWebSocketStub(); }
});

test('WS dispatch: every prefix in ALLOWED_WS_TYPE_PREFIXES is accepted', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    const allowedPrefixes = [
      'entity.', 'entity_type.', 'map.', 'marker.', 'drawing.',
      'token.', 'layer.', 'fog.', 'note.', 'calendar.', 'relation.', 'sync.',
    ];
    for (const prefix of allowedPrefixes) {
      let fired = false;
      const type = `${prefix}created`;
      const cb = () => { fired = true; };
      api.on(type, cb);
      dispatch(api, { type, payload: {} });
      assert.ok(fired, `prefix "${prefix}" must be accepted (type=${type})`);
    }
  } finally { uninstallWebSocketStub(); }
});

test('WS dispatch: unknown type prefix → listener does NOT fire (silent drop)', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    let fired = false;
    // Register a wildcard listener so we catch *any* delivered message.
    api.on('*', () => { fired = true; });
    api.on('attacker.execute', () => { fired = true; });
    dispatch(api, { type: 'attacker.execute', payload: { code: 'rm -rf /' } });
    assert.equal(fired, false, 'attacker-supplied type must be silently dropped');
  } finally { uninstallWebSocketStub(); }
});

test('WS dispatch: missing type → silently ignored, no listener fires', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    let fired = false;
    api.on('*', () => { fired = true; });
    dispatch(api, { payload: 'no type field' });
    assert.equal(fired, false, 'message without type must be ignored');
  } finally { uninstallWebSocketStub(); }
});

test('WS dispatch: type that partially matches (substring, not prefix) → rejected', () => {
  installWebSocketStub();
  try {
    const api = makeApi();
    api.connect();
    let fired = false;
    // "evil.entity.created" contains "entity." but does NOT start with it.
    api.on('evil.entity.created', () => { fired = true; });
    dispatch(api, { type: 'evil.entity.created', payload: {} });
    assert.equal(fired, false, 'allowlist must be prefix-match, not substring-match');
  } finally { uninstallWebSocketStub(); }
});

// =====================================================================
// Static-source pins — invariants that are easier to assert by source
// =====================================================================

test('api-client.mjs: ALLOWED_WS_TYPE_PREFIXES is frozen', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  assert.ok(
    /ALLOWED_WS_TYPE_PREFIXES\s*=\s*Object\.freeze\s*\(/.test(source),
    'ALLOWED_WS_TYPE_PREFIXES must be Object.freeze()d so a runtime push can\'t append a new prefix',
  );
});

test('api-client.mjs: _doConnect carries token in URL query, not in headers', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  const match = source.match(/_doConnect\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  assert.ok(match, '_doConnect function body could not be located');
  const body = match[1];
  assert.ok(/token=\$\{[^}]*apiKey/.test(body), '_doConnect must include `token=${apiKey}` in the WS URL');
  assert.ok(
    !/Authorization/.test(body),
    '_doConnect must NOT set an Authorization header — browsers reject it on WS upgrade and Bearer-in-URL would be worse',
  );
});

test('api-client.mjs: REST fetch builds /api/v1/campaigns/{id} URL, never /syncapi/', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  assert.ok(
    /\/api\/v1\/campaigns\/\$\{campaignId\}/.test(source),
    'REST URL template must be /api/v1/campaigns/${campaignId}…',
  );
  assert.ok(
    !/\/syncapi\//.test(source),
    'no `/syncapi/` substring anywhere in api-client.mjs — that was the chronicle#323 drift shape',
  );
});
