#!/usr/bin/env node
/**
 * Pins the module-version header: the pure builder, plus that every REST
 * fetch in api-client.mjs attaches it without clobbering caller-supplied
 * headers, and drops it once an older Chronicle refuses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildModuleVersionHeaders,
  MODULE_VERSION_HEADER,
  markModuleVersionHeaderRefused,
  moduleVersionHeaders,
  resetModuleVersionHeaderRefusal,
  shouldRetryWithoutVersionHeader,
} from '../scripts/_module-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('header name', () => assert.equal(MODULE_VERSION_HEADER, 'X-Chronicle-Module-Version'));

for (const [name, input, want] of [
  ['semver', '0.1.0', { 'X-Chronicle-Module-Version': '0.1.0' }],
  ['trimmed', ' 1.2.3 ', { 'X-Chronicle-Module-Version': '1.2.3' }],
  ['undefined', undefined, {}],
  ['empty', '', {}],
  ['non-string', 5, {}],
  ['newline injection', '1.0\r\nX-Evil: 1', {}],
]) {
  test(`builder: ${name}`, () => assert.deepEqual(buildModuleVersionHeaders(input), want));
}

test('api-client REST fetches attach the header before caller headers', () => {
  const src = read('scripts/api-client.mjs');
  assert.match(src, /moduleVersionHeaders,?\s[\s\S]*?\} from '\.\/_module-version\.mjs'/);
  const uses = src.match(/\.\.\.moduleVersionHeaders\(\)/g) || [];
  assert.equal(uses.length, 3, 'fetch(), getBlob() and uploadMedia() all send it');
  const f = src.indexOf("'Content-Type': 'application/json',");
  const callers = src.indexOf('...options.headers', f);
  const own = src.indexOf('...moduleVersionHeaders()', f);
  assert.ok(own > -1 && own < callers, 'caller headers still win');
  // Three REST paths, each with its one header-less retry.
  assert.equal((src.match(/await fetch\(/g) || []).length, 6, 'no new un-covered raw fetch');
});

// The dashboard's raw connection probes send no version header: they have no
// header-less retry, and an older Chronicle's CORS would refuse them.
test('dashboard connection probes do not send the header', () => {
  const src = read('scripts/sync-dashboard.mjs');
  assert.equal(src.includes('moduleVersionHeaders'), false);
});

test('moduleVersionHeaders reads the live manifest version', async () => {
  const { moduleVersionHeaders } = await import('../scripts/_module-version.mjs');
  const saved = globalThis.game;
  try {
    globalThis.game = { modules: new Map([['chronicle-sync', { version: '9.9.9' }]]) };
    assert.deepEqual(moduleVersionHeaders(), { 'X-Chronicle-Module-Version': '9.9.9' });
    globalThis.game = { modules: new Map() };
    assert.deepEqual(moduleVersionHeaders(), {});
    delete globalThis.game;
    assert.deepEqual(moduleVersionHeaders(), {});
  } finally {
    if (saved === undefined) delete globalThis.game; else globalThis.game = saved;
  }
});

// An older Chronicle's CORS allow-list lacks the header, so the browser
// refuses the preflight with a TypeError; the module retries once without it
// and stops sending it, instead of breaking every sync call.
test('older server: retry decision', () => {
  resetModuleVersionHeaderRefusal();
  const withV = { Authorization: 'Bearer x', [MODULE_VERSION_HEADER]: '1.0.0' };
  assert.equal(shouldRetryWithoutVersionHeader(new TypeError('Failed to fetch'), withV), true);
  assert.equal(shouldRetryWithoutVersionHeader(new Error('boom'), withV), false, 'only network TypeErrors');
  assert.equal(shouldRetryWithoutVersionHeader(new TypeError('Failed to fetch'), { Authorization: 'x' }), false, 'nothing to drop');
  markModuleVersionHeaderRefused();
  assert.equal(shouldRetryWithoutVersionHeader(new TypeError('Failed to fetch'), withV), false, 'retries once per session');
  resetModuleVersionHeaderRefusal();
});

test('older server: header stops after a refusal', () => {
  const prev = globalThis.game;
  globalThis.game = { modules: { get: () => ({ version: '2.0.0' }) } };
  try {
    resetModuleVersionHeaderRefusal();
    assert.deepEqual(moduleVersionHeaders(), { [MODULE_VERSION_HEADER]: '2.0.0' });
    markModuleVersionHeaderRefused();
    assert.deepEqual(moduleVersionHeaders(), {});
  } finally {
    resetModuleVersionHeaderRefusal();
    globalThis.game = prev;
  }
});

test('api-client retries without the header on every fetch path', () => {
  const src = read('scripts/api-client.mjs');
  const n = (src.match(/shouldRetryWithoutVersionHeader\(err, headers\)/g) || []).length;
  assert.equal(n, 3, 'fetch(), getBlob() and uploadMedia() all fall back');
});
