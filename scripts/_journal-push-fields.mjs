/**
 * Which journal fields a Foundry -> Chronicle push may carry.
 *
 * Chronicle update endpoints are partial and write any field that is present.
 * Name and privacy are derived from the Foundry document on every push, so
 * sending them unconditionally lets an ordinary text edit rename a page or
 * flip its privacy (the ownership-to-privacy mapping is not symmetric under
 * the Players settings). They go out only when the edit itself changed them.
 *
 * Pure; see tools/test-journal-push-fields.mjs.
 */

/**
 * Fold one update's change diff into the pending record for a journal. The
 * record survives the debounce window, so an edit burst keeps every field any
 * of its updates touched.
 * @param {{name: boolean, ownership: boolean}|undefined} pending
 * @param {object} [change] - The updateJournalEntry diff; page edits pass none.
 * @returns {{name: boolean, ownership: boolean}}
 */
export function mergeJournalChange(pending, change) {
  return {
    name: Boolean(pending?.name) || (change != null && Object.hasOwn(change, 'name')),
    ownership: Boolean(pending?.ownership) || (change != null && Object.hasOwn(change, 'ownership')),
  };
}

/**
 * The scalar fields for a push body: only those the edit changed.
 * @param {{name: string, isPrivate: boolean}} current
 * @param {{name?: boolean, ownership?: boolean}} [changed]
 * @returns {{name?: string, is_private?: boolean}}
 */
export function changedJournalFields(current, changed) {
  const body = {};
  if (changed?.name) body.name = current.name;
  if (changed?.ownership) body.is_private = current.isPrivate;
  return body;
}
