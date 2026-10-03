#!/usr/bin/env node
/**
 * The old "Chronicle Notes" folder after the player notebook replaced note
 * sync: a world that still has it opens, and reopens, with no duplicates and
 * no Chronicle writes, and nothing in the folder ever becomes a page. Loading
 * the world runs the same set-aside step `module.mjs` runs on ready.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedCampaign } from './chronicle.mjs';
import { newWorld, openWorld, closeWorld, settle, traffic, recordRequests } from './world.mjs';
import { retireNotesFolder } from '../scripts/_notes-folder.mjs';
import { removedFolder } from '../scripts/_set-aside.mjs';
import { SYNC_OPTIONS } from '../scripts/constants.mjs';

const FLAG = 'chronicle-sync';
const writes = (reqs) => reqs.filter((r) => r.method !== 'GET');

/** What the retired note sync left in a world: a folder tree of note copies. */
async function oldNotesFolder() {
  const root = await Folder.create({ name: 'Chronicle Notes', type: 'JournalEntry', flags: { [FLAG]: { isNotesRoot: true } } }, SYNC_OPTIONS);
  const sub = await Folder.create({ name: 'Session notes', type: 'JournalEntry', folder: root.id, flags: { [FLAG]: { noteFolderId: 'nf-1' } } }, SYNC_OPTIONS);
  const page = (t) => [{ name: 'Content', type: 'text', text: { content: `<p>${t}</p>` } }];
  await JournalEntry.create({ name: 'Lady Vess', folder: root.id, pages: page('Runs the guild.'), flags: { [FLAG]: { noteId: 'old-note-1', isNote: true } } }, SYNC_OPTIONS);
  await JournalEntry.create({ name: 'Session 3', folder: sub.id, pages: page('We met Corrin.'), flags: { [FLAG]: { noteId: 'old-note-2', isNote: true } } }, SYNC_OPTIONS);
  return root;
}

/** The GM loads the world: the set-aside step, then sync. */
async function load(world) {
  await retireNotesFolder({ game, scope: FLAG, removedFolder, maxDepth: 4, options: SYNC_OPTIONS });
  await openWorld(world);
}

test('a world with the old Chronicle Notes folder opens and reopens with no duplicates and no Chronicle writes', async () => {
  const seed = await seedCampaign('old-notes');
  const world = newWorld(seed);
  const since = traffic.requests.length;
  try {
    const root = await oldNotesFolder();
    const firstOpen = await recordRequests(() => load(world));
    assert.deepEqual(writes(firstOpen).map((r) => `${r.method} ${r.url}`), [], 'first open writes nothing to Chronicle');

    const notes = game.journal.contents.filter((j) => j.getFlag(FLAG, 'oldNote'));
    assert.equal(notes.length, 2, 'both note copies kept');
    assert.ok(notes.every((j) => !j.getFlag(FLAG, 'noteId') && !j.getFlag(FLAG, 'entityId')), 'unlinked');
    assert.ok(root.folder?.getFlag(FLAG, 'removedFolder'), 'the folder is set aside in "Chronicle: removed"');

    // The GM keeps writing in the set-aside folder: none of it reaches Chronicle.
    const gmWork = await recordRequests(async () => {
      await notes[0].update({ name: 'Lady Vess (old)' });
      await JournalEntry.create({ name: 'New scratch', folder: root.id, pages: [{ name: 'x', type: 'text', text: { content: '<p>x</p>' } }] });
      await settle();
    });
    assert.deepEqual(writes(gmWork).map((r) => `${r.method} ${r.url}`), [], 'edits in the old folder stay in Foundry');

    await closeWorld(world);
    const reopen = await recordRequests(() => load(world));
    assert.deepEqual(writes(reopen).map((r) => `${r.method} ${r.url}`), [], 'reopen writes nothing');

    const names = game.journal.contents.map((j) => j.name);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'no duplicate journals');
    assert.equal(game.folders.filter((f) => f.getFlag(FLAG, 'removedFolder')).length, 1, 'one removed folder');
    assert.equal((await seed.chronicle.allEntities()).length, 0, 'no Chronicle pages made');
    const failed = traffic.requests.slice(since).filter((r) => r.status >= 500 || r.status === 0);
    assert.deepEqual(failed.map((r) => `${r.method} ${r.url} ${r.status}`), [], 'no failed requests');
    assert.deepEqual(world.log.hookErrors.map((e) => `${e.name}: ${e.err?.message}`), [], 'no hook errors');
    assert.deepEqual(world.log.notifications.error, [], 'no error pop-ups');
  } finally {
    await closeWorld(world);
  }
});
