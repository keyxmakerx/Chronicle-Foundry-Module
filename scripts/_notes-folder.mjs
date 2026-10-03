/**
 * The old "Chronicle Notes" journal folder, after the player notebook
 * replaced the note sync that filled it (#124).
 *
 * Nothing in it syncs any more, in either direction. On the GM's world load
 * it is set aside once, like anything else sync stops owning: every journal
 * that was a note copy is unlinked and marked as an old note, and the folder
 * tree moves into "Chronicle: removed" when Foundry's folder depth allows,
 * else it stays where it is. Nothing is deleted; the GM empties it when they
 * choose. JournalSync keeps excluding all of it (`isOldNotesJournal`), so a
 * set-aside note never comes back as a new Chronicle page.
 * `tools/test-notes-folder.mjs`, bench `notes.bench.mjs`.
 */

import { LINK_FLAGS, REMOVED_FOLDER_FLAG } from './_set-aside.mjs';

/** Flag on the root "Chronicle Notes" folder, set by the retired note sync. */
export const NOTES_ROOT_FLAG = 'isNotesRoot';

/** Flag on each journal that was a note copy, once it is unlinked. */
export const OLD_NOTE_FLAG = 'oldNote';

/** Flags the retired note sync put on journals and folders. */
const NOTE_FLAGS = ['noteId', 'isNote'];

/** Foundry's folder nesting limit, when the world doesn't say. */
const DEFAULT_MAX_DEPTH = 4;

/**
 * Whether a journal is, or sits under, the old notes folder.
 * @param {JournalEntry} journal
 * @param {string} scope - The module's flag scope.
 * @returns {boolean}
 */
export function isOldNotesJournal(journal, scope) {
  if (!journal) return false;
  if (journal.getFlag?.(scope, OLD_NOTE_FLAG) || journal.getFlag?.(scope, 'isNote')) return true;
  return !!notesRootOf(journal.folder, scope);
}

/**
 * The notes root at or above `folder`, if any. Bounded, so a folder cycle
 * in a damaged world can't hang the walk.
 * @returns {Folder|null}
 */
function notesRootOf(folder, scope) {
  for (let f = folder, n = 0; f && n < 32; f = f.folder, n += 1) {
    if (f.getFlag?.(scope, NOTES_ROOT_FLAG)) return f;
  }
  return null;
}

/** Levels in the tree under `root`, counting `root` as 1. */
function treeHeight(root, folders) {
  const kids = folders.filter((f) => f.folder?.id === root.id);
  let deepest = 0;
  for (const k of kids) deepest = Math.max(deepest, treeHeight(k, folders));
  return 1 + deepest;
}

/**
 * The update that unlinks one old note journal, or null when it already is.
 * @param {JournalEntry} journal
 * @param {string} scope
 * @returns {object|null}
 */
export function unlinkNoteUpdate(journal, scope) {
  const linked = LINK_FLAGS.some((k) => journal.getFlag(scope, k) !== undefined);
  if (!linked && journal.getFlag(scope, OLD_NOTE_FLAG)) return null;
  const update = { [`flags.${scope}.${OLD_NOTE_FLAG}`]: true };
  for (const key of LINK_FLAGS) update[`flags.${scope}.-=${key}`] = null;
  return update;
}

/**
 * Sets the old notes folder aside. Safe to run on every world load: a world
 * with no old notes, or one already set aside, makes no writes.
 * @param {object} deps
 * @param {object} deps.game - Foundry's `game`.
 * @param {string} deps.scope - The module's flag scope.
 * @param {(scope: string) => Promise<Folder|null>} deps.removedFolder
 * @param {number} [deps.maxDepth] - Foundry's folder nesting limit.
 * @param {object} [deps.options] - Passed to every update (the sync marker).
 * @returns {Promise<{unlinked: number, moved: number}>}
 */
export async function retireNotesFolder({ game, scope, removedFolder, maxDepth = DEFAULT_MAX_DEPTH, options = {} }) {
  const folders = game.folders.filter((f) => f.type === 'JournalEntry');
  const roots = folders.filter((f) => f.getFlag(scope, NOTES_ROOT_FLAG));
  let unlinked = 0;
  let moved = 0;

  // Every note copy, wherever the GM has since moved it.
  for (const journal of game.journal.contents) {
    const isNote = NOTE_FLAGS.some((k) => journal.getFlag(scope, k) !== undefined)
      || !!notesRootOf(journal.folder, scope);
    if (!isNote) continue;
    const update = unlinkNoteUpdate(journal, scope);
    if (!update) continue;
    await journal.update(update, options);
    unlinked += 1;
  }

  for (const root of roots) {
    const parentRemoved = root.folder?.getFlag(scope, REMOVED_FOLDER_FLAG);
    if (parentRemoved || root.folder) continue; // already set aside, or the GM filed it
    // The removed folder is one level; the tree must fit under it.
    if (treeHeight(root, folders) + 1 > maxDepth) continue;
    const removed = await removedFolder(scope);
    if (!removed || removed.id === root.id) continue;
    await root.update({ folder: removed.id }, options);
    moved += 1;
  }
  return { unlinked, moved };
}
