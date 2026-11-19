#!/usr/bin/env node
/** Which client sends a Foundry change to Chronicle (scripts/_change-author.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendsChange, memberOf, ownsCharacter, mayEditPage } from '../scripts/_change-author.mjs';

const gm = { id: 'gm1', isGM: true };
const gm2 = { id: 'gm2', isGM: true };
const player = { id: 'p1', isGM: false };
const users = (activeGM) => ({ get: (id) => [gm, gm2, player].find((u) => u.id === id) ?? null, activeGM });

test('a client sends its own user\'s changes', () => {
  assert.equal(sendsChange('gm1', { user: gm, users: users(gm2) }), true);
});

test('the active GM sends a player\'s changes; another GM does not', () => {
  assert.equal(sendsChange('p1', { user: gm, users: users(gm) }), true);
  assert.equal(sendsChange('p1', { user: gm2, users: users(gm) }), false);
});

test('another GM\'s changes are left to that GM\'s client', () => {
  assert.equal(sendsChange('gm2', { user: gm, users: users(gm) }), false);
});

test('a player\'s client, an unknown author and a missing world send nothing', () => {
  assert.equal(sendsChange('gm1', { user: player, users: users(gm) }), false);
  assert.equal(sendsChange('ghost', { user: gm, users: users(gm) }), false);
  assert.equal(sendsChange('', { user: gm, users: users(gm) }), false);
  assert.equal(sendsChange('p1', {}), false);
});

test('a player counts as a character\'s owner only through the member they are matched to', () => {
  const mappings = { m1: 'p1' };
  assert.equal(memberOf(mappings, 'p1'), 'm1');
  assert.equal(memberOf(mappings, 'p2'), null);
  assert.equal(ownsCharacter({ owner_user_id: 'm1' }, memberOf(mappings, 'p1')), true);
  assert.equal(ownsCharacter({ owner_user_id: 'm2' }, 'm1'), false);
  assert.equal(ownsCharacter({ owner_user_id: null }, null), false);
  assert.equal(ownsCharacter({}, 'm1'), false);
});

test('a page is the player\'s to edit only with an edit grant that covers them', () => {
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'user', subject_id: 'm1', permission: 'edit' }] }, 'm1'), true);
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'role', subject_id: '1', permission: 'edit' }] }, 'm1'), true);
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'public', permission: 'edit' }] }, 'm1'), true);
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'user', subject_id: 'm1', permission: 'view' }] }, 'm1'), false);
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'role', subject_id: '2', permission: 'edit' }] }, 'm1'), false);
  assert.equal(mayEditPage({ visibility: 'custom', permissions: [{ subject_type: 'public', permission: 'edit' }] }, null), false);
  assert.equal(mayEditPage({ visibility: 'default', permissions: [{ subject_type: 'public', permission: 'edit' }] }, 'm1'), false);
  assert.equal(mayEditPage(undefined, 'm1'), false);
});
