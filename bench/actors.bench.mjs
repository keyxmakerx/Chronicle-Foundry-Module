#!/usr/bin/env node
/**
 * Character sync, both sides real (the game-system field mapping is the
 * bench adapter in world.mjs). Same end-of-scenario checks as journals, plus
 * no duplicate actors and no character turned into a journal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, closeWorld, settle, recordRequests, waitFor, traffic } from './world.mjs';
import { FLAG, writes, scenario } from './scenario.mjs';

const ON = { syncCharacters: true };
const MODULES = { modules: ['journals', 'actors'] };
const actorFor = (world, id) => world.game.actors.find((a) => a.getFlag(FLAG, 'entityId') === id);

/** The sheet keys these scenarios write, on either side. */
const CHARACTER_FIELDS = [
  { key: 'hp', type: 'number' },
  { key: 'ancestry', type: 'text' },
  { key: 'kit', type: 'text' },
];

/** A character made in Chronicle by someone else. */
async function chronicleCharacter(seed, name, hp) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => t.slug === 'character' || /character/i.test(t.name));
  assert.ok(type, 'campaign has a character type');
  await seed.declareFields(type.id, CHARACTER_FIELDS);
  const e = await seed.chronicle.post('/entities', { name, entity_type_id: type.id, is_private: false });
  if (hp !== undefined) await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp } });
  return e;
}

test('a character made in Chronicle while Foundry is open becomes one actor, not a journal', () => scenario('chr-character-live', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Mira Vale', 9);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  assert.equal(world.game.actors.filter((a) => a.name === 'Mira Vale').length, 1);
  assert.equal(world.game.journal.filter((j) => j.name === 'Mira Vale').length, 0);
}, { settings: ON }));

test('characters changed while Foundry was closed update on open from the feed, and a second open writes nothing', () => scenario('chr-character-offline', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const a = await chronicleCharacter(seed, 'Orin', 10);
  const b = await chronicleCharacter(seed, 'Tess', 8);
  const c = await chronicleCharacter(seed, 'Untouched', 5);
  await waitFor(() => actorFor(world, a.id) && actorFor(world, b.id) && actorFor(world, c.id), 10000, 'actors created');
  await settle();
  await closeWorld(world);

  await seed.chronicle.put(`/entities/${a.id}/fields`, { fields_data: { hp: 3 } });
  await seed.chronicle.put(`/entities/${b.id}`, { name: 'Tess the Bold' });

  const before = world.log.writes.length;
  const reqs = await recordRequests(async () => { await openWorld(world, MODULES); });
  const gets = reqs.filter((r) => r.method === 'GET').map((r) => r.url);
  assert.deepEqual(gets.filter((u) => u.startsWith('/entities?')), [], 'did not list every character');
  assert.equal(actorFor(world, a.id).system.hp, 3);
  assert.equal(actorFor(world, b.id).name, 'Tess the Bold');
  // Its data must not be written. A flag-only refresh of the recorded
  // version can happen: Chronicle's live message for a fields save carries
  // the version from before the save (keyxmakerx/Chronicle#985).
  const cId = actorFor(world, c.id).id;
  const dataWrites = world.log.writes.slice(before)
    .filter((w) => w.id === cId && Object.keys(w.change || {}).some((k) => k !== 'flags' && k !== '_id'));
  assert.deepEqual(dataWrites.map((w) => `${w.op} ${JSON.stringify(w.change)}`), [], 'untouched actor data not written');
  await closeWorld(world);

  const before2 = world.log.writes.length;
  const again = await recordRequests(async () => { await openWorld(world, MODULES); });
  assert.deepEqual(world.log.writes.slice(before2).filter((w) => w.type === 'Actor').map((w) => `${w.op} ${JSON.stringify(w.change || {})}`), [], 'second open wrote no actor');
  assert.deepEqual(writes(again).map((r) => `${r.method} ${r.url}`), [], 'second open wrote nothing in Chronicle');
}, { settings: ON }));

test('a character deleted in Chronicle while Foundry was closed unlinks its actor and keeps it', () => scenario('chr-character-delete', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Gone Hero', 4);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  await closeWorld(world);
  await seed.chronicle.del(`/entities/${e.id}`);
  await openWorld(world, MODULES);
  const kept = world.game.actors.filter((a) => a.name === 'Gone Hero');
  assert.equal(kept.length, 1, 'actor kept');
  assert.ok(!kept[0].getFlag(FLAG, 'entityId'), 'actor unlinked');
}, { settings: ON }));

test('a Foundry HP edit reaches Chronicle once and is not re-applied on reopen', () => scenario('fvtt-character-edit', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Brann', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  const reqs = await recordRequests(async () => {
    await actor.update({ 'system.hp': 12 });
    await settle();
  });
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.hp, 12);
  assert.equal(writes(reqs).filter((r) => r.url === `/entities/${e.id}/fields`).length, 1, 'one fields push');
  await closeWorld(world);

  const before = world.log.writes.length;
  await openWorld(world, MODULES);
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.id === actor.id).map((w) => `${w.op} ${JSON.stringify(w.change || {})}`), [], 'own push not re-applied');
  assert.equal(actor.system.hp, 12);
}, { settings: ON }));

test('a Chronicle ancestry pick swaps the actor\'s ancestry item from a compendium, and a custom kit becomes a plain item, with nothing pushed back', () => scenario('chr-identity-items', async ({ seed, world }) => {
  const modules = { modules: ['journals', 'actors', 'items'] };
  // An installed system compendium holding Dwarf; "Homebrew Kit" is nowhere.
  const dwarf = { name: 'Dwarf', type: 'ancestry', toObject: () => ({ _id: 'packDwarf', name: 'Dwarf', type: 'ancestry', system: { size: 'medium' } }) };
  world.game.packs = [{
    collection: 'bench.ancestries', documentName: 'Item', metadata: { packageType: 'system' },
    getIndex: async () => [{ _id: 'packDwarf', name: 'Dwarf', type: 'ancestry' }],
    getDocument: async () => dwarf,
  }];
  await openWorld(world, modules);
  const e = await chronicleCharacter(seed, 'Hild', 10);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  await actor.createEmbeddedDocuments('Item', [{ name: 'Human', type: 'ancestry' }, { name: 'Censor', type: 'class' }], { chronicleSyncApply: true });
  await settle();

  const before = world.log.writes.length;
  const reqs = await recordRequests(async () => {
    await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { ancestry: 'dwarf', kit: 'Homebrew Kit' } });
    await waitFor(() => actor.items.find((i) => i.type === 'kit'), 10000, 'kit item made');
    await settle();
  });

  const ancestry = actor.items.filter((i) => i.type === 'ancestry');
  assert.deepEqual(ancestry.map((i) => i.name), ['Dwarf'], 'old ancestry replaced by the compendium one');
  assert.equal(ancestry[0].system.size, 'medium', 'it is the compendium item\'s data');
  assert.equal(actor.items.filter((i) => i.type === 'class').length, 1, 'class untouched');
  const kit = actor.items.find((i) => i.type === 'kit');
  assert.equal(kit.name, 'Homebrew Kit');
  assert.equal(kit.getFlag(FLAG, 'chronicleMade'), true);
  assert.deepEqual(
    writes(reqs).filter((r) => !/^\/(sync|entities\/[^/]+\/fields)/.test(r.url)).map((r) => `${r.method} ${r.url}`),
    [], 'nothing pushed back for the item changes',
  );
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.ancestry, 'dwarf', 'Chronicle value untouched');
  const itemWrites = world.log.writes.slice(before).filter((w) => w.type === 'Item');
  assert.deepEqual(itemWrites.map((w) => w.op).sort(), ['create', 'create', 'delete']);

  // The same pick arriving again changes nothing.
  const again = world.log.writes.length;
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { ancestry: 'Dwarf' } });
  await settle();
  assert.deepEqual(world.log.writes.slice(again).filter((w) => w.type === 'Item'), [], 'no item churn on a repeat');
  await closeWorld(world);
}, { settings: ON }));

test('a character claimed in Chronicle gives the mapped Foundry player Owner on the actor, unclaiming changes nothing, and nothing is sent back', () => scenario('chr-claim-owner', async ({ seed, world }) => {
  // The campaign's only member is the GM who made it; the mapping table
  // points that member at a separate Foundry player (the GM user already
  // carries the same name, so auto-match would pick the GM).
  await seed.enableClaiming();
  world.game.users.set('benchPlayer00001', { id: 'benchPlayer00001', name: 'Bench Player', isGM: false, role: 1, flags: {} });
  await openWorld(world, MODULES);
  const members = await seed.chronicle.get('/members');
  const list = Array.isArray(members) ? members : members.data;
  const member = list.find((m) => m.display_name === seed.displayName);
  assert.ok(member, 'the campaign creator is a member');
  const memberId = String(member.user_id ?? member.id);
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [memberId]: 'benchPlayer00001' }));

  const e = await chronicleCharacter(seed, 'Claimed One', 7);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  assert.equal(actor.ownership.benchPlayer00001, undefined, 'unclaimed: no player owns it');

  const reqs = await recordRequests(async () => {
    await seed.assignOwner(e.id, memberId);
    await waitFor(() => actor.ownership.benchPlayer00001 === 3, 10000, 'claimant became Owner');
    await settle();
  });
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`), [], 'the ownership change was not sent back to Chronicle');

  await seed.assignOwner(e.id, null);
  await settle();
  assert.equal(actor.ownership.benchPlayer00001, 3, 'unclaim leaves Foundry ownership alone');
}, { settings: ON }));

test('a Chronicle edit to one field updates the actor once, marked as applied, with nothing pushed back; a repeat writes nothing', () => scenario('chr-field-apply', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Dara', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);

  const before = world.log.writes.length;
  const reqs = await recordRequests(async () => {
    await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 11 } });
    await waitFor(() => actor.system.hp === 11, 10000, 'hp applied');
    await settle();
  });
  const dataWrites = world.log.writes.slice(before)
    .filter((w) => w.id === actor.id && w.change?.system);
  assert.equal(dataWrites.length, 1, 'one actor data write');
  assert.deepEqual(dataWrites[0].change.system, { hp: 11 });
  assert.equal(dataWrites[0].options?.chronicleSyncApply, true, 'marked as an apply');
  // Only the module's own requests are recorded, so any fields PUT would be a push-back.
  assert.equal(writes(reqs).filter((r) => /\/fields$/.test(r.url) && r.method === 'PUT').length, 0, 'no push-back');

  const again = world.log.writes.length;
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 11 } });
  await settle();
  assert.deepEqual(world.log.writes.slice(again).filter((w) => w.id === actor.id && w.change?.system), [], 'same value writes nothing');
  await closeWorld(world);
}, { settings: ON }));

/** The running ActorSync, for scenarios that drive it at an exact moment. */
const actorSyncOf = (world) => world.syncManager._modules.find((m) => m.constructor.name === 'ActorSync');

test('a GM edit or new actor made while a Chronicle change is being applied still reaches Chronicle', () => scenario('fvtt-edit-during-apply', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const a = await chronicleCharacter(seed, 'Applied One', 10);
  const b = await chronicleCharacter(seed, 'Edited One', 10);
  await waitFor(() => actorFor(world, a.id) && actorFor(world, b.id), 10000, 'actors created');
  await settle();
  const other = actorFor(world, b.id);

  // The GM acts at the moment sync writes Chronicle's change to another actor.
  let made = null;
  const hook = Hooks.on('updateActor', (actor, change, options) => {
    if (made || !options?.chronicleSyncApply || actor.getFlag(FLAG, 'entityId') !== a.id || !change.system) return;
    made = Actor.create({ name: 'Made Mid-Sync', type: 'character', system: { hp: 6 } });
    other.update({ 'system.hp': 4 });
  });
  try {
    await seed.chronicle.put(`/entities/${a.id}/fields`, { fields_data: { hp: 3 } });
    await waitFor(() => made, 10000, 'the apply to run');
    await settle();
  } finally {
    Hooks.off('updateActor', hook);
  }
  const actor = await made;
  const entities = await seed.chronicle.allEntities();
  const page = entities.find((e) => e.name === 'Made Mid-Sync');
  assert.ok(page, 'the new actor got its Chronicle page');
  assert.equal(actor.getFlag(FLAG, 'entityId'), page.id, 'and is linked to it');
  assert.equal((await seed.chronicle.get(`/entities/${b.id}`)).fields_data?.hp, 4, 'the edit to the other actor was pushed');
  assert.equal(actorFor(world, a.id).system.hp, 3);
}, { settings: ON }));

test('two Chronicle changes applied at once push neither one back', () => scenario('chr-overlapping-applies', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const a = await chronicleCharacter(seed, 'Quick One', 10);
  const b = await chronicleCharacter(seed, 'Slow One', 10);
  await waitFor(() => actorFor(world, a.id) && actorFor(world, b.id), 10000, 'actors created');
  await settle();
  const sync = actorSyncOf(world);
  // Chronicle's copies. B is newly GM-only, so its apply hides the actor's
  // token, a write that must not come back as a Foundry edit; B's new kit
  // makes its apply read the campaign's entries first, so it is still
  // writing when A's quick apply finishes.
  await seed.chronicle.put(`/entities/${a.id}/fields`, { fields_data: { hp: 7 } });
  await seed.chronicle.post(`/entities/${b.id}/reveal`, { is_private: true });
  await seed.chronicle.put(`/entities/${b.id}/fields`, { fields_data: { hp: 2, kit: 'Spare Kit' } });
  await settle();
  const ea = await seed.chronicle.get(`/entities/${a.id}`);
  const eb = await seed.chronicle.get(`/entities/${b.id}`);
  // Put back what the live events applied, so both applies have work to do.
  const undo = { 'system.hp': 10, 'prototypeToken.hidden': false, 'flags.chronicle-sync.chronicleUpdatedAt': null };
  await actorFor(world, a.id).update(undo, { chronicleSyncApply: true });
  await actorFor(world, b.id).update(undo, { chronicleSyncApply: true });
  const kits = actorFor(world, b.id).items.filter((i) => i.type === 'kit').map((i) => i.id);
  await actorFor(world, b.id).deleteEmbeddedDocuments('Item', kits, { chronicleSyncApply: true });
  sync._entryCache?.clear();

  const reqs = await recordRequests(async () => {
    await Promise.all([sync._onCharacterUpdated(eb), sync._onCharacterUpdated(ea)]);
    await settle();
  });
  assert.ok(reqs.some((r) => r.url.startsWith('/system-entries')), 'the slow apply read the entries');
  assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'nothing pushed back');
  assert.equal(actorFor(world, b.id).prototypeToken.hidden, true);
  assert.equal(actorFor(world, b.id).system.hp, 2);
  assert.equal(actorFor(world, a.id).system.hp, 7);
  assert.equal((await seed.chronicle.get(`/entities/${b.id}`)).is_private, true, 'Chronicle still GM-only');
}, { settings: ON }));

test('a Chronicle copy that arrives while a Foundry HP push is on its way does not undo the edit', () => scenario('chr-copy-during-push', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Kell', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  const sync = actorSyncOf(world);
  // Chronicle's copy from before the edit: what a live event built before
  // the push landed carries.
  const before = await seed.chronicle.get(`/entities/${e.id}`);

  let applied = null;
  traffic.onSend = (req) => {
    if (applied || req.method !== 'PUT' || req.url !== `/entities/${e.id}/fields`) return;
    applied = { done: sync._onCharacterUpdated({ ...before }) };
  };
  try {
    await actor.update({ 'system.hp': 12 });
    await waitFor(() => applied, 10000, 'the push to leave');
    await applied.done;
    // Before Chronicle's own echo of the push could put it right again.
    assert.equal(actor.system.hp, 12, 'the copy did not roll the edit back');
    await settle();
  } finally {
    traffic.onSend = null;
  }
  assert.equal(actor.system.hp, 12, 'the Foundry edit is kept');
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.hp, 12, 'and is in Chronicle');
}, { settings: ON }));
