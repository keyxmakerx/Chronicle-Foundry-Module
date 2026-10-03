#!/usr/bin/env node
/** isMapJournal: map journals are identified by page flag or Maps folder. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMapJournal } from '../scripts/_journal-ownership.mjs';

const S = 'chronicle-sync';
const flagged = (flags) => ({ getFlag: (_s, k) => flags[k] });

test('a journal with a mapId page is a map journal (pages as array or Collection)', () => {
  assert.equal(isMapJournal({ pages: [flagged({ mapId: 'm1' })] }, S), true);
  assert.equal(isMapJournal({ pages: { contents: [flagged({ mapId: 'm1' })] } }, S), true);
});

test('a journal inside the Maps folder, or a subfolder of it, is a map journal', () => {
  const maps = flagged({ isMapsFolder: true });
  assert.equal(isMapJournal({ pages: [], folder: maps }, S), true);
  assert.equal(isMapJournal({ pages: [], folder: { ...flagged({}), folder: maps } }, S), true);
});

test('an ordinary journal is not a map journal', () => {
  assert.equal(isMapJournal({ pages: [flagged({})], folder: flagged({}) }, S), false);
  assert.equal(isMapJournal(null, S), false);
});
