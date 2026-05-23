#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-4 (closes P-8 from FM-SECURITY-AUDIT).
 *
 * `api-client.mjs::_logError` truncates error log entries to 200 chars
 * before storing them in `this._errorLog`. The truncation buffer is
 * surfaced via the dashboard's Status tab. If Chronicle's error
 * response body echoes the request — including `Authorization: Bearer
 * <apiKey>` or a signed `?token=...` URL — that secret lands in the
 * log unscrubbed.
 *
 * The fix: `_scrubAuthHeaders(text)` regex-replaces `Bearer <token>`
 * and `?token=<value>` with `[redacted]` before truncation/storage.
 *
 * This test exercises `_scrubAuthHeaders` directly (pure function,
 * exported). The _logError integration is implicit — the function is
 * called from _logError's first statement (verified by static-source
 * inspection below).
 *
 * Run: `node --test tools/test-api-client-secrets.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Stub Foundry globals before importing api-client.mjs (per F-PR2-3 — the
// module reads getSetting at module top level via the settings.mjs import
// chain). The scrub helper itself doesn't touch Foundry; the stubs only
// satisfy the transitive imports.
globalThis.foundry = globalThis.foundry || { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (cls) => cls } } };
globalThis.game = globalThis.game || { settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };

const { _scrubAuthHeaders } = await import('../scripts/api-client.mjs');

// ---------------------------------------------------------------------
// Behavioral tests for _scrubAuthHeaders
// ---------------------------------------------------------------------

test('_scrubAuthHeaders is exported from api-client.mjs', () => {
  assert.equal(typeof _scrubAuthHeaders, 'function', '_scrubAuthHeaders must be an exported function');
});

test('_scrubAuthHeaders redacts Bearer tokens', () => {
  const input = 'Invalid auth header: Bearer abc123XYZ_token-value.4567';
  const out = _scrubAuthHeaders(input);
  assert.ok(!out.includes('abc123XYZ'), 'Bearer token value must be scrubbed');
  assert.ok(out.includes('Bearer [redacted]'), 'Bearer prefix preserved with [redacted] marker');
});

test('_scrubAuthHeaders redacts ?token= query params', () => {
  const input = 'GET /api/v1/campaigns/abc/foundry-vtt/module.json?token=eyJSigned.payload.sig HTTP/1.1 -> 403';
  const out = _scrubAuthHeaders(input);
  assert.ok(!out.includes('eyJSigned'), '?token= value must be scrubbed');
  assert.ok(out.includes('?token=[redacted]'), '?token= preserved with [redacted] marker');
});

test('_scrubAuthHeaders redacts &token= query params (mid-query)', () => {
  const input = '/ws?client=foundry-module&token=secretValue123&other=keep';
  const out = _scrubAuthHeaders(input);
  assert.ok(!out.includes('secretValue123'), 'mid-query &token= must be scrubbed');
  assert.ok(out.includes('&token=[redacted]'), '&token= preserved with [redacted] marker');
  assert.ok(out.includes('client=foundry-module'), 'unrelated query params preserved');
  assert.ok(out.includes('other=keep'), 'unrelated query params preserved');
});

test('_scrubAuthHeaders handles multiple secrets in one message', () => {
  const input = 'Header: Bearer abc123; URL: /ws?token=xyz789';
  const out = _scrubAuthHeaders(input);
  assert.ok(!out.includes('abc123'));
  assert.ok(!out.includes('xyz789'));
  assert.ok(out.includes('Bearer [redacted]'));
  assert.ok(out.includes('?token=[redacted]'));
});

test('_scrubAuthHeaders passes through normal text unchanged', () => {
  const input = 'Chronicle API error 404: Campaign not found';
  assert.equal(_scrubAuthHeaders(input), input);
});

test('_scrubAuthHeaders handles non-string input gracefully', () => {
  assert.equal(_scrubAuthHeaders(null), null);
  assert.equal(_scrubAuthHeaders(undefined), undefined);
  assert.equal(_scrubAuthHeaders(42), 42);
  assert.deepEqual(_scrubAuthHeaders({}), {});
});

test('_scrubAuthHeaders is case-insensitive on the Bearer keyword', () => {
  const inputs = ['bearer abc123', 'BEARER abc123', 'Bearer abc123', 'BeArEr abc123'];
  for (const input of inputs) {
    const out = _scrubAuthHeaders(input);
    assert.ok(!out.includes('abc123'), `case variant should still scrub: ${input}`);
  }
});

// ---------------------------------------------------------------------
// Static-source integration check
// ---------------------------------------------------------------------

test('_logError calls _scrubAuthHeaders on the message before storing', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  // Find the _logError function body.
  const match = source.match(/_logError\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  assert.ok(match, '_logError function body could not be located');
  const body = match[1];
  assert.ok(
    /_scrubAuthHeaders\s*\(/.test(body),
    '_logError must call _scrubAuthHeaders on the message — otherwise P-8 regression. '
    + 'See FM-SEC-CHUNK-4 + reports/foundry/2026-05-22-fm-security-audit.md §2 P-8.',
  );
});
