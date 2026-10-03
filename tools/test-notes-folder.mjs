#!/usr/bin/env node
/** Pins how the old Chronicle Notes folder is set aside (scripts/_notes-folder.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOldNotesJournal, retireNotesFolder, unlinkNoteUpdate } from '../scripts/_notes-folder.mjs';

const SCOPE = 'chronicle-sync';

/** A tiny world: folders and journals with flags, recording every update. */
function world() {
  const writes = [];
  const folders = [];
  const journals = [];
  const doc = (kind, data) => {
    const d = {
      id: data.id, name: data.name, type: 'JournalEntry', flags: { ...(data.flags || {}) }, _folder: data.folder || null,
      get folder() { return folders.find((f) => f.id === this._folder) || null; },
      getFlag(scope, key) { return scope === SCOPE ? this.flags[key] : undefined; },
      async update(change, options) {
        writes.push({ kind, id: this.id, change, options });
        for (const [k, v] of Object.entries(change)) {
          if (k === 'folder') this._folder = v;
          const m = k.match(/^flags\.[^.]+\.(-=)?(.+)$/);
          if (m && m[1]) delete this.flags[m[2]];
          else if (m) this.flags[m[2]] = v;
        }
        return this;
      },
    };
    (kind === 'folder' ? folders : journals).push(d);
    return d;
  };
  let made = 0;
  const removedFolder = async () => folders.find((f) => f.flags.removedFolder)
    || (made += 1, doc('folder', { id: 'removed', name: 'Chronicle: removed', flags: { removedFolder: true } }));
  const game = { folders: { filter: (fn) => folders.filter(fn) }, journal: { contents: journals } };
  return { writes, folders, journals, doc, game, removedFolder, made: () => made };
}

function oldNotesWorld() {
  const w = world();
  w.doc('folder', { id: 'root', name: 'Chronicle Notes', flags: { isNotesRoot: true } });
  w.doc('folder', { id: 'sub', name: 'Session notes', folder: 'root', flags: { noteFolderId: 'nf1' } });
  w.doc('folder', { id: 'mine', name: 'GM stuff' });
  w.doc('journal', { id: 'n1', name: 'Lady Vess', folder: 'root', flags: { noteId: 'note-1', isNote: true, lastSync: 'x' } });
  w.doc('journal', { id: 'n2', name: 'Session 3', folder: 'sub', flags: { noteId: 'note-2', isNote: true } });
  // A note copy the GM moved out of the folder.
  w.doc('journal', { id: 'n3', name: 'Moved note', folder: 'mine', flags: { noteId: 'note-3', isNote: true } });
  // A GM journal the old sync never pushed, inside the folder.
  w.doc('journal', { id: 'g1', name: 'Scratch', folder: 'sub' });
  // An ordinary world page: never touched.
  w.doc('journal', { id: 'e1', name: 'Harbor', flags: { entityId: 'ent-1' } });
  return w;
}

test('every note copy is unlinked and marked, and the folder is set aside', async () => {
  const w = oldNotesWorld();
  const r = await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder, options: { chronicleSync: true } });
  assert.deepEqual(r, { unlinked: 4, moved: 1 });
  for (const id of ['n1', 'n2', 'n3', 'g1']) {
    const j = w.journals.find((x) => x.id === id);
    assert.equal(j.flags.oldNote, true, id);
    assert.equal(j.flags.noteId, undefined, id);
    assert.equal(j.flags.isNote, undefined, id);
  }
  const root = w.folders.find((f) => f.id === 'root');
  assert.equal(root._folder, 'removed', 'the tree moved into the removed folder');
  assert.equal(root.flags.isNotesRoot, true, 'the root keeps its flag, so JournalSync keeps skipping it');
  assert.equal(w.journals.find((x) => x.id === 'n3')._folder, 'mine', 'a journal the GM moved stays where they put it');
  assert.deepEqual(w.journals.find((x) => x.id === 'e1').flags, { entityId: 'ent-1' }, 'world pages untouched');
  assert.ok(w.writes.every((x) => x.options?.chronicleSync), 'every write carries the sync marker');
});

test('running it again writes nothing', async () => {
  const w = oldNotesWorld();
  await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder });
  const before = w.writes.length;
  const r = await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder });
  assert.deepEqual(r, { unlinked: 0, moved: 0 });
  assert.equal(w.writes.length, before);
  assert.equal(w.made(), 1, 'one removed folder');
});

test('a world without old notes makes no writes and no removed folder', async () => {
  const w = world();
  w.doc('journal', { id: 'e1', name: 'Harbor', flags: { entityId: 'ent-1' } });
  const r = await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder });
  assert.deepEqual(r, { unlinked: 0, moved: 0 });
  assert.equal(w.writes.length, 0);
  assert.equal(w.made(), 0);
});

test('a tree too deep for Foundry stays where it is, unlinked', async () => {
  const w = oldNotesWorld();
  w.doc('folder', { id: 'deep1', name: 'a', folder: 'sub' });
  w.doc('folder', { id: 'deep2', name: 'b', folder: 'deep1' });
  const r = await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder, maxDepth: 4 });
  assert.equal(r.moved, 0);
  assert.equal(w.folders.find((f) => f.id === 'root')._folder, null);
  assert.equal(w.made(), 0, 'no empty removed folder made for nothing');
  assert.equal(w.journals.find((x) => x.id === 'n2').flags.oldNote, true);
});

test('a notes folder the GM filed somewhere else is not moved', async () => {
  const w = oldNotesWorld();
  w.folders.find((f) => f.id === 'root')._folder = 'mine';
  const r = await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder });
  assert.equal(r.moved, 0);
  assert.equal(w.folders.find((f) => f.id === 'root')._folder, 'mine');
});

test('isOldNotesJournal: marked, legacy-flagged, or anywhere under the notes root', async () => {
  const w = oldNotesWorld();
  const j = (id) => w.journals.find((x) => x.id === id);
  assert.equal(isOldNotesJournal(j('n2'), SCOPE), true, 'legacy flag, in a subfolder');
  assert.equal(isOldNotesJournal(j('g1'), SCOPE), true, 'GM journal under the root');
  assert.equal(isOldNotesJournal(j('n3'), SCOPE), true, 'moved out, still flagged');
  assert.equal(isOldNotesJournal(j('e1'), SCOPE), false);
  await retireNotesFolder({ game: w.game, scope: SCOPE, removedFolder: w.removedFolder });
  assert.equal(isOldNotesJournal(j('n3'), SCOPE), true, 'moved out, now marked old');
  assert.equal(isOldNotesJournal(j('g1'), SCOPE), true, 'still under the root after the move');
  assert.equal(isOldNotesJournal(j('e1'), SCOPE), false);
  assert.equal(isOldNotesJournal(null, SCOPE), false);
});

test('unlinkNoteUpdate strips every link flag', () => {
  const j = { flags: { noteId: 'n', isNote: true, entityId: 'stale' }, getFlag(_s, k) { return this.flags[k]; } };
  const u = unlinkNoteUpdate(j, SCOPE);
  assert.equal(u[`flags.${SCOPE}.oldNote`], true);
  for (const k of ['noteId', 'isNote', 'entityId']) assert.ok(`flags.${SCOPE}.-=${k}` in u, k);
});
