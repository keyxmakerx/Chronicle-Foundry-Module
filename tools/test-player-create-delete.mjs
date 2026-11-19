#!/usr/bin/env node
/**
 * A player's own creates and deletes go straight to Chronicle (a delete lands
 * in Chronicle's Trash); a delete of something that is not theirs becomes a
 * GM card. A link on a player's new document is never trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal, installJournals, settings } from './_journal-test-env.mjs';

globalThis.Actor = globalThis.Actor ?? class {};
const { JournalSync } = await import('../scripts/journal-sync.mjs');
const { ActorSync } = await import('../scripts/actor-sync.mjs');
const { PlayerAsks } = await import('../scripts/player-asks.mjs');

function users() {
  settings.userMappings = JSON.stringify({ m1: 'player' });
  globalThis.game.users = { get: (id) => (id === 'player' ? { id, name: 'Mira', isGM: false } : null), activeGM: { id: 'gm' }, contents: [] };
}

function asks() {
  const asked = [];
  new PlayerAsks().ask = async (m) => { asked.push(m); };
  return asked;
}

// --- journals ---------------------------------------------------------------

function journalSync({ page = { name: 'Notes' }, grants = [{ subject_type: 'user', subject_id: 'm1', permission: 'edit' }] } = {}) {
  users();
  const js = new JournalSync();
  const calls = [];
  js._api = {
    get: async (p) => {
      if (p === '/entity-types') return [{ id: 7, name: 'Notes', enabled: true }];
      if (p.endsWith('/permissions')) return { visibility: 'custom', permissions: grants };
      return page;
    },
    post: async (p, b) => { calls.push(['POST', p, b]); return { id: 'new-page' }; },
    put: async (p, b) => { calls.push(['PUT', p, b]); return {}; },
    delete: async (p) => { calls.push(['DELETE', p]); },
  };
  js._syncManager = { ensureMapping: async () => {}, logActivity: () => {}, recordUserOutcome: () => {} };
  js._entryForPush = async () => '';
  js._pushPermissions = async () => {};
  js._journalPushDebouncer = { schedule() {}, cancel() {}, flush() {}, flushAll() {} };
  return { js, calls };
}

test('a journal a player creates is sent as a page', async () => {
  const j = makeJournal({ id: 'pj', name: 'My notes' });
  installJournals([j]);
  const { js, calls } = journalSync();
  await js._handleCreateJournal(j, {}, 'player');
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['POST', '/entities']]);
  assert.equal(calls[0][2].name, 'My notes');
  assert.equal(j.flags.entityId, 'new-page');
});

test('a link on a journal a player creates is dropped, so it can never aim at someone else\'s page', async () => {
  const j = makeJournal({ id: 'pj', name: 'Mine', flags: { entityId: 'gm-secret-page' } });
  installJournals([j]);
  const { js, calls } = journalSync();
  await js._handleCreateJournal(j, {}, 'player');
  assert.equal(j.flags.entityId, 'new-page');
  assert.equal(calls.filter((c) => c[0] === 'PUT' && c[1].includes('gm-secret-page')).length, 0);
  assert.equal(calls[0][0], 'POST');
});

test('with another GM as the active one, this client does not send a player\'s journal', async () => {
  const j = makeJournal({ id: 'pj', name: 'Mine' });
  installJournals([j]);
  const { js, calls } = journalSync();
  globalThis.game.users.activeGM = { id: 'other-gm' };
  await js._handleCreateJournal(j, {}, 'player');
  assert.deepEqual(calls, []);
});

test('a player deleting their own journal moves its page to the Trash, no card', async () => {
  const asked = asks();
  const j = makeJournal({ id: 'pj', name: 'Notes', flags: { entityId: 'e1' } });
  const { js, calls } = journalSync();
  await js._handleDeleteJournal(j, {}, 'player');
  assert.deepEqual(calls, [['DELETE', '/entities/e1']]);
  assert.deepEqual(asked, []);
});

test('a player deleting a journal they cannot edit in Chronicle becomes a GM card', async () => {
  const asked = asks();
  const j = makeJournal({ id: 'pj', name: 'Notes', flags: { entityId: 'e1' } });
  const { js, calls } = journalSync({ grants: [] });
  await js._handleDeleteJournal(j, {}, 'player');
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'journal-remove');
  assert.equal(asked[0].who, 'Mira');
  assert.equal(asked[0].link.entityId, 'e1');
});

test('a player\'s journal whose link names a page with another name is not deleted without the GM', async () => {
  const asked = asks();
  const j = makeJournal({ id: 'pj', name: 'Notes', flags: { entityId: 'e1' } });
  const { js, calls } = journalSync({ page: { name: 'The Vault Plans' } });
  await js._handleDeleteJournal(j, {}, 'player');
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
});

// --- actors -----------------------------------------------------------------

function actorSync({ owner = 'm1', name = 'Sela' } = {}) {
  users();
  const sync = new ActorSync();
  const calls = [];
  sync._api = {
    get: async () => ({ id: 'ent-1', name, owner_user_id: owner }),
    post: async (p, b) => { calls.push(['POST', p, b]); return { id: 'new-char' }; },
    delete: async (p) => { calls.push(['DELETE', p]); },
  };
  sync._syncManager = { ensureMapping: async () => {}, isPcClaimingEnabled: () => false, recordUserOutcome: () => {} };
  sync._adapter = { toChronicleFields: () => ({}) };
  sync._characterTypeId = 3;
  return { sync, calls };
}

const actorDoc = (flags = {}) => {
  const f = { ...flags };
  return {
    id: 'a1', name: 'Sela', type: 'character', items: { contents: [] }, flags: f,
    getFlag: (_s, k) => f[k],
    update: async (d) => { for (const [k, v] of Object.entries(d)) { const m = k.match(/^flags\.chronicle-sync\.(-=)?(.+)$/); if (m) { if (m[1]) delete f[m[2]]; else f[m[2]] = v; } } },
  };
};

test('a character a player creates is sent', async () => {
  const { sync, calls } = actorSync();
  const a = actorDoc();
  await sync._handleCreateActor(a, {}, 'player');
  assert.equal(calls[0][0], 'POST');
  assert.equal(a.flags.entityId, 'new-char');
});

test('a link on a character a player creates is dropped', async () => {
  const { sync, calls } = actorSync();
  const a = actorDoc({ entityId: 'someone-elses-character' });
  globalThis.game.actors = { find: () => null };
  await sync._handleCreateActor(a, {}, 'player');
  assert.equal(a.flags.entityId, 'new-char');
  assert.equal(calls[0][0], 'POST');
});

test('a player deleting their own claimed character moves it to the Trash, no card', async () => {
  const asked = asks();
  const { sync, calls } = actorSync();
  await sync._handleDeleteActor(actorDoc({ entityId: 'ent-1' }), {}, 'player');
  assert.deepEqual(calls, [['DELETE', '/entities/ent-1']]);
  assert.deepEqual(asked, []);
});

test('a player deleting someone else\'s character becomes a GM card', async () => {
  const asked = asks();
  const { sync, calls } = actorSync({ owner: 'm2' });
  await sync._handleDeleteActor(actorDoc({ entityId: 'ent-1' }), {}, 'player');
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'actor-remove');
});

test('a player\'s character whose link names a page with another name is not deleted without the GM', async () => {
  const asked = asks();
  const { sync, calls } = actorSync({ name: 'The Queen' });
  await sync._handleDeleteActor(actorDoc({ entityId: 'ent-1' }), {}, 'player');
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
});
