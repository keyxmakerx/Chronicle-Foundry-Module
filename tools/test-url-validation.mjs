#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-2 (M-2 image-URL host allowlist).
 *
 * Two-layer test:
 *
 *   1. Behavioral tests for `_isAllowedImageHost` — the host-allowlist
 *      function called from map-sync.mjs (`_mapImageSrc`,
 *      `_resolveMediaUrl`) and map-viewer.mjs (`_mapImageSrc`,
 *      `_prepareToken`) to gate Chronicle-supplied image URLs before
 *      they hit `<img src>` or persist on a page flag.
 *
 *   2. Static-source integration: confirm map-sync.mjs + map-viewer.mjs
 *      import the helper and reference the validator name, so a future
 *      refactor that forgets one callsite triggers a CI failure.
 *
 * Per FM-SECURITY-AUDIT §2 M-2, §4 Chunk 2, §0.5 D1=(c).
 *
 * Run: `node --test tools/test-url-validation.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { _isAllowedImageHost, _describeRejection } = await import('../scripts/_url-validation.mjs');

const API_URL = 'https://chronicle.example.com';

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

test('_isAllowedImageHost: matching host → true', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com/media/foo.png', API_URL), true);
});

test('_isAllowedImageHost: matching host with different port → true (port not required to match)', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com:8443/media/foo.png', API_URL), true);
});

test('_isAllowedImageHost: matching host with query string + signed-URL params → true', () => {
  assert.equal(
    _isAllowedImageHost('https://chronicle.example.com/media/foo.png?expires=123&sig=abc', API_URL),
    true,
  );
});

test('_isAllowedImageHost: trailing slash on apiUrl tolerated', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com/foo.png', 'https://chronicle.example.com/'), true);
});

// ---------------------------------------------------------------------
// Cross-host rejection — the M-2 attack shape
// ---------------------------------------------------------------------

test('_isAllowedImageHost: attacker host → false', () => {
  assert.equal(_isAllowedImageHost('https://attacker.com/track.png', API_URL), false);
});

test('_isAllowedImageHost: subdomain of apiUrl → false (D1.1 default: strict hostname equality)', () => {
  assert.equal(_isAllowedImageHost('https://media.chronicle.example.com/foo.png', API_URL), false);
});

test('_isAllowedImageHost: protocol-confusion via userinfo → false', () => {
  // Classic phishing pattern: `https://chronicle.example.com@attacker.com/foo`
  // — the real host is `attacker.com`; chronicle.example.com is just userinfo.
  // `new URL()` parses correctly so the validator catches this.
  assert.equal(
    _isAllowedImageHost('https://chronicle.example.com@attacker.com/foo.png', API_URL),
    false,
  );
});

test('_isAllowedImageHost: protocol mismatch (http vs https) → false', () => {
  assert.equal(_isAllowedImageHost('http://chronicle.example.com/foo.png', API_URL), false);
});

// ---------------------------------------------------------------------
// Malformed input — fail closed
// ---------------------------------------------------------------------

test('_isAllowedImageHost: malformed URL → false', () => {
  assert.equal(_isAllowedImageHost('not-a-url', API_URL), false);
});

test('_isAllowedImageHost: empty url → false', () => {
  assert.equal(_isAllowedImageHost('', API_URL), false);
});

test('_isAllowedImageHost: null url → false (no throw)', () => {
  assert.equal(_isAllowedImageHost(null, API_URL), false);
});

test('_isAllowedImageHost: non-string url → false', () => {
  assert.equal(_isAllowedImageHost(42, API_URL), false);
});

test('_isAllowedImageHost: empty apiUrl → false (no allowed host → reject all)', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com/foo.png', ''), false);
});

test('_isAllowedImageHost: malformed apiUrl → false', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com/foo.png', 'not-a-url'), false);
});

test('_isAllowedImageHost: null apiUrl → false', () => {
  assert.equal(_isAllowedImageHost('https://chronicle.example.com/foo.png', null), false);
});

// ---------------------------------------------------------------------
// Non-http schemes — fail closed
// ---------------------------------------------------------------------

test('_isAllowedImageHost: javascript: scheme → false', () => {
  assert.equal(_isAllowedImageHost('javascript:alert(1)', API_URL), false);
});

test('_isAllowedImageHost: data: URI → false', () => {
  assert.equal(_isAllowedImageHost('data:image/png;base64,iVBORw0KGgo=', API_URL), false);
});

test('_isAllowedImageHost: file: scheme → false', () => {
  assert.equal(_isAllowedImageHost('file:///etc/passwd', API_URL), false);
});

// ---------------------------------------------------------------------
// _describeRejection — message shape
// ---------------------------------------------------------------------

test('_describeRejection: includes callsite kind, rejected URL, and apiUrl', () => {
  const msg = _describeRejection('map_image', 'https://attacker.com/x.png', API_URL);
  assert.ok(msg.includes('map_image'), 'message should include callsite kind');
  assert.ok(msg.includes('attacker.com'), 'message should include the rejected URL');
  assert.ok(msg.includes('chronicle.example.com'), 'message should include the expected apiUrl');
});

// ---------------------------------------------------------------------
// Static-source integration — pin every callsite
// ---------------------------------------------------------------------

test('scripts/map-sync.mjs imports from ./_url-validation.mjs', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/map-sync.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][/]_url-validation\.mjs['"]/.test(source),
    'map-sync.mjs must import from ./_url-validation.mjs',
  );
  assert.ok(
    /_isAllowedImageHost/.test(source),
    'map-sync.mjs must reference _isAllowedImageHost (gates Chronicle map image URLs)',
  );
});

test('scripts/map-viewer.mjs imports from ./_url-validation.mjs', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/map-viewer.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][/]_url-validation\.mjs['"]/.test(source),
    'map-viewer.mjs must import from ./_url-validation.mjs',
  );
  assert.ok(
    /_isAllowedImageHost/.test(source),
    'map-viewer.mjs must reference _isAllowedImageHost (gates token + map image URLs in the overlay)',
  );
});

test('scripts/map-sync.mjs: _mapImageSrc references the host check', () => {
  // The check has to live INSIDE _mapImageSrc, not in a sibling function;
  // pin the call near the function definition.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/map-sync.mjs'), 'utf8');
  const fnMatch = source.match(/function\s+_mapImageSrc\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected to find _mapImageSrc function body');
  assert.ok(
    /_isAllowedImageHost/.test(fnMatch[0]),
    '_mapImageSrc must invoke _isAllowedImageHost on full-URL candidates',
  );
});

test('scripts/map-viewer.mjs: _prepareToken references the host check', () => {
  // Token image surfaces directly in `<img src>` — the host check must
  // live inside _prepareToken, not be skipped by a later refactor.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/map-viewer.mjs'), 'utf8');
  const fnMatch = source.match(/_prepareToken\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, 'expected to find _prepareToken method body');
  assert.ok(
    /_isAllowedImageHost/.test(fnMatch[0]),
    '_prepareToken must invoke _isAllowedImageHost on full-URL token images',
  );
});
