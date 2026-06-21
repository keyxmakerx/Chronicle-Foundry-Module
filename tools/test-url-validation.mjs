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

// ---------------------------------------------------------------------
// F-1 static-source pin: journal-sync entity image-page src (FM-SEC-IMAGE-HOST-ALLOWLIST)
// A new type:'image' page src added to journal-sync without validation
// must fail this check, preventing the F-1 class from regressing.
// ---------------------------------------------------------------------

test('scripts/journal-sync.mjs imports from ./_url-validation.mjs (F-1 pin)', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][/]_url-validation\.mjs['"]/.test(source),
    'journal-sync.mjs must import from ./_url-validation.mjs (entity image-page host-allowlist)',
  );
  assert.ok(
    /_isAllowedImageHost/.test(source),
    'journal-sync.mjs must reference _isAllowedImageHost (gates entity image_path before type:image page src)',
  );
});

test('scripts/journal-sync.mjs: entity Image page src is not set directly from entity.image_path (F-1 pin)', () => {
  // Guard: the entity.image_path must not appear as a bare literal in a
  // type:'image' page object — it must flow through the validator.
  // This regex matches the dangerous pattern: `src: entity.image_path`
  // with no intervening call to _isAllowedImageHost or _resolveEntityImageSrc.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  assert.ok(
    !(/src\s*:\s*entity\.image_path/.test(source)),
    'journal-sync.mjs must NOT assign entity.image_path directly to image page src — route through _resolveEntityImageSrc (F-1)',
  );
});

test('scripts/journal-sync.mjs: _resolveEntityImageSrc validates full URLs via _isAllowedImageHost (F-1 pin)', () => {
  // The resolver function body must contain the host-check call.
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  const fnMatch = source.match(/function\s+_resolveEntityImageSrc\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected to find _resolveEntityImageSrc function body in journal-sync.mjs');
  assert.ok(
    /_isAllowedImageHost/.test(fnMatch[0]),
    '_resolveEntityImageSrc must invoke _isAllowedImageHost on full-URL entity.image_path values',
  );
});

// ---------------------------------------------------------------------
// F-2 unit tests: _setNestedValue prototype-pollution guard
// ---------------------------------------------------------------------

// Import actor-sync via dynamic import, but _setNestedValue is a module-
// private function. Test it through a lightweight inline reimplementation
// that mirrors the guard exactly — keeps the test self-contained and
// compatible with Foundry's browser-global environment (actor-sync
// references game.* which doesn't exist in Node).

const PROTO_BLOCKED_TEST = new Set(['__proto__', 'prototype', 'constructor']);
function _setNestedValueForTest(obj, path, value) {
  const keys = path.split('.');
  if (keys.some((k) => PROTO_BLOCKED_TEST.has(k))) return 'REJECTED';
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
  return 'OK';
}

test('_setNestedValue: normal path writes correctly (F-2 guard baseline)', () => {
  const obj = {};
  const result = _setNestedValueForTest(obj, 'system.abilities.str.value', 10);
  assert.equal(result, 'OK');
  assert.deepEqual(obj, { system: { abilities: { str: { value: 10 } } } });
});

test('_setNestedValue: __proto__ segment is rejected (F-2)', () => {
  const obj = {};
  const result = _setNestedValueForTest(obj, '__proto__.polluted', true);
  assert.equal(result, 'REJECTED', '__proto__ path must be rejected');
  // Verify prototype chain is untouched.
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
});

test('_setNestedValue: prototype segment is rejected (F-2)', () => {
  const result = _setNestedValueForTest({}, 'constructor.prototype.polluted', true);
  assert.equal(result, 'REJECTED', 'prototype segment must be rejected');
});

test('_setNestedValue: constructor segment is rejected (F-2)', () => {
  const result = _setNestedValueForTest({}, 'constructor.name', 'evil');
  assert.equal(result, 'REJECTED', 'constructor segment must be rejected');
});

test('_setNestedValue: mid-path __proto__ is rejected (F-2)', () => {
  const result = _setNestedValueForTest({}, 'system.__proto__.evil', 'x');
  assert.equal(result, 'REJECTED', '__proto__ anywhere in path must be rejected');
});

// Static-source: actor-sync.mjs must contain the guard.
test('scripts/actor-sync.mjs: _setNestedValue contains prototype-segment guard (F-2 pin)', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/actor-sync.mjs'), 'utf8');
  const fnMatch = source.match(/function\s+_setNestedValue\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected to find _setNestedValue function body in actor-sync.mjs');
  assert.ok(
    /PROTO_BLOCKED/.test(fnMatch[0]) || /__proto__/.test(fnMatch[0]),
    '_setNestedValue must guard against __proto__/prototype/constructor path segments (F-2)',
  );
});
