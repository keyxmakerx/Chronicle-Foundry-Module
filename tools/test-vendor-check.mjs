#!/usr/bin/env node
/**
 * The check that this module's copies of Chronicle's page code match the
 * connected Chronicle (scripts/_vendor-check.mjs): Chronicle's digest list
 * is bounded and checked before use, a difference is reported per engine,
 * and an older Chronicle with no list is no difference and no logged error.
 *
 * Run: node --test tools/test-vendor-check.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINES, MAX_ASSETS, VENDOR_ASSETS_PATH, checkVendoredAssets, compareEngines, parseVendoredAssets,
} from '../scripts/_vendor-check.mjs';
import { VENDOR_MANIFEST } from '../scripts/_vendor-manifest.mjs';

const manifest = {
  'cutscene_engine.js': { engine: 'cutscenes', digest: 'aaaaaaaaaaaa' },
  'shop_room.js': { engine: 'shop', digest: 'bbbbbbbbbbbb' },
  'shop_room_counter.js': { engine: 'shop', digest: 'cccccccccccc' },
  'sky_gl.js': { engine: 'sky', digest: 'dddddddddddd' },
  'crafting.css': { engine: 'crafting', digest: 'eeeeeeeeeeee' },
};
const same = Object.fromEntries(Object.entries(manifest).map(([f, e]) => [f, e.digest]));

test('the list is kept only when keys are file names and values 12 hex', () => {
  const a = parseVendoredAssets({
    assets: {
      'shop_room.js': 'bbbbbbbbbbbb',
      'sky_gl.js': 'DDDDDDDDDDDD',
      'crafting.css': 'eeeeeeeeeee',
      '../etc/passwd': 'aaaaaaaaaaaa',
      'a/b.js': 'aaaaaaaaaaaa',
      [`${'x'.repeat(62)}.js`]: 'aaaaaaaaaaaa',
      'n.js': 12,
    },
  });
  assert.deepEqual({ ...a }, { 'shop_room.js': 'bbbbbbbbbbbb' });
  assert.ok(Object.isFrozen(a));
  assert.equal(Object.getPrototypeOf(a), null, 'a key like __proto__ can\'t reach Object.prototype');
});

test('no assets map is null: an older Chronicle or an odd answer', () => {
  for (const body of [null, undefined, {}, { version: 'v1' }, { assets: null }, { assets: [] }, { assets: 'x' }]) {
    assert.equal(parseVendoredAssets(body), null, JSON.stringify(body));
  }
  assert.deepEqual({ ...parseVendoredAssets({ data: { assets: { 'a.js': 'aaaaaaaaaaaa' } } }) }, { 'a.js': 'aaaaaaaaaaaa' });
});

test('at most MAX_ASSETS entries are looked at', () => {
  const big = {};
  for (let i = 0; i < MAX_ASSETS + 50; i++) big[`f${i}.js`] = 'aaaaaaaaaaaa';
  assert.equal(Object.keys(parseVendoredAssets({ assets: big })).length, MAX_ASSETS);
});

test('matching copies, and copies Chronicle doesn\'t list, are no difference', () => {
  assert.deepEqual(compareEngines(manifest, same), []);
  assert.deepEqual(compareEngines(manifest, { 'shop_room.js': 'bbbbbbbbbbbb' }), []);
  assert.deepEqual(compareEngines(manifest, {}), []);
  assert.deepEqual(compareEngines(manifest, { 'other.js': '000000000000' }), []);
});

test('no list at all is an older Chronicle: no difference', () => {
  assert.deepEqual(compareEngines(manifest, null), []);
  assert.deepEqual(compareEngines(manifest, undefined), []);
});

test('each engine with a differing copy is named once, in a fixed order', () => {
  assert.deepEqual(compareEngines(manifest, { ...same, 'shop_room_counter.js': '000000000000' }), ['shop']);
  assert.deepEqual(compareEngines(manifest, {
    ...same, 'crafting.css': '0', 'shop_room.js': '1', 'shop_room_counter.js': '2', 'cutscene_engine.js': '3',
  }), ['cutscenes', 'shop', 'crafting']);
});

test('the shipped manifest uses only the engines the Health pane names', () => {
  for (const { engine } of Object.values(VENDOR_MANIFEST)) assert.ok(ENGINES.includes(engine), engine);
  const assets = Object.fromEntries(Object.entries(VENDOR_MANIFEST).map(([f, e]) => [f, e.digest]));
  assert.deepEqual(compareEngines(VENDOR_MANIFEST, assets), []);
});

test('reads the list through the API client, so its key is sent', async () => {
  let asked;
  const api = { get: async (p) => { asked = p; return { assets: { ...same, 'sky_gl.js': '000000000000' } }; } };
  assert.deepEqual(await checkVendoredAssets(api, manifest), { reported: true, engines: ['sky'] });
  assert.equal(asked, VENDOR_ASSETS_PATH);
});

test('an older Chronicle\'s 404 is no list and leaves the error log', async () => {
  let dropped;
  const api = {
    get: async () => { throw Object.assign(new Error('Chronicle API error 404'), { status: 404 }); },
    dropLastErrorLogEntry: (m) => { dropped = m; },
  };
  assert.deepEqual(await checkVendoredAssets(api, manifest), { reported: false, engines: [] });
  assert.deepEqual(dropped, { status: 404, path: VENDOR_ASSETS_PATH });
});

test('other failures are no list and stay in the error log', async () => {
  let dropped = false;
  const api = {
    get: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
    dropLastErrorLogEntry: () => { dropped = true; },
  };
  assert.deepEqual(await checkVendoredAssets(api, manifest), { reported: false, engines: [] });
  assert.equal(dropped, false);
  assert.deepEqual(await checkVendoredAssets(null, manifest), { reported: false, engines: [] });
});
