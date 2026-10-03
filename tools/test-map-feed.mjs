#!/usr/bin/env node
/**
 * Map catch-up from the change feed: fog names its map, an item is placed on
 * the map that holds it, an item nobody can place refreshes every map, a
 * full catch-up refreshes nothing beyond the old behaviour, and a failed
 * refresh throws so the cursor stays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapsToRefresh } from '../scripts/_map-feed.mjs';

const settings = { apiUrl: 'http://localhost:8080', campaignId: 'camp-1', syncMaps: true };
globalThis.foundry ??= { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } } };
globalThis.CONST ??= { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
globalThis.Hooks ??= { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui ??= { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game ??= {
  settings: { get: (_m, k) => settings[k], set: (_m, k, v) => { settings[k] = v; }, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  journal: { contents: [] },
};

const { MapSync } = await import('../scripts/map-sync.mjs');

const ch = (type, resourceId, op = 'updated') => ({ seq: 1, type, resourceId, op });

test('mapsToRefresh', async (t) => {
  const known = { 'marker:mk1': 'map-a', 'token:tk1': 'map-b' };
  const mapOf = (type, id) => known[`${type}:${id}`] || null;
  const cases = [
    { name: 'fog names its map', changes: [ch('fog', 'map-a')], ids: ['map-a'], all: false },
    { name: 'a known item is placed on its map', changes: [ch('marker', 'mk1'), ch('token', 'tk1', 'deleted')], ids: ['map-a', 'map-b'], all: false },
    { name: 'an unknown item refreshes every map', changes: [ch('drawing', 'dr9', 'created')], ids: [], all: true },
    { name: 'other feed types are ignored', changes: [ch('entity', 'e1'), ch('relation', 'r1')], ids: [], all: false },
    { name: 'no changes, nothing to do', changes: [], ids: [], all: false },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const out = mapsToRefresh(c.changes, mapOf);
      assert.deepEqual([...out.mapIds].sort(), c.ids);
      assert.equal(out.all, c.all);
    });
  }
});

function make({ pages, failMaps = new Set() }) {
  const ms = new MapSync();
  const refreshed = [];
  ms._api = { get: async () => [] };
  ms._runMapSync = async () => ({ materialized: 0, errors: 0 });
  ms._notifyViewers = () => {};
  ms.findPageByMapId = (id) => pages[id] || null;
  ms._materializedMapIds = () => Object.keys(pages);
  ms._refreshSubResources = async (id) => { refreshed.push(id); return { complete: !failMaps.has(id) }; };
  return { ms, refreshed };
}

const page = (flags = {}) => ({ getFlag: (_s, k) => flags[k] });

test('delta: only maps with changes are refreshed', async () => {
  const { ms, refreshed } = make({ pages: { 'map-a': page({ chronicleMarkers: [{ id: 'mk1' }] }), 'map-b': page() } });
  await ms.onInitialSync({ feed: { mode: 'delta', changes: [ch('marker', 'mk1')] } });
  assert.deepEqual(refreshed, ['map-a']);
});

test('delta: an item placed through the GM cache, hidden ones included', async () => {
  const { ms, refreshed } = make({ pages: { 'map-a': page(), 'map-b': page() } });
  ms._cache.set('map-b', { tokens: [{ id: 'tk-hidden', is_hidden: true }] });
  await ms.onInitialSync({ feed: { mode: 'delta', changes: [ch('token', 'tk-hidden')] } });
  assert.deepEqual(refreshed, ['map-b']);
});

test('delta: an item nobody can place refreshes every map once', async () => {
  const { ms, refreshed } = make({ pages: { 'map-a': page(), 'map-b': page() } });
  await ms.onInitialSync({ feed: { mode: 'delta', changes: [ch('drawing', 'new1', 'created'), ch('drawing', 'new2', 'created')] } });
  assert.deepEqual(refreshed, ['map-a', 'map-b']);
});

test('delta: fog for a map this world does not have is skipped', async () => {
  const { ms, refreshed } = make({ pages: { 'map-a': page() } });
  await ms.onInitialSync({ feed: { mode: 'delta', changes: [ch('fog', 'map-z')] } });
  assert.deepEqual(refreshed, []);
});

test('full: no sub-resource refresh, as before', async () => {
  const { ms, refreshed } = make({ pages: { 'map-a': page() } });
  await ms.onInitialSync({ feed: { mode: 'full' } });
  await ms.onInitialSync();
  assert.deepEqual(refreshed, []);
});

test('a failed refresh throws so the cursor stays', async () => {
  const { ms } = make({ pages: { 'map-a': page() }, failMaps: new Set(['map-a']) });
  await assert.rejects(ms.onInitialSync({ feed: { mode: 'delta', changes: [ch('fog', 'map-a')] } }));
});

test('maps join the feed only while map sync is on', () => {
  const ms = new MapSync();
  assert.equal(ms.feedArea, 'maps');
  assert.equal(ms.feedType, 'marker');
  assert.equal(ms.feedActive(), false, 'no API yet');
  ms._api = {};
  assert.equal(ms.feedActive(), true);
  settings.syncMaps = false;
  assert.equal(ms.feedActive(), false);
  settings.syncMaps = true;
});
