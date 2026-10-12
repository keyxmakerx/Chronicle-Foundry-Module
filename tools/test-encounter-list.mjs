#!/usr/bin/env node
/**
 * Pins scripts/_encounter-list.mjs: the Encounters list reads Chronicle's
 * GET /encounters answer defensively and asks for it the way the contract
 * says (q and limit, ready ones first as Chronicle sends them).
 *
 * Run: `node --test tools/test-encounter-list.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_LIMIT, encounterErrorKey, encounterPath, listPath, readyFirst, unwrapEncounterList,
} from '../scripts/_encounter-list.mjs';

test('the list path carries a trimmed, encoded search and a clamped limit', () => {
  assert.equal(listPath(), `/encounters?limit=${LIST_LIMIT}`);
  assert.equal(listPath('  '), `/encounters?limit=${LIST_LIMIT}`);
  assert.equal(listPath(' hob & goblin ', 20), '/encounters?q=hob%20%26%20goblin&limit=20');
  assert.equal(listPath('x', 500), '/encounters?q=x&limit=100');
  assert.equal(listPath('x', 0), '/encounters?q=x&limit=1');
  assert.equal(listPath('x', NaN), `/encounters?q=x&limit=${LIST_LIMIT}`);
});

test('one encounter path encodes the id', () => {
  assert.equal(encounterPath('abc/def'), '/encounters/abc%2Fdef');
});

const row = { id: 'e1', page: { id: 'p1', name: 'The Siege' }, name: 'Ramparts fight', ready: true, creatureCount: 7, updatedAt: '2026-10-01T00:00:00Z' };

test('the envelope, a bare array and junk all unwrap', () => {
  const env = unwrapEncounterList({ data: [row], total: 41 });
  assert.equal(env.total, 41);
  assert.deepEqual(env.items[0], { id: 'e1', name: 'Ramparts fight', pageName: 'The Siege', ready: true, creatureCount: 7, updatedAt: '2026-10-01T00:00:00Z' });
  assert.equal(unwrapEncounterList([row]).items.length, 1);
  for (const junk of [null, undefined, 'x', 3, {}, { data: 'no' }]) {
    assert.deepEqual(unwrapEncounterList(junk), { items: [], total: 0 });
  }
});

test('rows without an id are dropped and missing fields fall back', () => {
  const { items, total } = unwrapEncounterList({ data: [{ name: 'no id' }, null, { id: 'e2', page: { name: 'Trial 2' } }] });
  assert.equal(items.length, 1);
  assert.equal(total, 1);
  assert.deepEqual(items[0], { id: 'e2', name: 'Trial 2', pageName: 'Trial 2', ready: false, creatureCount: 0, updatedAt: '' });
});

test('a total smaller than the rows in hand never hides rows', () => {
  assert.equal(unwrapEncounterList({ data: [row, { ...row, id: 'e2' }], total: 1 }).total, 2);
});

test('ready fights stay first and order is otherwise kept', () => {
  const items = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, ready: i % 2 === 1 }));
  assert.deepEqual(readyFirst(items).map((i) => i.id), ['b', 'd', 'a', 'c']);
});

test('failed requests map to the lang keys', () => {
  assert.equal(encounterErrorKey({ status: 404 }), 'NeedsUpdate');
  assert.equal(encounterErrorKey({ status: 401 }), 'BadKey');
  assert.equal(encounterErrorKey({ status: 403 }), 'NotAllowed');
  assert.equal(encounterErrorKey({ status: 500 }), 'Failed');
  assert.equal(encounterErrorKey(null), 'Failed');
});
