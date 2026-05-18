#!/usr/bin/env node
/**
 * Unit tests for the pure helpers in `scripts/update-info.mjs`.
 *
 * Covers the parsing + classification logic that does NOT touch Foundry
 * globals (game.modules, game.i18n, fetch). The full `#onCheck` flow is
 * integration-tested manually in the dialog itself — see PR FM-CSU-DIAG-FIX's
 * verification table for the manual-trip matrix.
 *
 * Run: `node --test tools/test-update-info.mjs`
 *
 * No mocking framework — uses Node's built-in `node:test` (Node ≥ 18).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub Foundry globals that update-info.mjs touches at import time. The
// stubs only need to exist; the tested helpers (`categorize`,
// `parseChronicleErrorBody`) don't call them. Tests that exercise
// `probeManifest` or `surfaceManifestRecoveryIfNeeded` overwrite
// `game.modules.get` and `globalThis.fetch` per-test.
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (base) => base,
    },
  },
};
globalThis.game = {
  modules: { get: () => null },
  i18n:    { localize: (k) => k, format: (k) => k },
};

const {
  categorize,
  parseChronicleErrorBody,
  readInstallManifestUrl,
  probeManifest,
  surfaceManifestRecoveryIfNeeded,
} = await import('../scripts/update-info.mjs');

/**
 * Install a mocked `game.modules.get` that returns a module with the
 * given manifest URL, and a mocked `globalThis.fetch` that returns
 * `responseFactory()` on first call. Returns a teardown that restores
 * both globals.
 */
function mockFoundryAndFetch({ manifestUrl, responseFactory }) {
  const prevModulesGet = game.modules.get;
  const prevFetch      = globalThis.fetch;
  game.modules.get = () => (manifestUrl == null ? null : { manifest: manifestUrl });
  globalThis.fetch = async () => responseFactory();
  return () => {
    game.modules.get = prevModulesGet;
    globalThis.fetch = prevFetch;
  };
}

/** Build a mock Response-like object with the given status + JSON body. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

/** Build a mock Response with a non-JSON body (json() throws). */
function nonJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new SyntaxError('not JSON'); },
  };
}

// ---------------------------------------------------------------------
// parseChronicleErrorBody
// ---------------------------------------------------------------------

test('parseChronicleErrorBody — full Chronicle body', () => {
  const body = {
    error: 'invalid_token',
    message: 'The install-time token was rotated by the campaign owner.',
    category: 'auth',
  };
  assert.deepEqual(parseChronicleErrorBody(body), {
    code: 'invalid_token',
    message: 'The install-time token was rotated by the campaign owner.',
    category: 'auth',
  });
});

test('parseChronicleErrorBody — missing fields default to empty strings', () => {
  assert.deepEqual(parseChronicleErrorBody({}), { code: '', message: '', category: '' });
  assert.deepEqual(parseChronicleErrorBody({ error: 'x' }), { code: 'x', message: '', category: '' });
});

test('parseChronicleErrorBody — non-object inputs return empty defaults', () => {
  assert.deepEqual(parseChronicleErrorBody(null),      { code: '', message: '', category: '' });
  assert.deepEqual(parseChronicleErrorBody(undefined), { code: '', message: '', category: '' });
  assert.deepEqual(parseChronicleErrorBody('string'),  { code: '', message: '', category: '' });
  assert.deepEqual(parseChronicleErrorBody(42),        { code: '', message: '', category: '' });
});

test('parseChronicleErrorBody — non-string field values ignored', () => {
  // Defends against Chronicle accidentally shipping a numeric code or
  // nested-object message.
  assert.deepEqual(
    parseChronicleErrorBody({ error: 123, message: { x: 1 }, category: ['auth'] }),
    { code: '', message: '', category: '' },
  );
});

// ---------------------------------------------------------------------
// categorize
// ---------------------------------------------------------------------

test('categorize — Chronicle category wins over HTTP status', () => {
  // 503 would normally map to `internal`, but Chronicle classified as
  // `config` (which is more accurate — admin needs to install a package).
  assert.equal(categorize({ httpStatus: 503, chronicleCategory: 'config' }), 'config');
  // 401 would normally map to `auth`, Chronicle confirms.
  assert.equal(categorize({ httpStatus: 401, chronicleCategory: 'auth' }), 'auth');
});

test('categorize — all five Chronicle categories pass through', () => {
  for (const cat of ['auth', 'config', 'not_found', 'validation', 'internal']) {
    assert.equal(
      categorize({ httpStatus: 500, chronicleCategory: cat }),
      cat,
      `expected ${cat} to pass through`,
    );
  }
});

test('categorize — unknown Chronicle category falls back to HTTP status', () => {
  // Defends against Chronicle adding a new category (e.g. `rate_limit`)
  // that this Foundry build doesn't know about.
  assert.equal(categorize({ httpStatus: 401, chronicleCategory: 'rate_limit' }), 'auth');
  assert.equal(categorize({ httpStatus: 404, chronicleCategory: 'rate_limit' }), 'not_found');
  assert.equal(categorize({ httpStatus: 503, chronicleCategory: 'rate_limit' }), 'internal');
});

test('categorize — HTTP status fallback when chronicleCategory missing', () => {
  assert.equal(categorize({ httpStatus: 401, chronicleCategory: '' }),        'auth');
  assert.equal(categorize({ httpStatus: 403, chronicleCategory: undefined }), 'auth');
  assert.equal(categorize({ httpStatus: 404, chronicleCategory: '' }),        'not_found');
  assert.equal(categorize({ httpStatus: 500, chronicleCategory: '' }),        'internal');
  assert.equal(categorize({ httpStatus: 503, chronicleCategory: '' }),        'internal');
  assert.equal(categorize({ httpStatus: 599, chronicleCategory: '' }),        'internal');
});

test('categorize — unmapped status defaults to internal (safe-but-coarse)', () => {
  // We don't want to render an unstyled result-{whatever} class, so
  // anything we can't categorize falls into `internal` (red, "talk to admin").
  assert.equal(categorize({ httpStatus: 418, chronicleCategory: '' }), 'internal');
  assert.equal(categorize({ httpStatus: 0,   chronicleCategory: '' }), 'internal');
});

// ---------------------------------------------------------------------
// readInstallManifestUrl
// ---------------------------------------------------------------------

test('readInstallManifestUrl — returns empty string when no module', () => {
  const prev = game.modules.get;
  game.modules.get = () => null;
  assert.equal(readInstallManifestUrl(), '');
  game.modules.get = prev;
});

test('readInstallManifestUrl — reads v13 manifest field', () => {
  const prev = game.modules.get;
  game.modules.get = () => ({ manifest: 'https://chronicle.example.com/m.json?token=abc' });
  assert.equal(readInstallManifestUrl(), 'https://chronicle.example.com/m.json?token=abc');
  game.modules.get = prev;
});

test('readInstallManifestUrl — falls back to v12 data.manifest', () => {
  const prev = game.modules.get;
  game.modules.get = () => ({ data: { manifest: 'https://chronicle.example.com/v12.json' } });
  assert.equal(readInstallManifestUrl(), 'https://chronicle.example.com/v12.json');
  game.modules.get = prev;
});

// ---------------------------------------------------------------------
// probeManifest
// ---------------------------------------------------------------------

test('probeManifest — no install URL recorded returns no_url state', async () => {
  const teardown = mockFoundryAndFetch({
    manifestUrl: '',
    responseFactory: () => { throw new Error('fetch should not be called'); },
  });
  try {
    assert.deepEqual(await probeManifest(), { ok: false, state: 'no_url' });
  } finally { teardown(); }
});

test('probeManifest — 200 OK returns ok state with httpStatus + url', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => jsonResponse(200, { version: '0.1.11' }),
  });
  try {
    assert.deepEqual(await probeManifest(), { ok: true, state: 'ok', httpStatus: 200, url });
  } finally { teardown(); }
});

test('probeManifest — 403 with Chronicle auth body returns auth state + message', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=stale';
  const body = {
    error:    'invalid_token',
    category: 'auth',
    message:  'Your install URL is stale. Reinstall from a fresh URL.',
  };
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => jsonResponse(403, body),
  });
  try {
    const result = await probeManifest();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'auth');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.code, 'invalid_token');
    assert.equal(result.message, body.message);
    assert.deepEqual(result.body, body);
  } finally { teardown(); }
});

test('probeManifest — 403 without Chronicle body falls back to HTTP-status auth', async () => {
  // Proxy / CDN 403 — Chronicle never saw the request, so no JSON body.
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => nonJsonResponse(403),
  });
  try {
    const result = await probeManifest();
    assert.equal(result.state, 'auth');     // 403 → auth via HTTP fallback
    assert.equal(result.code, '');           // no Chronicle code
    assert.equal(result.message, '');
    assert.equal(result.body, null);
  } finally { teardown(); }
});

test('probeManifest — Chronicle config 503 routes to config (not auth)', async () => {
  // No-package-registered isn't an install-URL problem; the GM-side
  // recovery isn't "reinstall the module". This test pins that probeManifest
  // hands the right `state` to the caller, which decides not to fire the
  // auth notification.
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const body = { error: 'no_package_registered', category: 'config', message: 'Admin needs to install a release.' };
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => jsonResponse(503, body),
  });
  try {
    const result = await probeManifest();
    assert.equal(result.state, 'config');
    assert.equal(result.code, 'no_package_registered');
  } finally { teardown(); }
});

test('probeManifest — fetch throw returns network state', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const prevModulesGet = game.modules.get;
  const prevFetch      = globalThis.fetch;
  game.modules.get = () => ({ manifest: url });
  globalThis.fetch = async () => { throw new TypeError('NetworkError'); };
  try {
    const result = await probeManifest();
    assert.equal(result.ok, false);
    assert.equal(result.state, 'network');
    assert.equal(result.url, url);
    assert.ok(result.error.includes('NetworkError'));
  } finally {
    game.modules.get = prevModulesGet;
    globalThis.fetch = prevFetch;
  }
});

// ---------------------------------------------------------------------
// surfaceManifestRecoveryIfNeeded
// ---------------------------------------------------------------------

/**
 * Capture `ui.notifications.error` invocations. Returns an array that
 * tests can inspect.
 */
function captureNotifications() {
  const calls = [];
  globalThis.ui = {
    notifications: {
      error: (text, opts) => { calls.push({ text, opts }); },
      warn:  () => {},
      info:  () => {},
    },
  };
  return calls;
}

test('surfaceManifestRecoveryIfNeeded — no notification on 200 OK', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const calls = captureNotifications();
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => jsonResponse(200, { version: '0.1.11' }),
  });
  try {
    await surfaceManifestRecoveryIfNeeded();
    assert.equal(calls.length, 0);
  } finally { teardown(); }
});

test('surfaceManifestRecoveryIfNeeded — auth failure fires sticky banner with Chronicle message', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=stale';
  const body = {
    error:    'invalid_token',
    category: 'auth',
    message:  'Your install URL is stale.',
  };
  const calls = captureNotifications();
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => jsonResponse(403, body),
  });
  try {
    await surfaceManifestRecoveryIfNeeded();
    assert.equal(calls.length, 1);
    // Prefix and detail (Chronicle's message) both present.
    assert.ok(calls[0].text.includes('CHRONICLE.Recovery.AuthFailure.Prefix'));
    assert.ok(calls[0].text.includes('Your install URL is stale.'));
    // Sticky.
    assert.equal(calls[0].opts.permanent, true);
  } finally { teardown(); }
});

test('surfaceManifestRecoveryIfNeeded — auth failure without Chronicle message uses i18n fallback', async () => {
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  const calls = captureNotifications();
  // Proxy 403 with no Chronicle body — message field stays empty.
  const teardown = mockFoundryAndFetch({
    manifestUrl: url,
    responseFactory: () => nonJsonResponse(403),
  });
  try {
    await surfaceManifestRecoveryIfNeeded();
    assert.equal(calls.length, 1);
    // Falls back to the i18n key (test stub returns the key string).
    assert.ok(calls[0].text.includes('CHRONICLE.Recovery.AuthFailure.Message'));
  } finally { teardown(); }
});

test('surfaceManifestRecoveryIfNeeded — non-auth failure does NOT fire banner', async () => {
  // config + not_found + internal: all real failure modes that aren't
  // "install URL stale, reinstall to fix". Banner stays silent;
  // diagnostic dialog covers them.
  const url = 'https://chronicle.example.com/api/v1/campaigns/x/foundry-vtt/module.json?token=t';
  for (const [status, body] of [
    [503, { error: 'no_package_registered',  category: 'config',     message: 'admin' }],
    [404, { error: 'campaign_not_found',     category: 'not_found',  message: 'gone'  }],
    [500, { error: 'module_json_missing',    category: 'internal',   message: 'bug'   }],
    [422, { error: 'descriptor_invalid',     category: 'validation', message: 'bad'   }],
  ]) {
    const calls = captureNotifications();
    const teardown = mockFoundryAndFetch({
      manifestUrl: url,
      responseFactory: () => jsonResponse(status, body),
    });
    try {
      await surfaceManifestRecoveryIfNeeded();
      assert.equal(calls.length, 0, `expected no banner for category=${body.category}`);
    } finally { teardown(); }
  }
});

test('surfaceManifestRecoveryIfNeeded — no install URL is silent (banner would not be actionable)', async () => {
  const calls = captureNotifications();
  const teardown = mockFoundryAndFetch({
    manifestUrl: '',
    responseFactory: () => { throw new Error('fetch should not be called'); },
  });
  try {
    await surfaceManifestRecoveryIfNeeded();
    assert.equal(calls.length, 0);
  } finally { teardown(); }
});
