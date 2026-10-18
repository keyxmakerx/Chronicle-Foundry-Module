#!/usr/bin/env node
/** A text push carries name and privacy only when the edit changed them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeJournalChange, changedJournalFields } from '../scripts/_journal-push-fields.mjs';

test('a page or text edit changes neither name nor privacy', () => {
  const pending = mergeJournalChange(undefined, {});
  assert.deepEqual(changedJournalFields({ name: 'A', isPrivate: true }, pending), {});
  assert.deepEqual(changedJournalFields({ name: 'A', isPrivate: false }, mergeJournalChange(undefined)), {});
});

test('a rename sends the name only; an ownership edit sends is_private only', () => {
  assert.deepEqual(changedJournalFields({ name: 'B', isPrivate: true }, mergeJournalChange(undefined, { name: 'B' })), { name: 'B' });
  assert.deepEqual(changedJournalFields({ name: 'B', isPrivate: true }, mergeJournalChange(undefined, { ownership: { default: 0 } })), { is_private: true });
});

test('changes accumulate across a debounce burst', () => {
  let p = mergeJournalChange(undefined, { name: 'B' });
  p = mergeJournalChange(p, {});
  p = mergeJournalChange(p, { ownership: { default: 2 } });
  assert.deepEqual(changedJournalFields({ name: 'B', isPrivate: false }, p), { name: 'B', is_private: false });
});
