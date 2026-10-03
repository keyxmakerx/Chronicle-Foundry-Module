#!/usr/bin/env node
/**
 * Inventory reconcile plan: an item already matching its relation is not
 * touched, a Foundry-made item whose push has not recorded its relation is
 * linked rather than copied, and an item whose relation is not on this
 * character is unlinked, never deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planInventory, itemDataFor, relationMeta, HAS_ITEM } from '../scripts/_inventory-plan.mjs';

const rel = (id, target, meta, over = {}) => ({ id, relationType: HAS_ITEM, sourceEntityId: 'hero', targetEntityId: target, targetEntityName: target, metadata: meta, ...over });
const item = (id, relationId, entityId, quantity = 1, equipped = false) => ({ id, relationId, entityId, quantity, equipped });
const empty = { create: [], update: [], adopt: [], unlink: [] };

test('plan', async (t) => {
  const cases = [
    { name: 'nothing to do when items match', rels: [rel(1, 'sword', { quantity: 2, equipped: true })], items: [item('a', 1, 'sword', 2, true)], want: empty },
    { name: 'a string metadata matches too', rels: [rel(1, 'sword', '{"quantity":2}')], items: [item('a', 1, 'sword', 2)], want: empty },
    { name: 'relation ids compare as strings', rels: [rel(1, 'sword', {})], items: [item('a', '1', 'sword')], want: empty },
    { name: 'a new relation creates an item', rels: [rel(1, 'sword', { quantity: 1 })], items: [], want: { ...empty, create: [rel(1, 'sword', { quantity: 1 })] } },
    { name: 'a quantity change updates only that field', rels: [rel(1, 'sword', { quantity: 3, equipped: false })], items: [item('a', 1, 'sword', 1)], want: { ...empty, update: [{ id: 'a', change: { 'system.quantity': 3 } }] } },
    { name: 'an absent field is left alone', rels: [rel(1, 'sword', {})], items: [item('a', 1, 'sword', 7, true)], want: empty },
    { name: 'a gone relation unlinks its item', rels: [], items: [item('a', 1, 'sword')], want: { ...empty, unlink: ['a'] } },
    { name: 'a copy carrying another character\'s relation is unlinked', rels: [rel(1, 'sword', {})], items: [item('a', 1, 'sword'), item('b', 5, 'rope')], want: { ...empty, unlink: ['b'] } },
    { name: 'a replaced relation adopts the stale item and fixes its quantity', rels: [rel(2, 'sword', { quantity: 3 })], items: [item('a', 1, 'sword', 1)], want: { ...empty, adopt: [{ id: 'a', relationId: 2 }], update: [{ id: 'a', change: { 'system.quantity': 3 } }] } },
    { name: 'a Foundry item without a relation yet is adopted, not copied', rels: [rel(9, 'rope', { quantity: 1 })], items: [item('f', null, 'rope')], want: { ...empty, adopt: [{ id: 'f', relationId: 9 }] } },
    { name: 'one unlinked item is adopted once', rels: [rel(8, 'rope', {}), rel(9, 'rope', {})], items: [item('f', null, 'rope')], want: { ...empty, adopt: [{ id: 'f', relationId: 8 }], create: [rel(9, 'rope', {})] } },
    { name: 'custom items (no Chronicle entity) are never touched', rels: [], items: [item('c', null, null)], want: empty },
    { name: 'other relation types are ignored', rels: [rel(1, 'ally', {}, { relationType: 'allied with' })], items: [], want: empty },
  ];
  for (const c of cases) {
    await t.test(c.name, () => assert.deepEqual(planInventory(c.rels, c.items), c.want));
  }
});

test('itemDataFor links the item to its relation and Chronicle item', () => {
  assert.deepEqual(itemDataFor(rel(4, 'sword', '{"quantity":2,"equipped":true}')), {
    name: 'sword', type: 'equipment',
    flags: { 'chronicle-sync': { relationId: 4, entityId: 'sword' } },
    system: { quantity: 2, equipped: true },
  });
  assert.equal(itemDataFor({ id: 5, targetEntityId: 'x' }).name, 'Unknown Item');
});

test('relationMeta tolerates bad metadata', () => {
  assert.deepEqual(relationMeta({ metadata: 'not json' }), {});
  assert.deepEqual(relationMeta({ metadata: 'null' }), {});
  assert.deepEqual(relationMeta({}), {});
});
