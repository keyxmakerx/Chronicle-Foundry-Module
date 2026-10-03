#!/usr/bin/env node
/**
 * What Chronicle removed is set aside in Foundry, never deleted
 * (scripts/_set-aside.mjs): the journal loses every flag that links it to
 * Chronicle and moves into one "Chronicle: removed" folder, made once even
 * when many removals arrive together. Also pins that the sync files no
 * longer delete journals for Chronicle-side removals.
 *
 * Run: node --test tools/test-set-aside.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setAsideUpdate, removedFolder, setAside, LINK_FLAGS, REMOVED_FOLDER_FLAG } from '../scripts/_set-aside.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'chronicle-sync';

test('the update unlinks the journal and files it in the folder', () => {
  const u = setAsideUpdate(SCOPE, 'fold-1');
  assert.equal(u.folder, 'fold-1');
  for (const key of ['entityId', 'noteId', 'isNote', 'lastSync']) {
    assert.ok(Object.prototype.hasOwnProperty.call(u, `flags.${SCOPE}.-=${key}`), `${key} must be removed`);
  }
  assert.equal(Object.keys(u).length, 1 + LINK_FLAGS.length);
});

function stubFoundry() {
  const folders = [], created = [];
  globalThis.game = {
    i18n: { localize: (k) => k, format: (k) => k },
    folders: { find: (fn) => folders.find(fn) },
  };
  globalThis.Folder = {
    create: async (data) => {
      created.push(data);
      await new Promise((r) => setTimeout(r, 5));
      const f = { id: 'fold-' + created.length, type: data.type, getFlag: (scope, key) => data.flags?.[scope]?.[key] };
      folders.push(f);
      return f;
    },
  };
  return { folders, created };
}

test('a burst of removals makes one folder', async () => {
  const { created } = stubFoundry();
  const [a, b, c] = await Promise.all([removedFolder(SCOPE), removedFolder(SCOPE), removedFolder(SCOPE)]);
  assert.equal(created.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(created[0].flags[SCOPE][REMOVED_FOLDER_FLAG], true);
  // Found again afterwards, by its flag, not made twice.
  await removedFolder(SCOPE);
  assert.equal(created.length, 1);
});

test('setAside moves the journal instead of deleting it', async () => {
  stubFoundry();
  const calls = [];
  const journal = { update: async (u) => { calls.push(['update', u]); }, delete: async () => { calls.push(['delete']); } };
  await setAside(journal, SCOPE);
  assert.deepEqual(calls.map((c) => c[0]), ['update']);
  assert.ok(calls[0][1].folder, 'moved into the removed folder');
});

test('the sync files set journals aside rather than deleting them', () => {
  const src = (f) => readFileSync(resolve(REPO_ROOT, 'scripts', f), 'utf8');
  const journal = src('journal-sync.mjs'), note = src('note-sync.mjs');
  assert.doesNotMatch(journal, /journal\.delete\(\)/, 'journal-sync must not delete journals');
  assert.doesNotMatch(note, /journal\.delete\(\)/, 'note-sync must not delete journals');
  assert.match(journal, /setAside\(journal, FLAG_SCOPE(, SYNC_OPTIONS)?\)/);
  assert.match(note, /setAside\(journal, FLAG_SCOPE\)/);
});
