#!/usr/bin/env node
/**
 * Chronicle claim -> Foundry actor ownership: the pure planner, the Members
 * tab flags, and ActorSync applying the plan (write options, GM-only, notices).
 *
 * Run: `node --test tools/test-claim-ownership-plan.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, notes } from './_journal-test-env.mjs';
import { planClaimOwnership } from '../scripts/_claim-ownership-plan.mjs';
import { buildMemberRows } from '../scripts/_member-mapping.mjs';

const users = ['gm', 'uA', 'uB'];
const base = { mappings: { cA: 'uA', cB: 'uB' }, foundryUserIds: users, gmUserIds: ['gm'] };
const nothing = { grantUserId: null, staleOwnerUserIds: [], unmapped: false };

test('planner', async (t) => {
  const cases = [
    ['new claim grants the mapped user', { ownership: { default: 0 }, chronicleOwnerId: 'cA' }, { ...nothing, grantUserId: 'uA' }],
    ['already OWNER is left alone', { ownership: { default: 0, uA: 3 }, chronicleOwnerId: 'cA' }, nothing],
    ['observer is raised to owner', { ownership: { default: 0, uA: 2 }, chronicleOwnerId: 'cA' }, { ...nothing, grantUserId: 'uA' }],
    ['default OWNER already covers them', { ownership: { default: 3 }, chronicleOwnerId: 'cA' }, nothing],
    ['unclaim changes nothing', { ownership: { default: 0, uA: 3 }, chronicleOwnerId: null, previousOwnerId: 'cA' }, nothing],
    ['reassignment grants B and reports A as still owner', { ownership: { default: 0, uA: 3 }, chronicleOwnerId: 'cB', previousOwnerId: 'cA' }, { ...nothing, grantUserId: 'uB', staleOwnerUserIds: ['uA'] }],
    ['reassignment does not report a previous owner who is not OWNER', { ownership: { default: 0, uA: 2 }, chronicleOwnerId: 'cB', previousOwnerId: 'cA' }, { ...nothing, grantUserId: 'uB' }],
    ['same owner again reports nothing stale', { ownership: { default: 0, uA: 3 }, chronicleOwnerId: 'cA', previousOwnerId: 'cA' }, nothing],
    ['unmapped claimant', { ownership: { default: 0 }, chronicleOwnerId: 'cZ' }, { ...nothing, unmapped: true }],
    ['mapping to a deleted Foundry user counts as unmapped', { ownership: {}, chronicleOwnerId: 'cA', mappings: { cA: 'gone' } }, { ...nothing, unmapped: true }],
    ['a GM claimant needs no grant', { ownership: {}, chronicleOwnerId: 'cG', mappings: { cG: 'gm' } }, nothing],
    ['no input is a no-op', {}, nothing],
  ];
  for (const [name, input, want] of cases) {
    await t.test(name, () => assert.deepEqual(planClaimOwnership({ ...base, ...input }), want));
  }
});

test('members rows flag a claimant with no Foundry user', () => {
  const members = [{ user_id: 'cA', display_name: 'Ann' }, { user_id: 'cZ', display_name: 'Zed' }, { user_id: 'cY', display_name: 'Yan' }];
  const out = buildMemberRows({
    members,
    mappings: { cA: 'uA' },
    foundryUsers: [{ id: 'uA', name: 'Ann' }],
    keyOf: (m) => m.user_id,
    claimantKeys: ['cA', 'cZ'],
  });
  assert.deepEqual(out.rows.map((r) => [r.key, r.claimsCharacter, r.claimUnmapped]), [['cA', true, false], ['cZ', true, true], ['cY', false, false]]);
  assert.equal(out.claimUnmappedCount, 1);
});

const { ActorSync } = await import('../scripts/actor-sync.mjs');

function fakeActor(ownership, flags = {}) {
  const calls = [];
  return {
    calls, name: 'Mira', type: 'hero', ownership,
    getFlag: (_s, k) => flags[k],
    update: async (data, opts) => { calls.push([data, opts]); },
  };
}

function setup({ isGM = true } = {}) {
  settings.userMappings = JSON.stringify({ cA: 'uA', cB: 'uB' });
  globalThis.game.user = { id: 'gm', isGM };
  const list = [{ id: 'gm', isGM: true, name: 'GM' }, { id: 'uA', isGM: false, name: 'Ann' }, { id: 'uB', isGM: false, name: 'Bo' }];
  globalThis.game.users = { contents: list, get: (id) => list.find((u) => u.id === id) };
  notes.warn.length = 0;
  return new ActorSync();
}

test('apply: grants OWNER with the sync echo options', async () => {
  const s = setup();
  const a = fakeActor({ default: 0 });
  await s._applyClaimOwnership(a, 'cA', null);
  assert.deepEqual(a.calls, [[{ ownership: { uA: 3 } }, { chronicleSync: true, chronicleSyncApply: true }]]);
  assert.deepEqual(notes.warn, []);
});

test('apply: reassignment grants B, keeps A, and warns once', async () => {
  const s = setup();
  const a = fakeActor({ default: 0, uA: 3 });
  await s._applyClaimOwnership(a, 'cB', 'cA');
  assert.deepEqual(a.calls.map((c) => c[0]), [{ ownership: { uB: 3 } }]);
  assert.equal(notes.warn.length, 1);
  assert.match(notes.warn[0], /PreviousOwnerKept.*Ann/);
});

test('apply: unmapped claimant changes nothing and warns once per session', async () => {
  const s = setup();
  const a = fakeActor({ default: 0 });
  await s._applyClaimOwnership(a, 'cZ', null);
  await s._applyClaimOwnership(a, 'cZ', null);
  assert.deepEqual(a.calls, []);
  assert.equal(notes.warn.length, 1);
});

test('apply: a non-GM client does nothing, and unclaim does nothing', async () => {
  let s = setup({ isGM: false });
  const a = fakeActor({ default: 0 });
  await s._applyClaimOwnership(a, 'cA', null);
  s = setup();
  await s._applyClaimOwnership(a, null, 'cA');
  assert.deepEqual(a.calls, []);
  assert.deepEqual(notes.warn, []);
});

test('reconcile: honours cached claims once and is idempotent', async () => {
  const s = setup();
  s._adapter = { actorType: 'hero' };
  const fresh = fakeActor({ default: 0 }, { entityId: 'e', chronicleOwnerUserId: 'cA' });
  const done = fakeActor({ default: 0, uB: 3 }, { entityId: 'e2', chronicleOwnerUserId: 'cB' });
  globalThis.game.actors = { contents: [fresh, done] };
  await s._reconcileClaimOwnership();
  assert.equal(fresh.calls.length, 1);
  assert.equal(done.calls.length, 0);
  assert.equal(s._syncing, false);
});
