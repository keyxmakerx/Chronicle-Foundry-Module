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

/** The sheet fields these scenarios write, each with a value of its kind. */
const CREATURE_FIELDS = { challenge_rating: '', hp: 0, abilities_json: '' };

/** A creature page made in Chronicle by someone else. */
async function chronicleCreature(seed, name, fields) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => t.slug === 'creature');
  assert.ok(type, 'campaign has a creature type');
  await seed.declareFields(type.id, CREATURE_FIELDS);
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

const BITE = { name: 'Bite', type: 'signature', keywords: ['Melee', 'Strike'], distance: 'Melee 1', target: 'One creature', power_roll: '2d10 + 2', tier1: '3 damage', tier2: '5 damage', tier3: '7 damage; M < 2 {@condition bleeding} ({@duration save-ends|save ends})' };
const GAZE = { name: 'Gaze', type: 'action', keywords: ['Magic'], distance: '3 burst', target: 'Each enemy in the area', power_roll: '2d10 + 2', tier1: 'I < 0 dazed (save ends)', tier2: 'I < 1 dazed (save ends)', tier3: 'I < 2 dazed (save ends)' };
const ROAR = { name: 'Roar', type: 'maneuver', distance: 'Self', target: 'Self', effect: 'Each enemy within 2 is frightened.' };
const abilities = (actor) => actor.items.filter((i) => i.type === 'ability');

test('under Draw Steel a creature\'s abilities become ability items; the GM\'s own ability stays and a reopen writes nothing', () => scenario('chr-creature-abilities', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCreature(seed, 'Cave Drake', { challenge_rating: '3', abilities_json: JSON.stringify([BITE, GAZE]) });
  await waitFor(() => actorFor(world, e.id) && abilities(actorFor(world, e.id)).length === 2, 10000, 'abilities made');
  await settle();
  const actor = actorFor(world, e.id);
  const bite = abilities(actor).find((i) => i.name === 'Bite');
  assert.equal(bite.system.distance.type, 'melee');
  assert.equal(bite.system.power.roll.formula, '2');
  assert.deepEqual(Object.values(bite.system.power.effects).map((x) => x.type), ['damage', 'applied']);
  const gazeId = abilities(actor).find((i) => i.name === 'Gaze').id;

  // The GM adds their own Roar; Chronicle then adds a Roar and changes Bite.
  await actor.createEmbeddedDocuments('Item', [{ name: 'Roar', type: 'ability', system: {} }]);
  await settle();
  const reqs = await recordRequests(async () => {
    await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { challenge_rating: '3', abilities_json: JSON.stringify([{ ...BITE, tier1: '4 damage' }, GAZE, ROAR]) } });
    await waitFor(() => abilities(actorFor(world, e.id)).find((i) => i.name === 'Bite')?.system.power.effects && Object.values(abilities(actorFor(world, e.id)).find((i) => i.name === 'Bite').system.power.effects)[0].damage.tier1.value === '4', 10000, 'Bite rebuilt');
    await settle();
  });
  const names = abilities(actorFor(world, e.id)).map((i) => i.name).sort();
  assert.deepEqual(names, ['Bite', 'Gaze', 'Roar'], 'no second Roar beside the GM\'s');
  assert.ok(!abilities(actorFor(world, e.id)).find((i) => i.name === 'Roar').getFlag(FLAG, 'creatureAbility'), 'the GM\'s Roar is untouched');
  assert.equal(abilities(actorFor(world, e.id)).find((i) => i.name === 'Gaze').id, gazeId, 'an unchanged ability is not rebuilt');
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`).filter((w) => !w.includes(`/entities/${e.id}/fields`)), [], 'nothing sent to Chronicle');
  await closeWorld(world);

  // A live fields edit's broadcast carries the page's previous updated_at, so
  // the reopen may still refresh the actor's version flag; it must not touch
  // the abilities.
  const before = world.log.writes.length;
  await openWorld(world, MODULES);
  const again = world.log.writes.slice(before).filter((w) => w.type === 'Item'
    || (w.type === 'Actor' && JSON.stringify(w.change?.flags ?? {}) !== JSON.stringify({ [FLAG]: { creatureUpdatedAt: w.change?.flags?.[FLAG]?.creatureUpdatedAt } })));
  assert.deepEqual(again.map((w) => `${w.op} ${w.type} ${JSON.stringify(w.change || {})}`), [], 'reopen left the abilities alone');
}, { settings: ON, systemId: 'draw-steel' }));

test('under another system no ability items are made', () => scenario('chr-creature-abilities-other-system', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCreature(seed, 'Plain Drake', { challenge_rating: '3', abilities_json: JSON.stringify([BITE]) });
  await waitFor(() => actorFor(world, e.id)?.system?.cr === '3', 10000, 'actor created');
  await settle();
  assert.equal(abilities(actorFor(world, e.id)).length, 0);
}, { settings: ON }));
