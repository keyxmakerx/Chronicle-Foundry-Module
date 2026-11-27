/**
 * What Chronicle removed is never deleted from Foundry on its own (#107).
 * Its journal is set aside instead: unlinked, so sync never touches it
 * again, and moved into one "Chronicle: removed" folder that the GM empties
 * when they choose. A GM may have written in any of these journals, and
 * Foundry has no bin to get a deleted one back from.
 * `tools/test-set-aside.mjs`.
 */

import { flagRemoval } from './_flag-removal.mjs';

/** Marks the folder, so it is found again whatever it has been renamed to. */
export const REMOVED_FOLDER_FLAG = 'removedFolder';

/** The flags that say which Chronicle page or note a journal is. */
export const LINK_ID_FLAGS = ['entityId', 'noteId', 'isNote'];

/** The flags that tie a journal to a Chronicle page or note, and the page's facts, which every client with the journal can read. */
export const LINK_FLAGS = ['entityId', 'noteId', 'isNote', 'entityType', 'entityTypeSlug', 'fields', 'tags', 'lastSync', 'chronicleUpdatedAt', 'facts'];

/**
 * The update that unlinks a journal and files it in the removed folder.
 * @param {string} scope - The module's flag scope.
 * @param {string|null} folderId
 * @returns {object}
 */
export function setAsideUpdate(scope, folderId) {
  return { folder: folderId, ...flagRemoval(scope, ...LINK_FLAGS) };
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
 * @param {object} [options] - Copied into `journal.update` (the sync marker, so the update hooks ignore it); Foundry writes into the options it gets.
 */
export async function setAside(journal, scope, options) {
  const folder = await removedFolder(scope);
  await journal.update(setAsideUpdate(scope, folder?.id ?? null), { ...options });
}

/**
 * Whether a document change sets or removes any of the module's link flags,
 * in Foundry's nested form or its dotted form.
 * @param {object} change - the update's diff
 * @param {string} scope - the module's flag scope
 * @param {string[]} keys - the link flag keys
 * @returns {boolean}
 */
export function touchesLinkFlags(change, scope, keys) {
  if (!change || typeof change !== 'object') return false;
  const named = (k) => keys.includes(String(k).replace(/^-=/, ''));
  const flags = change.flags;
  if (flags && typeof flags === 'object') {
    if (Object.keys(flags).some((k) => k === `-=${scope}`)) return true;
    const ours = flags[scope];
    if (ours === null) return true;
    if (ours && typeof ours === 'object' && Object.keys(ours).some(named)) return true;
  }
  const prefix = `flags.${scope}.`;
  return Object.keys(change).some((k) => k === `flags.-=${scope}` || (k.startsWith(prefix) && named(k.slice(prefix.length))));
}
