#!/usr/bin/env node
/**
 * Map sync, both sides real: a Chronicle map's markers and tokens and the
 * player-safe copies the GM's world stores on the map page. Chronicle sends
 * every map item change as an event, so nothing is polled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, closeWorld, settle, recordRequests, waitFor } from './world.mjs';
import { FLAG, scenario } from './scenario.mjs';

const ON = { syncMaps: true };
const MODULES = { modules: ['journals', 'maps'] };
const mapPage = (world, mapId) => world.game.journal.contents
  .flatMap((j) => j.pages.contents)
  .find((p) => p.getFlag(FLAG, 'mapId') === mapId);
const stored = (world, mapId, flag) => (mapPage(world, mapId)?.getFlag(FLAG, flag) || []);
const mapReads = (reqs, mapId) => reqs.filter((r) => r.method === 'GET' && r.url.includes(`/maps/${mapId}/`));

test('a marker added while Foundry was closed is on the map page after open, and a quiet reopen reads no map items', () => scenario('chr-maps-offline', async ({ seed, world }) => {
  const map = await seed.createMap('Harbour');
  await openWorld(world, MODULES);
  assert.ok(mapPage(world, map.id), 'map page made');
  await closeWorld(world);

  const marker = await seed.chronicle.post(`/maps/${map.id}/markers`, { name: 'Lighthouse', x: 40, y: 60, visibility: 'everyone' });
  await openWorld(world, MODULES);
  assert.deepEqual(stored(world, map.id, 'chronicleMarkers').map((m) => m.id), [marker.id], 'marker caught up');
  await closeWorld(world);

  const again = await recordRequests(async () => { await openWorld(world, MODULES); });
  assert.deepEqual(mapReads(again, map.id).map((r) => r.url), [], 'nothing changed, so no map items read');
}, { settings: ON }));

test('a token dragged in Chronicle moves on the stored map, and an open map is not polled', () => scenario('chr-maps-live', async ({ seed, world }) => {
  const map = await seed.createMap('Crossroads');
  const token = await seed.chronicle.post(`/maps/${map.id}/tokens`, { name: 'Wagon', x: 10, y: 10, width: 1, height: 1 });
  const sm = await openWorld(world, MODULES);
  const maps = sm._modules.find((m) => m.constructor.name === 'MapSync');
  await maps.onViewerOpen(map.id);
  await settle();
  assert.deepEqual(stored(world, map.id, 'chronicleTokens').map((t) => [t.id, t.x]), [[token.id, 10]]);

  await seed.chronicle.patch(`/maps/${map.id}/tokens/${token.id}/position`, { x: 70, y: 30 });
  await waitFor(() => stored(world, map.id, 'chronicleTokens')[0]?.x === 70, 10000, 'token moved');

  const quiet = await recordRequests(() => new Promise((r) => setTimeout(r, 6000)));
  assert.deepEqual(mapReads(quiet, map.id).map((r) => r.url), [], 'an open map is not polled');
  maps.onViewerClose(map.id);
}, { settings: ON }));
