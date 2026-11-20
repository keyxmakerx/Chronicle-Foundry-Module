#!/usr/bin/env node
/** Linking a player by a Chronicle code (scripts/_link-code.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, linkMappings, isLinked, offersLink, outcomeKey } from '../scripts/_link-code.mjs';

test('a code is typed loosely but must be six characters of the alphabet', () => {
  assert.equal(cleanCode(' k7q-2mx '), 'K7Q2MX');
  assert.equal(cleanCode('K7Q 2MX'), 'K7Q2MX');
  assert.equal(cleanCode('K7Q2M'), null, 'too short');
  assert.equal(cleanCode('K7Q2MXX'), null, 'too long');
  assert.equal(cleanCode('K0Q2MX'), null, '0 is not in the alphabet');
  assert.equal(cleanCode(null), null);
});

test('linking replaces the member\'s old link and frees the Foundry user from anyone else', () => {
  const before = { mira: 'fOld', ann: 'fMira', bo: 'fBo' };
  assert.deepEqual(linkMappings(before, 'mira', 'fMira'), { bo: 'fBo', mira: 'fMira' });
  assert.deepEqual(linkMappings({}, 'mira', 'f1'), { mira: 'f1' });
  assert.deepEqual(linkMappings(null, 'mira', 'f1'), { mira: 'f1' });
});

test('the window opens by itself only for an unlinked player of a connected world who has not said Not now', () => {
  const base = { isGM: false, connected: true, linked: false, dismissed: false };
  assert.equal(offersLink(base), true);
  assert.equal(offersLink({ ...base, isGM: true }), false);
  assert.equal(offersLink({ ...base, connected: false }), false);
  assert.equal(offersLink({ ...base, linked: true }), false);
  assert.equal(offersLink({ ...base, dismissed: true }), false);
  assert.equal(isLinked({ a: 'f1' }, 'f1'), true);
  assert.equal(isLinked({ a: 'f1' }, 'f2'), false);
});

test('each outcome has its own words', () => {
  assert.deepEqual([200, 404, 429, 504, 502, 403].map(outcomeKey), ['Linked', 'WrongCode', 'TooMany', 'NoGM', 'Failed', 'Failed']);
});
