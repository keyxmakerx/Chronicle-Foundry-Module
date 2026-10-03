/**
 * What Chronicle removed is never deleted from Foundry on its own (#107).
 * Its journal is set aside instead: unlinked, so sync never touches it
 * again, and moved into one "Chronicle: removed" folder that the GM empties
 * when they choose. A GM may have written in any of these journals, and
 * Foundry has no bin to get a deleted one back from.
 * `tools/test-set-aside.mjs`.
 */

/** Marks the folder, so it is found again whatever it has been renamed to. */
export const REMOVED_FOLDER_FLAG = 'removedFolder';

/** The flags that tie a journal to a Chronicle page or note. */
export const LINK_FLAGS = ['entityId', 'noteId', 'isNote', 'entityType', 'fields', 'tags', 'lastSync', 'chronicleUpdatedAt'];

/**
 * The update that unlinks a journal and files it in the removed folder.
 * @param {string} scope - The module's flag scope.
 * @param {string|null} folderId
 * @returns {object}
 */
export function setAsideUpdate(scope, folderId) {
  const update = { folder: folderId };
  for (const key of LINK_FLAGS) update[`flags.${scope}.-=${key}`] = null;
  return update;
}

let creating = null;

/**
 * The removed folder, made on first use. Concurrent callers share one
 * creation, so a burst of removals never makes two folders.
 * @param {string} scope
 * @returns {Promise<Folder|null>}
 */
export async function removedFolder(scope) {
  const found = game.folders.find((f) => f.type === 'JournalEntry' && f.getFlag(scope, REMOVED_FOLDER_FLAG));
  if (found) return found;
  if (!creating) {
    creating = Folder.create({
      name: game.i18n.localize('CHRONICLE.Removed.FolderName'),
      type: 'JournalEntry',
      color: '#7a7a7a',
      flags: { [scope]: { [REMOVED_FOLDER_FLAG]: true } },
    }).finally(() => { creating = null; });
  }
  return creating;
}

/**
 * Unlinks a journal and moves it into the removed folder.
 * @param {JournalEntry} journal
 * @param {string} scope
 * @param {object} [options] - Passed to `journal.update` (the sync marker, so the update hooks ignore it).
 */
export async function setAside(journal, scope, options) {
  const folder = await removedFolder(scope);
  await journal.update(setAsideUpdate(scope, folder?.id ?? null), options);
}
