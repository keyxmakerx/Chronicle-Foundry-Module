#!/usr/bin/env node
/**
 * Flag removals use Foundry 14's ForcedDeletion when it exists and the old
 * `-=key` form otherwise (scripts/_flag-removal.mjs), and a removal is
 * recognised in either form.
 *
 * Run: node --test tools/test-flag-removal.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { flagRemoval, removesKey } from '../scripts/_flag-removal.mjs';
import { changeTouchesPath } from '../scripts/_actor-field-diff.mjs';

class ForcedDeletion {}

test('without ForcedDeletion the old -= form is used', () => {
  delete globalThis.foundry;
  assert.deepEqual(flagRemoval('s', 'a', 'b'), { 'flags.s.-=a': null, 'flags.s.-=b': null });
});

test('with ForcedDeletion each key gets the operator', () => {
  globalThis.foundry = { data: { operators: { ForcedDeletion } } };
  try {
    const u = flagRemoval('s', 'a', 'b');
    assert.deepEqual(Object.keys(u), ['flags.s.a', 'flags.s.b']);
    assert.ok(u['flags.s.a'] instanceof ForcedDeletion);
    assert.notEqual(u['flags.s.a'], u['flags.s.b']);
  } finally {
    delete globalThis.foundry;
  }
});

test('a removal is recognised in either form', () => {
  assert.equal(removesKey({ '-=hp': null }, 'hp'), true);
  assert.equal(removesKey({ hp: 3 }, 'hp'), false);
  globalThis.foundry = { data: { operators: { ForcedDeletion } } };
  try {
    assert.equal(removesKey({ hp: new ForcedDeletion() }, 'hp'), true);
    assert.equal(changeTouchesPath({ system: { hp: new ForcedDeletion() } }, 'system.hp.value'), true);
  } finally {
    delete globalThis.foundry;
  }
  assert.equal(changeTouchesPath({ system: { '-=hp': null } }, 'system.hp.value'), true);
  assert.equal(changeTouchesPath({ system: { other: 1 } }, 'system.hp.value'), false);
});
