/**
 * Pins _member-match.mjs: a member is linked to a Foundry user without the GM
 * only on evidence that names one user, and never to a user someone else has.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looseName, planMemberMatches } from '../scripts/_member-match.mjs';
import { memberKey } from '../scripts/_member-mapping.mjs';

const m = (id, name, extra = {}) => ({ user_id: id, display_name: name, ...extra });
const u = (id, name, isGM = false) => ({ id, name, isGM });
const plan = (p) => planMemberMatches({ keyOf: memberKey, mappings: {}, ...p });

test('looseName ignores case, spacing, punctuation and accents', () => {
  for (const n of ['Key Maker', 'keymaker', 'KEY-MAKER', 'Kéy_Maker', ' key  maker ']) assert.equal(looseName(n), 'keymaker');
  assert.equal(looseName(null), '');
});

test('the same name, ignoring case, links as before', () => {
  const r = plan({ members: [m('c1', 'Dana')], users: [u('f1', 'dana')] });
  assert.deepEqual(r.add, { c1: 'f1' });
  assert.equal(r.how.c1, 'name');
  assert.deepEqual(r.unmatched, []);
});

test('a name that differs only in spacing or punctuation links when unique on both sides', () => {
  const r = plan({ members: [m('c1', 'Key Maker'), m('c2', 'Rin')], users: [u('f1', 'keymaker'), u('f2', 'Someone')] });
  assert.deepEqual(r.add, { c1: 'f1' });
  assert.equal(r.how.c1, 'loose');
  assert.deepEqual(r.unmatched.map((x) => x.user_id), ['c2']);
});

test('an ambiguous name links nobody', () => {
  const twoUsers = plan({ members: [m('c1', 'Sam')], users: [u('f1', 'Sam'), u('f2', 'sam')] });
  assert.deepEqual(twoUsers.add, {});
  const twoMembers = plan({ members: [m('c1', 'Sam'), m('c2', 'S.A.M.')], users: [u('f1', 'sam')] });
  // "Sam" is unique by case but not loosely; the exact match still holds for c1 only.
  assert.deepEqual(twoMembers.add, { c1: 'f1' });
  assert.deepEqual(twoMembers.unmatched.map((x) => x.user_id), ['c2']);
});

test('the GM\'s own setup links a member whose name matches nobody', () => {
  const r = plan({
    members: [m('c1', 'Theodora')],
    users: [u('f1', 'Teddy'), u('f2', 'Other')],
    evidence: new Map([['c1', new Set(['f1'])]]),
  });
  assert.deepEqual(r.add, { c1: 'f1' });
  assert.equal(r.how.c1, 'setup');
});

test('setup evidence naming two players, or only a GM, links nobody', () => {
  const two = plan({ members: [m('c1', 'X')], users: [u('f1', 'A'), u('f2', 'B')], evidence: { c1: ['f1', 'f2'] } });
  assert.deepEqual(two.add, {});
  const gm = plan({ members: [m('c1', 'X')], users: [u('g', 'GM', true)], evidence: { c1: ['g'] } });
  assert.deepEqual(gm.add, {});
});

test('setup evidence wins over another member\'s name match for the same Foundry user', () => {
  const r = plan({
    members: [m('c1', 'Pat'), m('c2', 'Alex')],
    users: [u('f1', 'Pat')],
    evidence: { c2: ['f1'] },
  });
  assert.deepEqual(r.add, { c2: 'f1' });
  assert.deepEqual(r.unmatched.map((x) => x.user_id), ['c1']);
});

test('a Foundry user already linked to someone is never offered again', () => {
  const r = plan({ members: [m('c1', 'Lee'), m('c2', 'Lee B')], users: [u('f1', 'Lee')], mappings: { c2: 'f1' } });
  assert.deepEqual(r.add, {});
  assert.deepEqual(r.unmatched.map((x) => x.user_id), ['c1']);
});

test('a live link is kept; a link to a deleted Foundry user may be matched again', () => {
  const live = plan({ members: [m('c1', 'Ana')], users: [u('f1', 'Ana'), u('f9', 'Elsewhere')], mappings: { c1: 'f9' } });
  assert.deepEqual(live.add, {});
  assert.deepEqual(live.unmatched, []);
  const dead = plan({ members: [m('c1', 'Ana')], users: [u('f1', 'Ana')], mappings: { c1: 'gone' } });
  assert.deepEqual(dead.add, { c1: 'f1' });
});
