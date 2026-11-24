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

test('a character made in Chronicle while Foundry was closed gets its actor on open, and a second open makes no other', () => scenario('chr-character-made-offline', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  await closeWorld(world);
  const e = await chronicleCharacter(seed, 'Late Arrival', 11);

  await openWorld(world, MODULES);
  const actor = actorFor(world, e.id);
  assert.ok(actor, 'actor made on open');
  assert.equal(actor.system.hp, 11, 'with the character\'s fields');
  assert.equal(world.game.journal.filter((j) => j.name === 'Late Arrival').length, 0, 'not a journal');
  await closeWorld(world);

  const before = world.log.writes.length;
  const again = await recordRequests(async () => { await openWorld(world, MODULES); });
  assert.equal(world.game.actors.filter((a) => a.name === 'Late Arrival').length, 1, 'still one actor');
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'Actor' && w.op === 'create').map((w) => w.change?.name), [], 'second open made no actor');
  assert.deepEqual(writes(again).map((r) => `${r.method} ${r.url}`), [], 'second open wrote nothing in Chronicle');
}, { settings: ON }));

test('a character made while Foundry was closed is brought in on a full rescan too', () => scenario('chr-character-made-offline-full', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  await closeWorld(world);
  const e = await chronicleCharacter(seed, 'Rescan Arrival', 6);
  // No saved cursor: the connect lists every character instead of reading the feed.
  await world.game.settings.set('chronicle-sync', 'changeFeedCursor', null);
  await openWorld(world, MODULES);
  assert.ok(actorFor(world, e.id), 'actor made on open');
  assert.equal(world.game.actors.filter((a) => a.name === 'Rescan Arrival').length, 1);
}, { settings: ON }));

test('an actor the GM deletes here, keeping its character in Chronicle, is not made again on open', () => scenario('fvtt-character-delete-kept', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Benched', 5);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  world.answerConfirm = false;
  await actorFor(world, e.id).delete();
  await settle();
  assert.ok(await seed.chronicle.get(`/entities/${e.id}`), 'character kept in Chronicle');
  await closeWorld(world);
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 2 } });

  await openWorld(world, MODULES);
  assert.equal(world.game.actors.filter((a) => a.name === 'Benched').length, 0, 'not made again');
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

test('with live sync off, a sheet edit and a Chronicle edit to one character both wait for Sync now', () => scenario('hold-character', async ({ seed, world }) => {
  const sm = await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Odalys', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  await world.game.settings.set('chronicle-sync', 'autoSync', false);

  const reqs = await recordRequests(async () => {
    await actor.update({ 'system.hp': 9 });
    await seed.chronicle.put(`/entities/${e.id}`, { name: 'Odalys the Bold' });
    await settle();
  });
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`), [], 'nothing was sent while waiting');
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.hp, 20);
  assert.equal(actor.name, 'Odalys', 'Chronicle\'s edit waits');
  assert.equal(sm.heldCounts().foundry, 1);

  const result = await sm.syncNow();
  await settle();
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  const page = await seed.chronicle.get(`/entities/${e.id}`);
  assert.equal(page.fields_data?.hp, 9, 'the sheet edit arrived');
  assert.equal(page.name, 'Odalys the Bold', 'and did not undo Chronicle\'s edit');
  assert.equal(actor.name, 'Odalys the Bold', 'Chronicle\'s edit arrived');
  assert.equal(actor.system.hp, 9);
  assert.equal(sm.heldCounts().foundry, 0);
}, { settings: ON }));

test('a player\'s HP edit on the character they claimed reaches Chronicle and survives the next Chronicle change; on a character they have not claimed it is not sent', () => scenario('fvtt-player-edit', async ({ seed, world }) => {
  await seed.enableClaiming();
  await openWorld(world, MODULES);
  const members = await seed.chronicle.get('/members');
  const member = (Array.isArray(members) ? members : members.data).find((m) => m.display_name === seed.displayName);
  const memberId = String(member.user_id ?? member.id);
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [memberId]: 'benchPlayer00001' }));

  const mine = await chronicleCharacter(seed, 'Sela', 20);
  const other = await chronicleCharacter(seed, 'Not Sela', 20);
  await waitFor(() => actorFor(world, mine.id) && actorFor(world, other.id), 10000, 'actors created');
  await seed.assignOwner(mine.id, memberId);
  await settle();

  const actor = actorFor(world, mine.id);
  await world.asPlayer(() => actor.update({ 'system.hp': 7 }));
  await settle();
  assert.equal((await seed.chronicle.get(`/entities/${mine.id}`)).fields_data?.hp, 7, 'the player\'s edit is in Chronicle');
  await seed.chronicle.put(`/entities/${mine.id}/fields`, { fields_data: { ancestry: 'Elf' } });
  await settle();
  assert.equal(actor.system.hp, 7, 'the edit survives the next Chronicle change');

  const reqs = await recordRequests(async () => {
    await world.asPlayer(() => actorFor(world, other.id).update({ 'system.hp': 3 }));
    await settle();
  });
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`), [], 'nothing is written for a character the player has not claimed');
  assert.equal((await seed.chronicle.get(`/entities/${other.id}`)).fields_data?.hp, 20);
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

test('an origin item added, swapped or removed on the sheet in Foundry reaches Chronicle with no other edit', () => scenario('fdy-identity-item-push', async ({ seed, world }) => {
  await openWorld(world, { modules: ['journals', 'actors', 'items'] });
  const e = await chronicleCharacter(seed, 'Orla', 10);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  const ancestry = async () => (await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.ancestry;

  // The GM drags an ancestry onto the sheet: no actor field changes.
  await actor.createEmbeddedDocuments('Item', [{ name: 'Dwarf', type: 'ancestry' }]);
  await settle();
  assert.equal(await ancestry(), 'Dwarf', 'ancestry pushed');

  // Swapped for another: the old one goes, the new one arrives.
  const old = actor.items.find((i) => i.type === 'ancestry');
  await actor.deleteEmbeddedDocuments('Item', [old.id]);
  await actor.createEmbeddedDocuments('Item', [{ name: 'Orc', type: 'ancestry' }]);
  await settle();
  assert.equal(await ancestry(), 'Orc', 'swap pushed');

  // Removed with nothing in its place: Chronicle drops the pick too.
  await actor.deleteEmbeddedDocuments('Item', [actor.items.find((i) => i.type === 'ancestry').id]);
  await settle();
  assert.equal((await ancestry()) ?? '', '', 'removal pushed');
  assert.equal(actor.items.filter((i) => i.type === 'ancestry').length, 0, 'the clear does not come back as an item');
  await closeWorld(world);
}, { settings: ON }));

test('a class picked in Chronicle is noted on the actor for its player and never embedded, and the note goes once a class is on the sheet', () => scenario('chr-class-pick', async ({ seed, world }) => {
  await openWorld(world, { modules: ['journals', 'actors', 'items'] });
  const e = await chronicleCharacter(seed, 'Tyne', 10);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);

  const reqs = await recordRequests(async () => {
    await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { class: 'Fury', level: 2 } });
    await waitFor(() => actor.getFlag(FLAG, 'classPick'), 10000, 'class pick noted');
    await settle();
  });
  assert.deepEqual(actor.getFlag(FLAG, 'classPick'), { name: 'Fury', level: 2 });
  assert.equal(actor.items.filter((i) => i.type === 'class').length, 0, 'sync never embeds the class');
  assert.deepEqual(
    writes(reqs).filter((r) => !/^\/(sync|entities\/[^/]+\/fields)/.test(r.url)).map((r) => `${r.method} ${r.url}`),
    [], 'nothing pushed back for the note',
  );

  // The player finishes the hero; the next Chronicle change clears the note.
  await actor.createEmbeddedDocuments('Item', [{ name: 'Fury', type: 'class' }], { chronicleSyncApply: true });
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 6 } });
  await waitFor(() => actor.system.hp === 6, 10000, 'hp applied');
  await settle();
  assert.ok(!actor.getFlag(FLAG, 'classPick'), 'nothing left to finish');
  await closeWorld(world);
}, { settings: ON }));

test('a kit the GM swaps in Foundry survives a later Chronicle edit to another field', () => scenario('chr-identity-gm-swap', async ({ seed, world }) => {
  const modules = { modules: ['journals', 'actors', 'items'] };
  await openWorld(world, modules);
  const e = await chronicleCharacter(seed, 'Brann', 10);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { kit: 'Old Kit' } });
  const actor = actorFor(world, e.id);
  await waitFor(() => actor.items.find((i) => i.type === 'kit'), 10000, 'kit item made');
  await settle();

  // The GM swaps the kit by hand: the item hooks push nothing for it.
  const old = actor.items.find((i) => i.type === 'kit');
  await actor.createEmbeddedDocuments('Item', [{ name: 'New Kit', type: 'kit' }]);
  await actor.deleteEmbeddedDocuments('Item', [old.id]);
  await settle();

  // Someone edits another field in Chronicle; its copy still says Old Kit.
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 6 } });
  await waitFor(() => actor.system.hp === 6, 10000, 'hp applied');
  await settle();
  assert.deepEqual(actor.items.filter((i) => i.type === 'kit').map((i) => i.name), ['New Kit'], 'the GM\'s kit stays');

  // A new pick made in Chronicle still replaces it.
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { kit: 'Chosen Kit' } });
  await waitFor(() => actor.items.some((i) => i.name === 'Chosen Kit'), 10000, 'Chronicle\'s new pick applied');
  await settle();
  assert.deepEqual(actor.items.filter((i) => i.type === 'kit').map((i) => i.name), ['Chosen Kit']);
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

test('a hero older than the last sync, claimed later by a linked player with no hero here, gets its actor, owned by them and set as their character', () => scenario('chr-claim-brings-hero', async ({ seed, world }) => {
  await seed.enableClaiming();
  // Made before the world ever connected: the first connect imports nothing,
  // so this page has no actor, as a GM's unimported hero would.
  const e = await chronicleCharacter(seed, 'Waiting Hero', 9);
  const player = {
    id: 'benchNewPlayer01', name: 'New Player', isGM: false, role: 1, flags: {}, character: null,
    async update(change) { Object.assign(player, change); },
  };
  world.game.users.set(player.id, player);
  await openWorld(world, MODULES);
  assert.ok(!actorFor(world, e.id), 'not brought in on connect while unclaimed');

  const members = await seed.chronicle.get('/members');
  const member = (Array.isArray(members) ? members : members.data).find((m) => m.display_name === seed.displayName);
  const memberId = String(member.user_id ?? member.id);
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [memberId]: player.id }));
  await settle();

  const reqs = await recordRequests(async () => {
    await seed.assignOwner(e.id, memberId);
    await waitFor(() => actorFor(world, e.id)?.ownership?.[player.id] === 3, 10000, 'the claimed hero arrived, owned by its player');
    await settle();
  });
  const actor = actorFor(world, e.id);
  assert.equal(actor.system.hp, 9, 'with the character\'s fields');
  assert.equal(player.character, actor.id, 'it is the player\'s character');
  assert.deepEqual(writes(reqs).filter((r) => !/\/sync\/(mappings|players)/.test(r.url)).map((r) => `${r.method} ${r.url}`), [], 'nothing else written to Chronicle');
  assert.equal(world.game.actors.filter((a) => a.name === 'Waiting Hero').length, 1, 'one actor');
}, { settings: ON }));

test('a Foundry player added after connect, named like the claimant, is linked and owns the claimed actor without the GM', () => scenario('fvtt-player-added-later', async ({ seed, world }) => {
  await seed.enableClaiming();
  // The GM's Foundry name differs, so the campaign's one member starts unlinked.
  world.game.user.name = 'Bench Game Master';
  await openWorld(world, MODULES);
  const members = await seed.chronicle.get('/members');
  const member = (Array.isArray(members) ? members : members.data).find((x) => x.display_name === seed.displayName);
  const memberId = String(member.user_id ?? member.id);
  const e = await chronicleCharacter(seed, 'Claimed Later', 7);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await seed.assignOwner(e.id, memberId);
  await settle();
  const actor = actorFor(world, e.id);

  // Same name with other spacing and case, as people type it in Foundry.
  const loose = seed.displayName.replace(/\s+/g, '_').toUpperCase();
  const player = { id: 'benchLatePlayer01', name: loose, isGM: false, role: 1, flags: {} };
  world.game.users.set(player.id, player);
  world.Hooks.callAll('createUser', player, {}, world.game.user.id);
  await waitFor(() => actor.ownership[player.id] === 3, 10000, 'the new player owns the claimed actor');
  const saved = JSON.parse(world.game.settings.get('chronicle-sync', 'userMappings'));
  assert.equal(saved[memberId], player.id, 'the link is saved');
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
  // The recorded kit pick goes too, so the kit counts as Chronicle's new one.
  const undo = {
    'system.hp': 10, 'prototypeToken.hidden': false,
    'flags.chronicle-sync.chronicleUpdatedAt': null, 'flags.chronicle-sync.identityApplied': null,
  };
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

const layerEffects = (actor) => actor.effects.filter((fx) => fx.getFlag(FLAG, 'layer'));

test('a layer put on in Chronicle becomes one effect on the actor, a layered field is not pushed back, and taking it off removes only that effect', () => scenario('chr-layer-effect', async ({ seed, world }) => {
  await seed.enableTransformations();
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Mirela', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  await actor.createEmbeddedDocuments('ActiveEffect', [{ name: 'Bless', changes: [] }]);

  let layer;
  const reqs = await recordRequests(async () => {
    layer = await seed.putOnLayer(e.id, { name: 'Withered', source: '', note: '', changes: [
      { field: 'hp', op: 'add', value: -5 },
      { field: 'features_json', op: 'append', value: { name: 'Tough But Withered' }, label: 'Tough But Withered' },
    ] });
    await waitFor(() => layerEffects(actor).length === 1, 10000, 'layer effect made');
    await settle();
  });
  const fx = layerEffects(actor)[0];
  assert.equal(fx.name, 'Withered');
  assert.deepEqual(fx.changes, [{ key: 'system.hp', mode: 2, value: '-5' }]);
  assert.match(fx.description, /Adds Tough But Withered/);
  assert.deepEqual(writes(reqs).map((r) => `${r.method} ${r.url}`), [], 'nothing sent back');
  assert.equal(actor.system.hp, 20, "the actor's own HP is untouched");

  // A Foundry edit to a layered field stays in Foundry while the layer is on.
  const edit = await recordRequests(async () => {
    await actor.update({ 'system.hp': 14 });
    await settle();
  });
  assert.equal(writes(edit).filter((r) => r.url === `/entities/${e.id}/fields`).length, 0, 'layered field not pushed');
  assert.equal((await seed.chronicle.get(`/entities/${e.id}`)).fields_data?.hp, 20);

  await seed.takeOffLayer(layer.id);
  await waitFor(() => layerEffects(actor).length === 0, 10000, 'layer effect removed');
  await settle();
  assert.deepEqual(actor.effects.map((x) => x.name), ['Bless'], "the GM's own effect stays");
  await closeWorld(world);
}, { settings: ON }));

test('a layer put on while Foundry was closed arrives on open from the feed, and a second open writes nothing', () => scenario('chr-layer-offline', async ({ seed, world }) => {
  await seed.enableTransformations();
  await openWorld(world, MODULES);
  const e = await chronicleCharacter(seed, 'Oskar', 20);
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  await closeWorld(world);

  await seed.putOnLayer(e.id, { name: 'Vampire Scion', source: 'drawsteel:vampire-scion', note: '', changes: [
    { field: 'hp', op: 'set', value: 30 },
  ] });
  await openWorld(world, MODULES);
  await waitFor(() => layerEffects(actor).length === 1, 10000, 'layer effect made on open');
  await settle();
  assert.deepEqual(layerEffects(actor)[0].changes, [{ key: 'system.hp', mode: 5, value: '30' }]);
  await closeWorld(world);

  const before = world.log.writes.length;
  await openWorld(world, MODULES);
  await settle();
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'ActiveEffect'), [], 'an unchanged layer writes nothing');
  await closeWorld(world);
}, { settings: ON }));

// Under Draw Steel an NPC's character page becomes the system's NPC actor
// type (the bench hero type is the adapter's `character`).
const DRAW_STEEL = { settings: ON, systemId: 'draw-steel' };

/** The world's actor types: Draw Steel's NPC type exists unless left out. */
function actorTypes(world, types = ['character', 'npc']) {
  world.game.documentTypes = { Actor: types };
}

/** A character page made in Chronicle with its fields already filled in. */
async function characterWith(seed, name, fields, extra = {}) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => t.slug === 'character' || /character/i.test(t.name));
  await seed.declareFields(type.id, CHARACTER_FIELDS);
  return seed.chronicle.post('/entities', { name, entity_type_id: type.id, is_private: false, fields_data: fields, ...extra });
}

/** Counts the GM's yes/no questions while `world` is open. */
function countQuestions(world) {
  const api = world.globals.foundry.applications.api;
  const original = api.DialogV2.confirm;
  const seen = { asked: 0, restore: () => { api.DialogV2.confirm = original; } };
  api.DialogV2.confirm = async (...args) => { seen.asked++; return original(...args); };
  return seen;
}

/** The world as it was before sync told heroes and NPCs apart: an NPC page's actor made as a hero. */
async function legacyNpcHero(seed, world) {
  actorTypes(world, ['character']);
  await openWorld(world, MODULES);
  const npc = await characterWith(seed, 'Orsen Vey', { hp: 0 }, { is_private: true });
  const hero = await characterWith(seed, 'Saatraaol', { hp: 20, kit: 'Homebrew Kit' });
  await waitFor(() => actorFor(world, npc.id) && actorFor(world, hero.id), 10000, 'actors created');
  await settle();
  const orsen = actorFor(world, npc.id);
  assert.equal(orsen.type, 'character', 'made as a hero');
  await orsen.createEmbeddedDocuments('Item', [{ name: 'Human', type: 'ancestry' }, { name: 'Knife', type: 'treasure' }], { chronicleSyncApply: true });
  await orsen.update({ 'system.biography': { value: '<p>Owes the guild.</p>' } }, { chronicleSyncApply: true });
  await closeWorld(world);
  actorTypes(world);
  return { npc, hero, orsen };
}

test('under Draw Steel an NPC page becomes an NPC actor sharing only its name and visibility, a hero page stays a hero, and a GM\'s own NPC is never sent', () => scenario('chr-npc-page', async ({ seed, world }) => {
  actorTypes(world);
  await openWorld(world, MODULES);
  const npc = await characterWith(seed, 'Factor Brenn', { hp: 9 }, { is_private: true });
  const hero = await characterWith(seed, 'Tyne', { hp: 18, kit: 'Homebrew Kit' });
  await waitFor(() => actorFor(world, npc.id) && actorFor(world, hero.id), 10000, 'actors created');
  await settle();
  const brenn = actorFor(world, npc.id);
  assert.equal(brenn.type, 'npc', 'NPC page: NPC actor');
  assert.equal(brenn.system.hp, undefined, 'no hero fields on it');
  assert.equal(brenn.prototypeToken.hidden, true, 'a private page starts hidden');
  assert.equal(actorFor(world, hero.id).type, 'character', 'hero page: hero actor');
  assert.equal(actorFor(world, hero.id).system.hp, 18);

  const edits = await recordRequests(async () => {
    await brenn.update({ 'system.hp': 4 });
    await brenn.update({ name: 'Factor Brenn the Elder' });
    await settle();
  });
  assert.deepEqual(writes(edits).filter((r) => r.url === `/entities/${npc.id}/fields`).map((r) => r.method), [], 'NPC stats not sent as hero fields');
  const page = await seed.chronicle.get(`/entities/${npc.id}`);
  assert.equal(page.name, 'Factor Brenn the Elder', 'a rename is sent');
  assert.equal(page.fields_data?.hp, 9, 'Chronicle fields untouched');

  await seed.chronicle.put(`/entities/${npc.id}/fields`, { fields_data: { hp: 2 } });
  await seed.chronicle.put(`/entities/${npc.id}`, { name: 'Factor Brenn' });
  await waitFor(() => brenn.name === 'Factor Brenn', 10000, 'Chronicle rename applied');
  await settle();
  assert.equal(brenn.system.hp, 4, 'Chronicle fields not applied to an NPC');

  const made = await recordRequests(async () => {
    await Actor.create({ name: 'Goblin Sniper', type: 'npc' });
    await settle();
  });
  assert.deepEqual(writes(made).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'a GM\'s own NPC makes no page');
}, DRAW_STEEL));

test('an NPC page\'s actor made as a hero is offered as an NPC once on open; yes switches it, keeping its link, notes and items an NPC can hold', () => scenario('fvtt-npc-legacy-switch', async ({ seed, world }) => {
  const { npc, hero, orsen } = await legacyNpcHero(seed, world);
  globalThis.CONFIG = { Item: { dataModels: { ancestry: { metadata: { invalidActorTypes: ['npc'] } } } } };
  world.answerConfirm = true;
  try {
    const questions = countQuestions(world);
    const reqs = await recordRequests(async () => {
      await openWorld(world, MODULES);
      await waitFor(() => orsen.type === 'npc', 10000, 'switched to an NPC');
      await settle();
    });
    assert.equal(questions.asked, 1, 'asked once');
    assert.equal(orsen.getFlag(FLAG, 'entityId'), npc.id, 'still linked');
    assert.deepEqual(orsen.items.map((i) => i.name), ['Knife'], 'hero-only item gone, the rest kept');
    assert.equal(orsen.system.biography?.value, '<p>Owes the guild.</p>', 'notes kept');
    assert.equal(orsen.system.hp, undefined, 'hero data gone');
    assert.equal(actorFor(world, hero.id).type, 'character', 'the hero is left alone');
    assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'nothing written in Chronicle');
    questions.restore();
    await closeWorld(world);

    const again = countQuestions(world);
    const later = await recordRequests(async () => {
      await openWorld(world, MODULES);
      await seed.chronicle.put(`/entities/${npc.id}`, { name: 'Orsen Vey of Saltreach' });
      await waitFor(() => orsen.name === 'Orsen Vey of Saltreach', 10000, 'rename applied');
      await settle();
    });
    assert.equal(again.asked, 0, 'not asked again');
    assert.equal(orsen.type, 'npc');
    assert.deepEqual(later.filter((r) => r.method === 'GET' && r.url.startsWith('/entities?')).map((r) => r.url), [], 'no character list');
    again.restore();
  } finally {
    delete globalThis.CONFIG;
  }
}, DRAW_STEEL));

test('a No to switching an NPC page\'s hero actor is remembered: it stays a hero and is not offered again', () => scenario('fvtt-npc-legacy-declined', async ({ seed, world }) => {
  const { npc, orsen } = await legacyNpcHero(seed, world);
  world.answerConfirm = false;
  const questions = countQuestions(world);
  await openWorld(world, MODULES);
  await waitFor(() => world.log.notifications.info.some((m) => m.includes('CHRONICLE.ActorType.Declined')), 10000, 'the No recorded');
  await settle();
  assert.equal(questions.asked, 1, 'asked once');
  assert.equal(orsen.type, 'character', 'left as a hero');
  questions.asked = 0;
  await seed.chronicle.put(`/entities/${npc.id}/fields`, { fields_data: { hp: 3 } });
  await waitFor(() => orsen.system.hp === 3, 10000, 'Chronicle edit applied');
  await settle();
  assert.equal(questions.asked, 0, 'not offered again');
  questions.restore();
}, DRAW_STEEL));

test('an NPC actor whose page becomes a hero in Chronicle is offered as a hero; yes switches it and applies the page', () => scenario('chr-npc-becomes-hero', async ({ seed, world }) => {
  actorTypes(world);
  world.answerConfirm = true;
  await openWorld(world, MODULES);
  const e = await characterWith(seed, 'Pell Ashcombe', { hp: 7 });
  await waitFor(() => actorFor(world, e.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, e.id);
  assert.equal(actor.type, 'npc');
  await seed.chronicle.put(`/entities/${e.id}/fields`, { fields_data: { hp: 7, kit: 'Homebrew Kit' } });
  await waitFor(() => actor.type === 'character', 10000, 'switched to a hero');
  await waitFor(() => actor.system.hp === 7, 10000, 'page applied');
  await settle();
  assert.equal(actor.getFlag(FLAG, 'entityId'), e.id, 'still linked');
}, DRAW_STEEL));
