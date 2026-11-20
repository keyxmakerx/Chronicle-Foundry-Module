#!/usr/bin/env node
/** What a player's push names and what Chronicle holds back (scripts/_player-picks-held.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { actingMemberOf, heldKeysOf, describeHeld, HeldNotices } from '../scripts/_player-picks-held.mjs';

const mappings = { m1: 'fp1', m2: 'fp2' };
const memberFor = (id) => Object.entries(mappings).find(([, f]) => f === id)?.[0] ?? null;

test('a player burst is made for the member the player is matched to', () => {
  assert.equal(actingMemberOf(new Set(['fp2']), memberFor), 'm2');
});

test('a GM-only burst, or an unmatched player, names nobody', () => {
  assert.equal(actingMemberOf(undefined, memberFor), null);
  assert.equal(actingMemberOf(new Set(), memberFor), null);
  assert.equal(actingMemberOf(new Set(['stranger']), memberFor), null);
});

test('held keys are read from the answer, in key order', () => {
  const held = heldKeysOf({ status: 'ok', held: [{ key: 'kit', reason: 'b' }, { key: 'class', reason: 'a' }, { nope: 1 }, null] });
  assert.deepEqual(held, [{ key: 'class', reason: 'a' }, { key: 'kit', reason: 'b' }]);
});

test('an older Chronicle, or an answer with nothing held, holds nothing', () => {
  for (const answer of [undefined, null, {}, { status: 'ok' }, { held: 'x' }, { held: [] }]) {
    assert.deepEqual(heldKeysOf(answer), []);
  }
});

test('the GM reads Chronicle\'s own reasons', () => {
  assert.equal(
    describeHeld([{ key: 'class', reason: '"Wizard" is not on the class list' }, { key: 'kit', reason: '' }]),
    '"Wizard" is not on the class list; "kit" can\'t be changed here',
  );
});

test('the same refusal is told once per actor; a different one, or a clean push then the same again, is told', () => {
  const n = new HeldNotices();
  const a = [{ key: 'class', reason: 'x' }];
  assert.equal(n.shouldTell('act1', a), true);
  assert.equal(n.shouldTell('act1', a), false);
  assert.equal(n.shouldTell('act2', a), true);
  assert.equal(n.shouldTell('act1', [{ key: 'class', reason: 'y' }]), true);
  assert.equal(n.shouldTell('act1', []), false);
  assert.equal(n.shouldTell('act1', [{ key: 'class', reason: 'y' }]), true);
});
