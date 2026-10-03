#!/usr/bin/env node
/**
 * Pins the module-version header: the pure builder, plus that every REST
 * fetch in api-client.mjs and the dashboard connection probes attach it
 * without clobbering caller-supplied headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildModuleVersionHeaders, MODULE_VERSION_HEADER } from '../scripts/_module-version.mjs';

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
  assert.match(src, /import \{ moduleVersionHeaders \} from '\.\/_module-version\.mjs'/);
  const uses = src.match(/\.\.\.moduleVersionHeaders\(\)/g) || [];
  assert.equal(uses.length, 2, 'fetch() and uploadMedia() both send it');
  const f = src.indexOf("'Content-Type': 'application/json',");
  const callers = src.indexOf('...options.headers', f);
  const own = src.indexOf('...moduleVersionHeaders()', f);
  assert.ok(own > -1 && own < callers, 'caller headers still win');
  assert.equal((src.match(/await fetch\(/g) || []).length, 2, 'no new un-covered raw fetch');
});

test('dashboard connection probes attach the header', () => {
  const src = read('scripts/sync-dashboard.mjs');
  assert.equal((src.match(/\.\.\.moduleVersionHeaders\(\)/g) || []).length, 2);
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
