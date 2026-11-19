#!/usr/bin/env node
/**
 * What a player makes and deletes in Foundry, both sides real: their own
 * journal goes up as a page and its delete lands in Chronicle's Trash; an
 * item added to a character that is not theirs waits on a GM card, and Send
 * makes the relation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, settle, waitFor } from './world.mjs';
import { FLAG, scenario } from './scenario.mjs';

const ON = { syncCharacters: true, syncJournals: true };
const MODULES = { modules: ['journals', 'actors', 'items', 'playerAsks'] };
const PLAYER = 'benchPlayer00001';
const actorFor = (world, id) => world.game.actors.find((a) => a.getFlag(FLAG, 'entityId') === id);
const entityNamed = async (seed, name) => (await seed.chronicle.allEntities()).find((e) => e.name === name);

async function mapPlayer(seed, world) {
  const members = await seed.chronicle.get('/members');
  const member = (Array.isArray(members) ? members : members.data).find((m) => m.display_name === seed.displayName);
  const memberId = String(member.user_id ?? member.id);
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [memberId]: PLAYER }));
  return memberId;
}

async function typed(seed, name, pattern) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => pattern.test(t.slug) || pattern.test(t.name)) || types[0];
  return seed.chronicle.post('/entities', { name, entity_type_id: type.id, is_private: false });
}

test('a journal a player makes becomes a page, and deleting it moves the page to the Trash', () => scenario('fvtt-player-journal', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  await mapPlayer(seed, world);
  const journal = await world.asPlayer(() => world.game.JournalEntry.create({
    name: 'Mira\'s Diary', ownership: { default: 0, [PLAYER]: 3 },
  }));
  await waitFor(() => journal.getFlag(FLAG, 'entityId'), 10000, 'page created');
  await settle();
  assert.ok(await entityNamed(seed, 'Mira\'s Diary'), 'the page is in Chronicle');

  await world.asPlayer(() => journal.delete());
  await waitFor(async () => !(await entityNamed(seed, 'Mira\'s Diary')), 10000, 'page trashed');
  assert.equal(world.game.messages.size, 0, 'no card for a player\'s own journal');
}, { settings: ON }));

test('an item a player adds to someone else\'s character becomes a GM card, and Send makes the relation', () => scenario('fvtt-player-item-card', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  await mapPlayer(seed, world);
  const hero = await typed(seed, 'Sela Brightwater', /character/i);
  const rope = await typed(seed, 'Hemp Rope', /item/i);
  await waitFor(() => actorFor(world, hero.id), 10000, 'actor created');
  await settle();
  const actor = actorFor(world, hero.id);

  await world.asPlayer(() => actor.createEmbeddedDocuments('Item', [{
    name: 'Hemp Rope', type: 'equipment', system: { quantity: 1 }, flags: { [FLAG]: { entityId: rope.id } },
  }]));
  await waitFor(() => world.game.messages.size === 1, 10000, 'card posted');
  await settle();
  const relations = async () => (await seed.chronicle.get(`/entities/${hero.id}/relations`)).filter((r) => r.relationType === 'Has Item');
  assert.equal((await relations()).length, 0, 'nothing is sent before the GM answers');

  const [card] = world.game.messages.contents;
  assert.match(card.content, /Mira|Bench Player/);
  await world.playerAsks.answer(card.getFlag(FLAG, 'playerAsk').key, 'send');
  await waitFor(async () => (await relations()).length === 1, 10000, 'relation made');
  assert.equal(card.getFlag(FLAG, 'playerAsk').state, 'sent');
}, { settings: ON }));
