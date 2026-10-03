#!/usr/bin/env node
/**
 * Behavioural tests for the stash inventory refresh: it never deletes on its
 * own, and the one removal is the item an applied move took away.
 *
 * Run: `node --test tools/test-stash-reconcile.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { itemsToRemove, removalFromMove } from '../scripts/_stash-reconcile.mjs';
import './_journal-test-env.mjs';

const { ItemSync } = await import('../scripts/item-sync.mjs');

test('itemsToRemove: nothing is removed without a moved item id', () => {
  const items = [{ id: 'a', relationId: 1, entityId: 'rope' }];
  assert.deepEqual(itemsToRemove(items, [], []), []);
  assert.deepEqual(itemsToRemove(items, [], undefined), []);
});

test('itemsToRemove: only the moved item whose relation is gone', () => {
  const items = [
    { id: 'rope', relationId: 1, entityId: 'E-rope' },
    { id: 'orphan', relationId: 2, entityId: 'E-trashed' },
    { id: 'drag', relationId: undefined, entityId: undefined },
    { id: 'kept', relationId: 3, entityId: 'E-rope' },
  ];
  assert.deepEqual(itemsToRemove(items, [3], ['E-rope']), [{ id: 'rope', relationId: 1 }]);
});

test('removalFromMove: only an applied item move away from a character', () => {
  const move = { kind: 'item', itemId: 'E1', from: { kind: 'character', id: 'c1' }, to: { kind: 'stash', id: '7' } };
  assert.deepEqual(removalFromMove({ status: 'applied', move }), { characterId: 'c1', itemId: 'E1' });
  assert.equal(removalFromMove({ status: 'pending', move }), null);
  assert.equal(removalFromMove({ status: 'applied', move: { ...move, kind: 'money' } }), null);
  assert.equal(removalFromMove({ status: 'applied', move: { ...move, itemId: '' } }), null);
  assert.equal(removalFromMove({ status: 'applied', move: { ...move, from: { kind: 'stash', id: '7' } } }), null);
  assert.equal(removalFromMove(null), null);
});

// --- ItemSync.refreshInventory against a fake actor ----------------------

function setup(relations, itemDefs) {
  const deleted = [];
  const created = [];
  const items = itemDefs.map((d) => ({
    id: d.id,
    name: d.id,
    getFlag: (_s, k) => d[k],
    update: async () => {},
  }));
  const actor = {
    id: 'aria',
    name: 'Aria',
    items: { contents: items, get: (id) => items.find((i) => i.id === id) },
    getFlag: (_s, k) => (k === 'entityId' ? 'char1' : undefined),
    createEmbeddedDocuments: async (_t, docs) => { created.push(...docs); },
    deleteEmbeddedDocuments: async (_t, ids) => { deleted.push(...ids); },
  };
  globalThis.game.actors = { find: () => actor };
  const sync = new ItemSync();
  sync._api = { get: async () => relations };
  return { sync, actor, deleted, created };
}

const ORPHANS = [
  { id: 'rope', relationId: 1, entityId: 'E-rope' },
  { id: 'orphan', relationId: 2, entityId: 'E-trashed' },
  { id: 'dragged', relationId: undefined, entityId: undefined },
];

test('refreshInventory: with no removal, unrelated and orphaned items all survive', async () => {
  const { sync, actor, deleted } = setup([], ORPHANS);
  await sync.refreshInventory(actor);
  assert.deepEqual(deleted, []);
});

test('refreshInventory: removes only the moved item whose relation is gone', async () => {
  const { sync, actor, deleted } = setup([], ORPHANS);
  await sync.refreshInventory(actor, { removeItemIds: ['E-rope'] });
  assert.deepEqual(deleted, ['rope']);
});

test('refreshInventory: a moved item whose relation still exists is kept', async () => {
  const rel = { id: 1, relationType: 'Has Item', targetEntityId: 'E-rope', metadata: { quantity: 2 } };
  const { sync, actor, deleted } = setup([rel], ORPHANS);
  await sync.refreshInventory(actor, { removeItemIds: ['E-rope'] });
  assert.deepEqual(deleted, []);
});

test('refreshInventory: a moved item its relation event already unlinked is still removed', async () => {
  const { sync, actor, deleted } = setup([], [{ id: 'rope', unlinkedRelationId: 1, entityId: 'E-rope' }, ...ORPHANS.slice(1)]);
  await sync.refreshInventory(actor, { removeItemIds: ['E-rope'] });
  assert.deepEqual(deleted, ['rope']);
});

test('refreshInventory: a failed fetch deletes nothing', async () => {
  const { sync, actor, deleted } = setup([], ORPHANS);
  sync._api = { get: async () => { throw new Error('down'); } };
  await sync.refreshInventory(actor, { removeItemIds: ['E-rope'] });
  assert.deepEqual(deleted, []);
});
