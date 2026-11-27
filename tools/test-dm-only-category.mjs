#!/usr/bin/env node
/**
 * A page in Chronicle's DM-only category (Adventures) counts as private for
 * sync (scripts/_dm-only-category.mjs), from the page's own mark or from its
 * category, so a page sent without the mark is still caught.
 *
 * Run: node --test tools/test-dm-only-category.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inDmOnlyCategory } from '../scripts/_dm-only-category.mjs';

const types = new Map([
  [1, { id: 1, name: 'Adventures', preset_category: 'adventures' }],
  [2, { id: 2, name: 'Locations' }],
  [3, { id: 3, name: 'Kind of adventure', parent_type_id: 1 }],
  [4, { id: 4, name: 'Loop A', parent_type_id: 5 }],
  [5, { id: 5, name: 'Loop B', parent_type_id: 4 }],
]);

test('the page\'s own mark is enough', () => {
  assert.equal(inDmOnlyCategory({ type_dm_only: true, entity_type_id: 2 }, types), true);
  assert.equal(inDmOnlyCategory({ type_dm_only: true }), true);
});

test('the category is enough when the mark is missing', () => {
  assert.equal(inDmOnlyCategory({ entity_type_id: 1 }, types), true);
  assert.equal(inDmOnlyCategory({ entity_type_id: 3 }, types), true);
});

test('other pages are not caught', () => {
  assert.equal(inDmOnlyCategory({ entity_type_id: 2 }, types), false);
  assert.equal(inDmOnlyCategory({ entity_type_id: 2, type_dm_only: false }, types), false);
  assert.equal(inDmOnlyCategory({ entity_type_id: 99 }, types), false);
  assert.equal(inDmOnlyCategory(null, types), false);
  assert.equal(inDmOnlyCategory({ entity_type_id: 2 }), false);
});

test('a loop in the categories ends', () => {
  assert.equal(inDmOnlyCategory({ entity_type_id: 4 }, types), false);
});
