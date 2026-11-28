#!/usr/bin/env node
/**
 * `_map-access.mjs`: a synced map journal opens to players at the dashboard's
 * level, never above Observer, once per journal and only ever raised. Also
 * pins that map sync uses it on both the create and the update path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { MAP_ACCESS_FLAG, mapPlayerLevel, mapAccessUpdate } = await import('../scripts/_map-access.mjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LV = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
const SCOPE = 'chronicle-sync';

test('mapPlayerLevel: the dashboard level, capped at Observer', () => {
  const cases = [
    [LV.OBSERVER, LV.OBSERVER, 'the usual default'],
    [LV.LIMITED, LV.LIMITED, 'a lower dashboard level is kept'],
    [LV.NONE, LV.NONE, 'None keeps maps hidden'],
    [LV.OWNER, LV.OBSERVER, 'never Owner: players could rewrite the journal flags'],
    [-1, LV.NONE, 'garbage fails closed'],
    ['x', LV.NONE, 'garbage fails closed'],
  ];
  for (const [configured, want, why] of cases) assert.equal(mapPlayerLevel(configured, LV), want, why);
});

test('mapAccessUpdate: once per journal, raise only', () => {
  const flag = `flags.${SCOPE}.${MAP_ACCESS_FLAG}`;
  assert.equal(mapAccessUpdate({ default: 0 }, true, LV.OBSERVER, SCOPE), null, 'already set: a GM who hid it keeps it hidden');
  assert.deepEqual(mapAccessUpdate({ default: 0 }, false, LV.OBSERVER, SCOPE), { [flag]: true, 'ownership.default': LV.OBSERVER });
  assert.deepEqual(mapAccessUpdate(undefined, false, LV.OBSERVER, SCOPE), { [flag]: true, 'ownership.default': LV.OBSERVER }, 'no ownership reads as None');
  assert.deepEqual(mapAccessUpdate({ default: LV.OWNER }, false, LV.OBSERVER, SCOPE), { [flag]: true }, 'a higher default the GM set is left');
  assert.deepEqual(mapAccessUpdate({ default: 0, u1: LV.OBSERVER }, false, LV.NONE, SCOPE), { [flag]: true }, 'None changes nothing, a given map stays given');
  const up = mapAccessUpdate({ default: 0, u1: LV.OBSERVER }, false, LV.OBSERVER, SCOPE);
  assert.ok(!Object.keys(up).some((k) => k.includes('u1')), 'a user the GM let in is not touched');
});

test('map sync sets the access when it makes a map journal and on later syncs', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/map-sync.mjs'), 'utf8');
  assert.match(src, /ownership: \{ default: playerLevel \}/, 'created with the players\' level');
  assert.match(src, /\[MAP_ACCESS_FLAG\]: true/, 'and marked as set');
  assert.match(src, /mapAccessUpdate\(\s*entry\.ownership/, 'older journals get it once');
});
