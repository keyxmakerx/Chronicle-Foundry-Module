#!/usr/bin/env node
/**
 * Page text lives in embedded pages, whose edits fire page hooks and never
 * updateJournalEntry; they must push the journal like any other edit, and
 * sync's own page writes must not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');
const { SYNC_OPTIONS } = await import('../scripts/constants.mjs');

function make() {
  const js = new JournalSync();
  js._isHandledByNoteSync = () => false;
  const scheduled = [];
  js._journalPushDebouncer = { schedule: (id) => scheduled.push(id), flush() {}, flushAll() {} };
  return { js, scheduled };
}

test('a GM page edit on a linked journal schedules a push of that journal', () => {
  const { js, scheduled } = make();
  const journal = makeJournal({ id: 'j1', flags: { entityId: 'e1' } });
  js._onPageUpdate({ parent: journal }, { text: { content: 'x' } }, {}, 'gm');
  js._onPageChange({ parent: journal }, {}, 'gm');
  assert.deepEqual(scheduled, ['j1', 'j1']);
});

test('sync writes, other users and unlinked journals do not push', () => {
  const { js, scheduled } = make();
  const linked = makeJournal({ id: 'j1', flags: { entityId: 'e1' } });
  js._onPageUpdate({ parent: linked }, {}, { ...SYNC_OPTIONS }, 'gm');
  js._onPageUpdate({ parent: linked }, {}, {}, 'someone-else');
  js._onPageUpdate({ parent: makeJournal({ id: 'j2' }) }, {}, {}, 'gm');
  js._onPageChange({}, {}, 'gm');
  assert.deepEqual(scheduled, []);
});
