#!/usr/bin/env node
/**
 * Creature sync, both sides real (the system's creature fields are the
 * bench stand-in in world.mjs). Chronicle owns the stat block; Foundry owns
 * only the pull fields, and sends them back only for a page that allows it,
 * which no bench page can (no system is enabled), so here they never go.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, closeWorld, settle, recordRequests, waitFor } from './world.mjs';
import { FLAG, writes, scenario } from './scenario.mjs';

const ON = { syncCreatures: true };
const MODULES = { modules: ['creatures'] };
const actorFor = (world, id) => world.game.actors.find((a) => a.getFlag(FLAG, 'creatureEntityId') === id);

/** A creature page made in Chronicle by someone else. */
async function chronicleCreature(seed, name, fields) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => t.slug === 'creature');
  assert.ok(type, 'campaign has a creature type');
  const e = await seed.chronicle.post('/entities', { name, entity_type_id: type.id, is_private: false });
  if (fields) await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: fields });
  return e;
}

test('a creature made in Chronicle becomes one NPC actor in the creatures folder and follows its edits', () => scenario('chr-creature-live', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCreature(seed, 'Skrix Webrider', { challenge_rating: '4', hp: 90 });
  await waitFor(() => actorFor(world, e.id)?.system?.cr === '4', 10000, 'actor created');
  await settle();
  const actors = world.game.actors.filter((a) => a.name === 'Skrix Webrider');
  assert.equal(actors.length, 1);
  assert.equal(actors[0].type, 'npc');
  assert.equal(actors[0].getFlag(FLAG, 'npcEntityId'), e.id, 'NPC tools see the link');
  assert.equal(actors[0].folder?.name, 'CHRONICLE.Creatures.Folder');
  assert.equal(actors[0].system.hp, 90, 'a new actor starts from the page');

  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { challenge_rating: '5', hp: 90 } });
  await seed.chronicle.put(`/entities/${e.id}`, { name: 'Skrix the Bold' });
  await waitFor(() => actorFor(world, e.id)?.name === 'Skrix the Bold' && actorFor(world, e.id)?.system?.cr === '5', 10000, 'edits applied');
  assert.equal(actorFor(world, e.id).system.hp, 90, 'an untouched current Stamina is not rewritten');
}, { settings: ON }));

test('a Foundry Stamina change stays in Foundry while the page does not allow sending back', () => scenario('fvtt-creature-edit', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCreature(seed, 'Goblin Sniper', { challenge_rating: '1', hp: 15 });
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  const reqs = await recordRequests(async () => {
    await actor.update({ 'system.hp': 4, 'system.cr': '9' });
    await settle();
  });
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`), [], 'nothing sent back');
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.hp, 15);
}, { settings: ON }));

test('creatures changed or removed while Foundry was closed catch up on open; actors are kept, and a second open writes nothing', () => scenario('chr-creature-offline', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const a = await chronicleCreature(seed, 'Ogre', { challenge_rating: '2' });
  const b = await chronicleCreature(seed, 'Gone Wolf', { challenge_rating: '1' });
  await waitFor(() => actorFor(world, a.id) && actorFor(world, b.id), 10000, 'actors created');
  await settle();
  await closeWorld(world);

  await seed.chronicle.put(`/entities/${a.id}/fields`, { fields_data: { challenge_rating: '3' } });
  await seed.chronicle.del(`/entities/${b.id}`);
  await openWorld(world, MODULES);
  assert.equal(actorFor(world, a.id).system.cr, '3');
  const kept = world.game.actors.filter((x) => x.name === 'Gone Wolf');
  assert.equal(kept.length, 1, 'actor kept');
  assert.ok(!kept[0].getFlag(FLAG, 'creatureEntityId'), 'actor unlinked');
  await closeWorld(world);

  const before = world.log.writes.length;
  const again = await recordRequests(async () => { await openWorld(world, MODULES); });
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'Actor').map((w) => `${w.op} ${JSON.stringify(w.change || {})}`), [], 'second open wrote no actor');
  assert.deepEqual(writes(again).map((r) => `${r.method} ${r.url}`), [], 'second open wrote nothing in Chronicle');
}, { settings: ON }));
