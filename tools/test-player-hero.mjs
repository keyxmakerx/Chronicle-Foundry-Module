#!/usr/bin/env node
/**
 * Pins _player-hero.mjs and its use in ActorSync: a linked player with no
 * hero in Foundry gets the hero they claimed in Chronicle, however old the
 * page is; a player who already has a hero, a GM, an unlinked member and a
 * page the GM turned sync off for get nothing; a claim made before the link
 * waits for it; and the actor becomes the player's assigned character only
 * when they have none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';
import { usersWithHero, planPlayerHeroes, memberClaims, assignsCharacter } from '../scripts/_player-hero.mjs';

const { ActorSync } = await import('../scripts/actor-sync.mjs');

const players = [{ id: 'gm', isGM: true }, { id: 'uNew' }, { id: 'uOld' }];

test('usersWithHero: explicit Owner on a hero actor or an assigned character counts; an everyone-owned actor does not', () => {
  const actors = [
    { id: 'a1', type: 'hero', ownership: { default: 0, uOld: 3 } },
    { id: 'a2', type: 'hero', ownership: { default: 3 } },
    { id: 'a3', type: 'npc', ownership: { default: 0, uNpc: 3 } },
    { id: 'a4', type: 'npc', ownership: { default: 0 } },
  ];
  const users = [
    { id: 'gm', isGM: true, character: { id: 'a1' } },
    { id: 'uOld' }, { id: 'uNew' }, { id: 'uNpc' },
    { id: 'uAssigned', character: { id: 'a4' } },
    { id: 'uGone', character: 'deleted-actor' },
  ];
  assert.deepEqual([...usersWithHero({ actors, users, actorType: 'hero' })].sort(), ['uAssigned', 'uOld']);
});

test('planPlayerHeroes: only a linked non-GM player with no hero, for a page with no actor that sync is on for', () => {
  const mappings = { cNew: 'uNew', cOld: 'uOld', cGM: 'gm', cDead: 'nobody' };
  const plan = planPlayerHeroes({
    claims: [
      { entityId: 'eNew', ownerKey: 'cNew' },
      { entityId: 'eOld', ownerKey: 'cOld' },
      { entityId: 'eGM', ownerKey: 'cGM' },
      { entityId: 'eDead', ownerKey: 'cDead' },
      { entityId: 'eNone', ownerKey: 'cUnlinked' },
      { entityId: null, ownerKey: 'cNew' },
    ],
    mappings,
    users: players,
    heroUserIds: ['uOld'],
  });
  assert.deepEqual(plan, [{ entityId: 'eNew', ownerKey: 'cNew', userId: 'uNew' }]);
  const base = { claims: [{ entityId: 'eNew', ownerKey: 'cNew' }], mappings, users: players };
  assert.deepEqual(planPlayerHeroes({ ...base, linkedEntityIds: ['eNew'] }), [], 'already has an actor');
  assert.deepEqual(planPlayerHeroes({ ...base, excludedIds: ['eNew'] }), [], 'the GM turned sync off for it');
});

test('planPlayerHeroes: one hero per player and one actor per page', () => {
  const plan = planPlayerHeroes({
    claims: [
      { entityId: 'e1', ownerKey: 'cNew' }, { entityId: 'e2', ownerKey: 'cNew' },
      { entityId: 'e1', ownerKey: 'cNew' },
    ],
    mappings: { cNew: 'uNew' },
    users: players,
  });
  assert.deepEqual(plan.map((p) => p.entityId), ['e1']);
});

test('memberClaims: each member with a character, keyed by member', () => {
  const key = (m) => m.user_id ?? null;
  assert.deepEqual(memberClaims([
    { user_id: 'cNew', character_entity_id: 'eNew' },
    { user_id: 'cBare' },
    { character_entity_id: 'eOrphan' },
  ], key), [{ entityId: 'eNew', ownerKey: 'cNew' }]);
  assert.deepEqual(memberClaims(null, key), []);
});

test('assignsCharacter: only a player with none, or one pointing at a deleted actor', () => {
  const ids = ['a1', 'a2'];
  assert.equal(assignsCharacter({ user: { id: 'u', character: null }, actorId: 'a1', actorIds: ids }), true);
  assert.equal(assignsCharacter({ user: { id: 'u', character: { id: 'gone' } }, actorId: 'a1', actorIds: ids }), true);
  assert.equal(assignsCharacter({ user: { id: 'u', character: { id: 'a2' } }, actorId: 'a1', actorIds: ids }), false, 'the GM assigned another');
  assert.equal(assignsCharacter({ user: { id: 'u', character: 'a1' }, actorId: 'a1', actorIds: ids }), false, 'already it');
  assert.equal(assignsCharacter({ user: { id: 'gm', isGM: true }, actorId: 'a1', actorIds: ids }), false);
  assert.equal(assignsCharacter({ user: null, actorId: 'a1', actorIds: ids }), false);
});

// --- ActorSync -------------------------------------------------------------

function heroActor(id, { entityId = null, ownership = { default: 0 } } = {}) {
  const flags = entityId ? { entityId } : {};
  return { id, name: id, type: 'hero', ownership, flags, getFlag: (_s, k) => flags[k] };
}

function setup({ actors = [], users, mappings = {}, members = [], entities = {}, excluded = [] } = {}) {
  settings.syncCharacters = true;
  settings.userMappings = JSON.stringify(mappings);
  settings.syncExclusions = JSON.stringify({ excludedTypes: [], excludedEntities: excluded });
  globalThis.game.user = { id: 'gm', isGM: true };
  const userList = users ?? [{ id: 'gm', isGM: true, name: 'GM' }, { id: 'uNew', isGM: false, name: 'New' }, { id: 'uOld', isGM: false, name: 'Old' }];
  globalThis.game.users = { contents: userList, get: (id) => userList.find((u) => u.id === id) };
  globalThis.game.actors = { contents: actors, find: (fn) => actors.find(fn), get: (id) => actors.find((a) => a.id === id) };
  const as = new ActorSync();
  const made = [];
  const log = [];
  const refreshed = [];
  as._adapter = { actorType: 'hero' };
  as._characterTypeId = 7;
  as._api = {
    get: async (p) => {
      const id = p.split('/').pop();
      if (!entities[id]) throw Object.assign(new Error('nf'), { status: 404 });
      return entities[id];
    },
  };
  as._syncManager = {
    getMembers: () => members,
    logActivity: (kind, text) => log.push([kind, text]),
    refreshMembersForClaim: async () => { refreshed.push(true); },
    pullGate: () => 'apply',
  };
  as._onCharacterCreated = async (entity) => {
    made.push(entity.id);
    actors.push(heroActor(`actor-${entity.id}`, { entityId: entity.id }));
    return true;
  };
  return { as, made, log, refreshed };
}

const hero = (id, owner, extra = {}) => ({ id, name: `Hero ${id}`, entity_type_id: 7, owner_user_id: owner, created_at: '2025-01-01T00:00:00Z', ...extra });

test('live claim: an old hero claimed by a linked player with no hero here gets its actor', async () => {
  const { as, made, log } = setup({ mappings: { cNew: 'uNew' } });
  await as._onCharacterUpdated(hero('eNew', 'cNew'));
  assert.deepEqual(made, ['eNew']);
  assert.equal(log[0][0], 'create');
});

test('live claim: nothing for a player who already owns a hero, an unclaimed page, or a page sync is off for', async () => {
  let s = setup({ actors: [heroActor('mine', { ownership: { default: 0, uOld: 3 } })], mappings: { cOld: 'uOld' } });
  await s.as._onCharacterUpdated(hero('eOld', 'cOld'));
  assert.deepEqual(s.made, [], 'already has a hero, even an unlinked one');
  s = setup({ mappings: { cNew: 'uNew' } });
  await s.as._onCharacterUpdated(hero('eFree', null));
  assert.deepEqual(s.made, [], 'unclaimed');
  s = setup({ mappings: { cNew: 'uNew' }, excluded: ['eNew'] });
  await s.as._onCharacterUpdated(hero('eNew', 'cNew'));
  assert.deepEqual(s.made, [], 'sync off for the page');
});

test('live claim before the link: waits, reads members again, and the link brings the hero in', async () => {
  const entities = { eNew: hero('eNew', 'cNew') };
  const { as, made, refreshed } = setup({ entities });
  await as._onCharacterUpdated(entities.eNew);
  assert.deepEqual(made, [], 'no Foundry user yet');
  assert.equal(refreshed.length, 1, 'members read again in case they just joined');
  settings.userMappings = JSON.stringify({ cNew: 'uNew' });
  await as.reconcileOwnership();
  assert.deepEqual(made, ['eNew']);
  await as.reconcileOwnership();
  assert.deepEqual(made, ['eNew'], 'a second pass makes no other');
});

test('reconcile: a member\'s claimed hero from the members list arrives once they are linked; a stale claim does not', async () => {
  const entities = { eNew: hero('eNew', 'cNew'), eMoved: hero('eMoved', 'cSomeoneElse') };
  const members = [
    { user_id: 'cNew', character_entity_id: 'eNew' },
    { user_id: 'cOld', character_entity_id: 'eMoved' },
  ];
  const { as, made } = setup({ entities, members, mappings: { cNew: 'uNew', cOld: 'uOld' } });
  await as.reconcileOwnership();
  assert.deepEqual(made, ['eNew'], 'the page now owned by someone else is left alone');
});

test('reconcile: nothing is made while characters take nothing from Chronicle', async () => {
  const entities = { eNew: hero('eNew', 'cNew') };
  const { as, made } = setup({ entities, members: [{ user_id: 'cNew', character_entity_id: 'eNew' }], mappings: { cNew: 'uNew' } });
  as._syncManager.pullGate = () => 'hold';
  await as.reconcileOwnership();
  assert.deepEqual(made, []);
});

test('reconcile: a page that is not a character, or is gone, is skipped without counting as a failure', async () => {
  const entities = { eNpc: { ...hero('eNpc', 'cNew'), entity_type_id: 99, type_name: 'Location' } };
  const { as, made } = setup({ entities, members: [{ user_id: 'cNew', character_entity_id: 'eNpc' }, { user_id: 'cOld', character_entity_id: 'eGone' }], mappings: { cNew: 'uNew', cOld: 'uOld' } });
  as._api.dropLastErrorLogEntry = () => {};
  assert.equal(await as._bringInPlayerHeroes(), 0);
  assert.deepEqual(made, []);
});

test('claim ownership: the player gets Owner and, having no character, the actor as their character', async () => {
  const updates = [];
  const users = [
    { id: 'gm', isGM: true, name: 'GM' },
    { id: 'uNew', isGM: false, name: 'New', character: null, update: async (d) => { updates.push(['uNew', d]); } },
    { id: 'uOld', isGM: false, name: 'Old', character: { id: 'theirs' }, update: async (d) => { updates.push(['uOld', d]); } },
  ];
  const actor = { ...heroActor('aNew', { entityId: 'eNew' }), update: async () => {} };
  const theirs = heroActor('theirs');
  const { as } = setup({ actors: [actor, theirs], users, mappings: { cNew: 'uNew', cOld: 'uOld' } });
  await as._applyClaimOwnership(actor, 'cNew', null);
  assert.deepEqual(updates, [['uNew', { character: 'aNew' }]]);
  await as._applyClaimOwnership(actor, 'cOld', 'cNew');
  assert.deepEqual(updates.length, 1, 'a character the GM assigned is kept');
});
