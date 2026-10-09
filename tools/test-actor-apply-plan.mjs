#!/usr/bin/env node
/**
 * The diff that decides which mapped fields a Chronicle edit writes to an
 * actor, and the wiring that keeps the write from echoing back.
 *
 * Run: `node --test tools/test-actor-apply-plan.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planActorApply, sameValue, readPath } from '../scripts/_actor-apply-plan.mjs';

const actor = {
  name: 'Brann',
  system: { stamina: { value: 20, max: 30 }, hero: { primary: { value: 3 } }, notes: 'hi' },
};

test('planActorApply', async (t) => {
  const cases = [
    ['echo of the current values writes nothing', { 'system.stamina.value': 20, name: 'Brann' }, {}],
    ['one changed field writes only that field', { 'system.stamina.value': 14, 'system.stamina.max': 30 }, { 'system.stamina.value': 14 }],
    ['a numeric string equal to the number is not a change', { 'system.stamina.value': '20' }, {}],
    ['a numeric string that differs is a change', { 'system.stamina.value': '19' }, { 'system.stamina.value': '19' }],
    ['nested foundry_path', { 'system.hero.primary.value': 4 }, { 'system.hero.primary.value': 4 }],
    ['a path the actor lacks is written', { 'system.hero.surges': 2 }, { 'system.hero.surges': 2 }],
    ['renamed', { name: 'Brann the Bold' }, { name: 'Brann the Bold' }],
    ['text compares as text', { 'system.notes': 'hi' }, {}],
    ['an empty update', {}, {}],
    ['a missing update', undefined, {}],
  ];
  for (const [name, update, want] of cases) {
    await t.test(name, () => assert.deepEqual(planActorApply({ update, actor }), want));
  }
});

test('only mapped keys are considered: an unmapped actor value is never touched', () => {
  assert.deepEqual(planActorApply({ update: { 'system.stamina.value': 20 }, actor }), {});
});

test('sameValue', () => {
  assert.equal(sameValue(5, '5'), true);
  assert.equal(sameValue('5', 5), true);
  assert.equal(sameValue('abc', 'abd'), false);
  assert.equal(sameValue('', 0), false);
  assert.equal(sameValue(null, undefined), false);
  assert.equal(sameValue({ a: 1 }, { a: 1 }), true);
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false);
  assert.equal(sameValue(['a'], ['a']), true);
  assert.equal(readPath(actor, 'system.stamina.value'), 20);
  assert.equal(readPath(actor, 'system.x.y'), undefined);
});

test('ActorSync applies through the plan, with the apply option', () => {
  const src = readFileSync(new URL('../scripts/actor-sync.mjs', import.meta.url), 'utf8');
  const apply = src.slice(src.indexOf('async _updateActorFromEntity'), src.indexOf('async _onCharacterDeleted'));
  // A stale copy still returns before anything is planned or written.
  assert.ok(apply.indexOf('_olderThanRecorded') < apply.indexOf('planActorApply'));
  assert.match(apply, /actor\.update\(changes, \{ \.\.\.SYNC_OPTIONS, \[APPLY_OPTION\]: true \}\)/);
  assert.match(src, /if \(this\._syncing \|\| options\?\.\[APPLY_OPTION\]\) return;/);
});
