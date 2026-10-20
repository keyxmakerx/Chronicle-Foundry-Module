#!/usr/bin/env node
/**
 * Journals land in Foundry folders nested like Chronicle's sidebar
 * (scripts/_folder-tree.mjs): category inside parent category, then the
 * page's folders; a sub-page sits in its parent's folder; the chain stops
 * at Foundry's depth limit, and loops in the data can't hang it.
 *
 * Run: node --test tools/test-folder-tree.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { folderChain, layoutFingerprint } from '../scripts/_folder-tree.mjs';

const types = new Map([
  [1, { id: 1, name: 'Locations' }],
  [2, { id: 2, name: 'Cities', parent_type_id: 1, color: '#123456' }],
  [3, { id: 3, name: 'Notes' }],
]);
const folders = new Map([
  ['f1', { id: 'f1', name: 'North', entity_type_id: 2 }],
  ['f2', { id: 'f2', name: 'Coast', entity_type_id: 2, parent_id: 'f1' }],
  ['f3', { id: 'f3', name: 'Under a page', entity_type_id: 2, parent_id: 'p1' }],
  ['fx', { id: 'fx', name: 'Other category', entity_type_id: 3 }],
]);
const parents = new Map([
  ['p1', { parent_node_id: 'f2' }],
  ['p2', { parent_id: 'p1' }],
]);
const tree = { types, folders, parents };
const keys = (chain) => chain.map((l) => l.key);

test('a category sits inside its parent category', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2 }, tree)), ['type:1', 'type:2']);
  assert.equal(folderChain({ entity_type_id: 2 }, tree)[1].color, '#123456');
});

test('a page goes in its folders, outermost first', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_node_id: 'f2' }, tree)), ['type:1', 'type:2', 'node:f1', 'node:f2']);
});

test('a sub-page sits in its parent page\'s folder', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_id: 'p2' }, tree)), ['type:1', 'type:2', 'node:f1', 'node:f2']);
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_id: 'unknown' }, tree)), ['type:1', 'type:2']);
});

test('a folder under a page sits in that page\'s folder', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_node_id: 'f3' }, tree, 9)), ['type:1', 'type:2', 'node:f1', 'node:f2', 'node:f3']);
});

test('Foundry\'s depth limit cuts the chain', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_node_id: 'f3' }, tree, 3)), ['type:1', 'type:2', 'node:f1']);
});

test('a folder from another category is ignored', () => {
  assert.deepEqual(keys(folderChain({ entity_type_id: 2, parent_node_id: 'fx' }, tree)), ['type:1', 'type:2']);
});

test('an unknown category falls back to the page\'s own type name', () => {
  assert.deepEqual(folderChain({ entity_type_id: 9, type_name: 'Lore' }, tree).map((l) => l.name), ['Lore']);
  assert.deepEqual(folderChain({ entity_type_id: 9 }, tree), []);
});

test('loops in the data end', () => {
  const loopTypes = new Map([[1, { id: 1, name: 'A', parent_type_id: 2 }], [2, { id: 2, name: 'B', parent_type_id: 1 }]]);
  const loopFolders = new Map([['a', { id: 'a', name: 'a', entity_type_id: 1, parent_id: 'b' }], ['b', { id: 'b', name: 'b', entity_type_id: 1, parent_id: 'a' }]]);
  const chain = folderChain({ entity_type_id: 1, parent_node_id: 'a' }, { types: loopTypes, folders: loopFolders, parents: new Map() }, 9);
  assert.ok(chain.length <= 4);
});

test('the fingerprint changes when the layout does', () => {
  const a = layoutFingerprint(tree);
  assert.equal(a, layoutFingerprint({ types: new Map(types), folders: new Map(folders) }));
  const moved = new Map(folders);
  moved.set('f2', { ...folders.get('f2'), parent_id: null });
  assert.notEqual(a, layoutFingerprint({ types, folders: moved }));
});
