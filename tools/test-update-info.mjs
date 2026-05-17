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
// `parseChronicleErrorBody`) don't call them.
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

const { categorize, parseChronicleErrorBody } = await import('../scripts/update-info.mjs');

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
