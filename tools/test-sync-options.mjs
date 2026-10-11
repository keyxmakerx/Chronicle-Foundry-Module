#!/usr/bin/env node
/**
 * Foundry 14 writes into the options object a document write is given
 * (`parent`, among others). Sync's write options must therefore be a fresh,
 * extensible object per write: a frozen one throws "Cannot add property
 * parent, object is not extensible", and a shared one carries one write's
 * `parent` into the next.
 *
 * Run: node --test tools/test-sync-options.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { syncOptions } from '../scripts/constants.mjs';
import { setAside, REMOVED_FOLDER_FLAG } from '../scripts/_set-aside.mjs';
import { retireNotesFolder } from '../scripts/_notes-folder.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'chronicle-sync';

/** A document whose update writes into its options, as Foundry 14's does. */
function foundryDoc(fields = {}) {
  const seen = [];
  return {
    ...fields,
    seen,
    getFlag: (scope, key) => fields.flags?.[scope]?.[key],
    async update(data, operation = {}) {
      operation.parent = null;
      seen.push(operation);
      return this;
    },
  };
}

test('syncOptions gives a fresh, writable, marked object each call', () => {
  const a = syncOptions();
  const b = syncOptions();
  assert.notEqual(a, b);
  assert.equal(Object.isExtensible(a), true);
  assert.equal(a.chronicleSync, true);
  a.parent = 'x';
  assert.equal(syncOptions().parent, undefined);
  assert.deepEqual(syncOptions({ extra: 1 }), { chronicleSync: true, extra: 1 });
});

test('setAside copies the options it is given before writing', async () => {
  const folder = { id: 'removed', getFlag: () => true, type: 'JournalEntry' };
  globalThis.game = { folders: { find: (fn) => [folder].find(fn) }, i18n: { localize: (k) => k } };
  const journal = foundryDoc();
  const options = Object.freeze(syncOptions());
  await setAside(journal, SCOPE, options);
  assert.equal(journal.seen.length, 1);
  assert.notEqual(journal.seen[0], options);
  assert.equal(journal.seen[0].chronicleSync, true);
});

test('retireNotesFolder copies the options into every write', async () => {
  const removed = { id: 'removed', type: 'JournalEntry', folder: null, getFlag: (s, k) => k === REMOVED_FOLDER_FLAG };
  const root = foundryDoc({ id: 'root', type: 'JournalEntry', folder: null, flags: { [SCOPE]: { isNotesRoot: true } } });
  const notes = [1, 2].map((i) => foundryDoc({ id: `n${i}`, folder: root, flags: { [SCOPE]: { noteId: `note-${i}`, isNote: true } } }));
  const game = { folders: [root, removed], journal: { contents: notes } };
  const options = Object.freeze(syncOptions());
  await retireNotesFolder({ game, scope: SCOPE, removedFolder: async () => removed, options });
  const writes = [...notes, root].flatMap((d) => d.seen);
  assert.ok(writes.length >= 3, 'every note and the root folder are written');
  assert.equal(new Set(writes).size, writes.length, 'no two writes share an options object');
  for (const w of writes) assert.equal(w.chronicleSync, true);
});

test('no script hands a document write a frozen or shared options constant', () => {
  const dir = resolve(REPO_ROOT, 'scripts');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const src = readFileSync(resolve(dir, f), 'utf8');
    assert.doesNotMatch(src, /\bSYNC_OPTIONS\b/, `${f}: use syncOptions()`);
    assert.doesNotMatch(src, /Object\.freeze\(\s*(\{[^}]*chronicleSync|syncOptions)/, `${f}: write options must not be frozen`);
  }
});
