#!/usr/bin/env node
/**
 * A player's quantity or equipped change is sent only when Chronicle says
 * the character is theirs and holds that relation. Their new items on their
 * own character are sent; on another character's they become a GM card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';

globalThis.Actor = globalThis.Actor ?? class {};
const { ItemSync } = await import('../scripts/item-sync.mjs');
const { PlayerAsks } = await import('../scripts/player-asks.mjs');

function make({ owner = 'm1', relations = [{ id: 'r1' }] } = {}) {
  settings.userMappings = JSON.stringify({ m1: 'player' });
  globalThis.game.users = { get: (id) => (id === 'player' ? { id, isGM: false } : null), activeGM: { id: 'gm' } };
  const is = new ItemSync();
  const calls = [];
  is._api = {
    get: async (path) => (path.endsWith('/relations') ? relations : { id: 'hero', owner_user_id: owner }),
    put: async (path, body) => { calls.push(['PUT', path, body]); return {}; },
    post: async (path) => { calls.push(['POST', path]); return { id: 'r9' }; },
  };
  is._syncManager = { recordUserOutcome: () => {} };
  return { is, calls };
}

function makeItem(flags = { relationId: 'r1' }) {
  const actor = new globalThis.Actor();
  actor.name = 'Hero';
  actor.getFlag = (_s, k) => (k === 'entityId' ? 'hero' : undefined);
  return {
    id: 'i1', name: 'Rope', parent: actor, system: { quantity: 2, equipped: false },
    getFlag: (_s, k) => flags[k],
    update: async () => {},
  };
}

const CHANGE = { system: { quantity: 2 } };

test('a player\'s quantity change on the character they claimed is sent', async () => {
  const { is, calls } = make();
  await is._handleUpdateItem(makeItem(), CHANGE, {}, 'player');
  assert.deepEqual(calls, [['PUT', '/relations/r1', { metadata: { quantity: 2, equipped: false } }]]);
});

const REFUSED = [
  ['the character is claimed by someone else', { owner: 'm2' }],
  ['the character is unclaimed', { owner: null }],
  ['the relation is not that character\'s', { relations: [{ id: 'other' }] }],
];
for (const [label, opts] of REFUSED) {
  test(`a player's quantity change is not sent when ${label}`, async () => {
    const { is, calls } = make(opts);
    await is._handleUpdateItem(makeItem(), CHANGE, {}, 'player');
    assert.deepEqual(calls, []);
  });
}

test('the GM\'s own change needs no check', async () => {
  const { is, calls } = make({ owner: null, relations: [] });
  await is._handleUpdateItem(makeItem(), CHANGE, {}, 'gm');
  assert.equal(calls.length, 1);
});

const NEW_FLAGS = { entityId: 'rope-page' };

test('a player\'s new item on their own character is sent, the GM\'s too', async () => {
  const a = make();
  await a.is._handleCreateItem(makeItem(NEW_FLAGS), {}, 'player');
  assert.deepEqual(a.calls, [['POST', '/entities/hero/relations']]);
  const b = make();
  await b.is._handleCreateItem(makeItem(NEW_FLAGS), {}, 'gm');
  assert.deepEqual(b.calls, [['POST', '/entities/hero/relations']]);
});

test('a player\'s new item on another character asks the GM and sends nothing', async () => {
  const asked = [];
  new PlayerAsks().ask = async (m) => { asked.push(m); };
  const { is, calls } = make({ owner: 'm2' });
  await is._handleCreateItem(makeItem(NEW_FLAGS), {}, 'player');
  assert.deepEqual(calls, []);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'item-add');
  assert.equal(asked[0].link.targetEntityId, 'rope-page');
});

test('a player\'s new item that points at a hidden page is not sent and asks nothing', async () => {
  const asked = [];
  new PlayerAsks().ask = async (m) => { asked.push(m); };
  for (const owner of ['m1', 'm2']) {
    const { is, calls } = make({ owner });
    const get = is._api.get;
    is._api.get = async (path) => (path === '/entities/rope-page' ? { id: 'rope-page', is_private: true } : get(path));
    await is._handleCreateItem(makeItem(NEW_FLAGS), {}, 'player');
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(asked, []);
});

test('removing an item from another character asks the GM instead of dropping it', async () => {
  const asked = [];
  new PlayerAsks().ask = async (m) => { asked.push(m); };
  const { is } = make({ owner: 'm2' });
  await is._handleDeleteItem(makeItem(), {}, 'player');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'item-remove');
  assert.equal(asked[0].link.relationId, 'r1');
});

test('removing an item whose relation is not on that character asks nothing', async () => {
  const asked = [];
  new PlayerAsks().ask = async (m) => { asked.push(m); };
  const { is } = make({ owner: 'm2', relations: [{ id: 'other' }] });
  await is._handleDeleteItem(makeItem(), {}, 'player');
  assert.deepEqual(asked, []);
});
