/**
 * Which sync domain owns a Foundry JournalEntry. The create hook pushes a
 * journal to Chronicle as a page only when no other domain claims it:
 * MapSync materializes maps as journals (image page flagged `mapId`, in the
 * flagged "Chronicle Maps" folder) and NoteSync owns Chronicle Notes; pushing
 * either as a page is wrong and surfaces as a failed-push error.
 *
 * Pure — flags are read through each document's own `getFlag`.
 * See tools/test-journal-ownership.mjs.
 */

/** Page flag MapSync sets on a materialized map's image page. */
export const MAP_PAGE_FLAG = 'mapId';
/** Folder flag MapSync sets on the "Chronicle Maps" folder. */
export const MAPS_FOLDER_FLAG = 'isMapsFolder';

/**
 * True when MapSync owns this journal.
 * @param {object} journal - JournalEntry (or a stand-in with pages/folder).
 * @param {string} scope - Flag scope.
 * @returns {boolean}
 */
export function isMapJournal(journal, scope) {
  if (!journal) return false;
  const pages = Array.isArray(journal.pages) ? journal.pages : (journal.pages?.contents || []);
  if (pages.some((p) => p?.getFlag?.(scope, MAP_PAGE_FLAG))) return true;
  let folder = journal.folder;
  // Parent chain is short; the bound only guards a malformed cycle.
  for (let i = 0; folder && i < 20; i++) {
    if (folder.getFlag?.(scope, MAPS_FOLDER_FLAG) === true) return true;
    folder = folder.folder;
  }
  return false;
}
