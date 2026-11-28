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

test('the world\'s scenes reach Chronicle on open and again after a rename, with no pictures', () => scenario('chr-maps-scenes', async ({ world }) => {
  const scenes = world.game.scenes;
  scenes.set('sc1', { id: 'sc1', name: 'Sunken Crypt', folder: { name: 'Caves', ancestors: [{ name: 'Act 2' }] }, active: false, navigation: true, background: { src: 'crypt.webm' } });
  scenes.set('sc2', { id: 'sc2', name: "Dragon's Lair", folder: null, active: true, navigation: false });
  // Foundry's sidebar tree: folders before loose scenes, so the report reads
  // Sunken Crypt first although it sorts after Dragon's Lair by name.
  scenes.tree = { entries: [scenes.get('sc2')], children: [{ entries: [], children: [{ entries: [scenes.get('sc1')], children: [] }] }] };
  const sceneReports = (reqs) => reqs.filter((r) => r.method === 'POST' && r.url === '/sync/scenes');

  const opened = await recordRequests(async () => { await openWorld(world, MODULES); await settle(); });
  const first = sceneReports(opened);
  assert.ok(first.length >= 1, 'a scene report was sent');
  assert.equal(first.at(-1).status, 200, 'Chronicle stored it');
  const body = JSON.parse(first.at(-1).body);
  assert.deepEqual(body.scenes.map((s) => [s.name, s.folder]), [['Sunken Crypt', 'Act 2 / Caves'], ["Dragon's Lair", '']], 'sidebar order');
  assert.doesNotMatch(first.at(-1).body, /crypt\.webm/, 'no picture paths travel');

  const renamed = await recordRequests(async () => {
    scenes.get('sc1').name = 'Flooded Crypt';
    world.Hooks.callAll('updateScene', scenes.get('sc1'), { name: 'Flooded Crypt' }, {}, world.game.user.id);
    await settle();
  });
  const again = sceneReports(renamed);
  assert.equal(again.length, 1, 'one report after the rename');
  assert.match(again[0].body, /Flooded Crypt/);

  const quiet = await recordRequests(async () => {
    world.Hooks.callAll('updateScene', scenes.get('sc1'), { darkness: 0.5 }, {}, world.game.user.id);
    await settle();
  });
  assert.deepEqual(sceneReports(quiet), [], 'an unchanged list is not sent again');
}));

test('a map given from Foundry goes through Chronicle: the carried item opens the journal for the hero\'s player, and taking it back in Chronicle takes the journal back; an editable handout page opens nothing', () => scenario('fvtt-maps-give-handout', async ({ seed, world }) => {
  const PLAYER = 'benchPlayer00001';
  const MAPS_AND_ITEMS = { modules: ['journals', 'actors', 'items', 'maps'] };
  await seed.enableAddon('armory');
  await seed.enableClaiming();
  const player = await seed.addPlayer();
  const types = await seed.chronicle.entityTypes();
  const charType = types.find((t) => t.slug === 'character' || /character/i.test(t.name));
  const map = await seed.createMap('Smugglers Cove');
  const playerMap = async () => (await player.web.get(`/campaigns/${seed.campaignId}/maps/${map.id}`)).status;

  const sm = await openWorld(world, MAPS_AND_ITEMS);
  await world.game.settings.set(FLAG, 'userMappings', JSON.stringify({ [player.userId]: PLAYER }));
  await world.asPlayer(async () => {}, PLAYER);
  const hero = await seed.chronicle.post('/entities', { name: 'Wren', entity_type_id: charType.id, is_private: false });
  await seed.assignOwner(hero.id, player.userId);
  assert.equal(await playerMap(), 404, 'Chronicle hides the map from the player before the give');
  const actorOf = () => world.game.actors.find((a) => a.getFlag(FLAG, 'entityId') === hero.id);
  await waitFor(actorOf, 10000, 'actor made');
  const actor = actorOf();
  await actor.update({ ownership: { default: 0, [PLAYER]: 3 } });
  await waitFor(() => mapPage(world, map.id), 10000, 'map journal made');
  const page = mapPage(world, map.id);
  const entry = page.parent;
  assert.notEqual(entry.ownership?.[PLAYER], 2, 'the player cannot open the map journal yet');

  const { registerMapSheetItems, giveMapToActor } = await import('../scripts/map-sheet-items.mjs');
  const items = sm._modules.find((m) => m.constructor.name === 'ItemSync');
  registerMapSheetItems({ api: () => sm.api, items: () => items });
  const gave = await recordRequests(() => giveMapToActor(page, actor));
  // Other sync traffic (mappings) can land in the same window; only the give matters here.
  assert.deepEqual(gave.filter((r) => r.method === 'POST' && r.url.startsWith('/stashes/')).map((r) => `${r.url} ${r.status}`), ['/stashes/give 200'], 'the give went to Chronicle');

  const carriedOf = () => actor.items.find((i) => i.getFlag(FLAG, 'mapId') === map.id);
  await waitFor(carriedOf, 10000, 'the handout arrived and carries the map');
  const carried = carriedOf();
  assert.equal(carried.getFlag(FLAG, 'mapPageUuid'), page.uuid, 'its Open button opens the map journal');
  assert.match(carried.name, /^Map: Smugglers Cove/);
  await waitFor(() => entry.ownership?.[PLAYER] === 2, 10000, 'the hero\'s player may open the map journal');
  assert.deepEqual(entry.getFlag(FLAG, 'mapHandoutTo'), [actor.id]);
  assert.deepEqual(entry.getFlag(FLAG, 'mapHandoutRaised'), [PLAYER], 'the raise is remembered as the handout\'s');
  assert.equal(await playerMap(), 200, 'Chronicle shows the map to the player now');
  assert.equal(actor.items.filter((i) => i.getFlag(FLAG, 'mapId') === map.id).length, 1, 'one item, not a Foundry copy as well');

  const rels = await seed.chronicle.get(`/entities/${hero.id}/relations`);
  const line = (Array.isArray(rels) ? rels : rels.data).find((r) => r.relationType === 'Has Item' && r.targetEntityName.startsWith('Map: '));
  await seed.chronicle.del(`/relations/${line.id}`);
  await waitFor(() => entry.ownership?.[PLAYER] === undefined, 10000, 'taking the item back takes the journal back');
  assert.deepEqual(entry.getFlag(FLAG, 'mapHandoutTo'), []);
  assert.deepEqual(entry.getFlag(FLAG, 'mapHandoutRaised'), []);
  assert.equal(await playerMap(), 404, 'and Chronicle hides the map again');

  // A handout page someone below the Director may edit could name any map, so
  // a line to it opens nothing, in Chronicle or in Foundry.
  await seed.chronicle.put(`/entities/${line.targetEntityId}/permissions`, { visibility: 'custom', permissions: [
    { subject_type: 'role', subject_id: '2', permission: 'edit' },
    { subject_type: 'user', subject_id: player.userId, permission: 'view' },
  ] });
  const again = await seed.chronicle.post(`/entities/${hero.id}/relations`, {
    target_entity_id: line.targetEntityId, relation_type: 'Has Item', reverse_relation_type: 'In Inventory Of', metadata: { quantity: 1 },
  });
  const againId = again?.id ?? again?.data?.id;
  await waitFor(() => actor.items.find((i) => i.getFlag(FLAG, 'relationId') === againId), 10000, 'the line reached the sheet');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(entry.ownership?.[PLAYER], undefined, 'an editable handout page opens no journal');
  assert.equal(await playerMap(), 404, 'nor the map in Chronicle');
}, { settings: { syncMaps: true, syncCharacters: true } }));
