#!/usr/bin/env node
/**
 * The dashboard's Chronicle version comes from the public GET /api/version
 * (scripts/_chronicle-version.mjs): no key sent, and anything unreadable
 * shows as unknown rather than failing the connect.
 *
 * Run: node --test tools/test-chronicle-version.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChronicleVersion } from '../scripts/_chronicle-version.mjs';

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

test('reads the version from the public endpoint without credentials', async () => {
  let seen;
  const v = await fetchChronicleVersion('https://chronicle.example/', async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ version: 'v1.4.0' }) };
  });
  assert.equal(v, 'v1.4.0');
  assert.equal(seen.url, 'https://chronicle.example/api/version');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.headers, undefined);
});

test('anything unreadable is null', async () => {
  assert.equal(await fetchChronicleVersion('', reply({ version: 'x' })), null);
  assert.equal(await fetchChronicleVersion('https://c', reply({}, false)), null);
  assert.equal(await fetchChronicleVersion('https://c', reply({ version: 'unknown' })), null);
  assert.equal(await fetchChronicleVersion('https://c', reply({ version: 3 })), null);
  assert.equal(await fetchChronicleVersion('https://c', async () => { throw new Error('offline'); }), null);
});
