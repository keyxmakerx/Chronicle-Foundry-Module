#!/usr/bin/env node
/**
 * A player's quantity or equipped change is sent only when Chronicle says
 * the character is theirs and holds that relation; their new items are not
 * sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';

globalThis.Actor = globalThis.Actor ?? class {};
const { ItemSync } = await import('../scripts/item-sync.mjs');

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
    name: 'Rope', parent: actor, system: { quantity: 2, equipped: false },
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

test('a player\'s new item is not sent, the GM\'s is', async () => {
  const flags = { entityId: 'rope-page' };
  const a = make();
  await a.is._handleCreateItem(makeItem(flags), {}, 'player');
  assert.deepEqual(a.calls, []);
  const b = make();
  await b.is._handleCreateItem(makeItem(flags), {}, 'gm');
  assert.deepEqual(b.calls, [['POST', '/entities/hero/relations']]);
});
