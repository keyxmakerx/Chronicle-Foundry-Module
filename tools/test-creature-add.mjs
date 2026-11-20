#!/usr/bin/env node
/**
 * "Add to Foundry" requests: which pages a run of feed rows asks for, and
 * that each request is acted on once. No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRequests, isNewAdd, recordAdd } from '../scripts/_creature-add.mjs';

test('the newest request per page, other feed rows ignored', () => {
  const got = addRequests([
    { seq: 4, type: 'creature_add', resourceId: 'a', op: 'created' },
    { seq: 5, type: 'entity', resourceId: 'a', op: 'updated' },
    { seq: 9, type: 'creature_add', resourceId: 'a', op: 'created' },
    { seq: 7, type: 'creature_add', resourceId: 'b', op: 'created' },
    { seq: 8, type: 'creature_add', op: 'created' },
  ]);
  assert.deepEqual([...got], [['a', 9], ['b', 7]]);
  assert.equal(addRequests(null).size, 0);
});

test('a request is acted on once; a later one acts again', () => {
  let handled = {};
  assert.equal(isNewAdd(handled, 'a', 9), true);
  handled = recordAdd(handled, 'a', 9);
  assert.equal(isNewAdd(handled, 'a', 9), false, 'the replay or live copy');
  assert.equal(isNewAdd(handled, 'a', 4), false, 'an older one');
  assert.equal(isNewAdd(handled, 'a', 12), true, 'pressed again');
  assert.equal(isNewAdd(handled, 'b', 3), true, 'another page');
});

test('a request with no seq always acts and is not recorded; no page never acts', () => {
  assert.equal(isNewAdd({ a: 9 }, 'a', undefined), true);
  assert.deepEqual(recordAdd({ a: 9 }, 'a', undefined), { a: 9 });
  assert.equal(isNewAdd({}, '', 3), false);
  assert.deepEqual(recordAdd(null, 'a', 2), { a: 2 });
  assert.deepEqual(recordAdd({ a: 5 }, 'a', 2), { a: 5 }, 'never moves back');
});
