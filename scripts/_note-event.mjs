/**
 * Pure decision logic for `note.created` / `note.updated` WebSocket
 * payloads. Chronicle's journal-notes rework (keyxmakerx/Chronicle#787)
 * trimmed these two message types to `{ noteId, entityId }` — no note
 * content — so a client must fetch the note over REST instead of reading it
 * off the message; `note.deleted` was already ids-only in effect (the
 * module always read just an id from it) and needs no new handling.
 * Older Chronicle deployments still send the full note inline, so both
 * shapes must be told apart correctly for as long as either is in the wild.
 *
 * No Foundry globals, no api-client import — kept pure so note-sync.mjs's
 * async fetch/apply plumbing can be exercised without stubbing a world.
 * See tools/test-note-event.mjs.
 */

/**
 * The note id a `note.created` / `note.updated` / `note.deleted` payload
 * refers to. `noteId` is the field on Chronicle#787's shape (all three
 * types); `id` is the pre-#787 full-note payload's identifier, kept as a
 * fallback so an older Chronicle deploy keeps working.
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function noteEventId(payload) {
  const id = payload?.noteId ?? payload?.id;
  return id === null || id === undefined || id === '' ? null : String(id);
}

/**
 * Whether a `note.created` / `note.updated` payload already carries the
 * note's content (the pre-#787 shape) rather than just ids. `title` is the
 * one field Chronicle's Note model always serializes (never `omitempty`),
 * so its presence is the reliable signal. `entityId`/`entity_id` is NOT a
 * signal — Chronicle#787's ids-only payload carries that field too.
 * @param {object|null|undefined} payload
 * @returns {boolean}
 */
export function noteEventHasContent(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return 'title' in payload
    || 'content' in payload
    || 'entry_html' in payload
    || 'entryHtml' in payload;
}

/**
 * What a failed `GET /notes/:noteID` fetch (triggered by an ids-only event)
 * means for the Foundry copy. Chronicle answers both "no such note" and
 * "not visible to this key" with 404 — never a distinguishable 403 — so the
 * fetch never learns which; some deployments may still answer 403, so both
 * are treated the same: the note is gone from this key's view, and the
 * caller applies that like a delete without ever having seen (and so never
 * being able to log) its title.
 * @param {number|null|undefined} status - `err.status` from the failed fetch.
 * @returns {'delete'|'error'} 'delete' when the fetch outcome means the
 *   local copy should be removed like a `note.deleted` event; 'error' for
 *   anything else (network failure, 5xx, …), which the caller surfaces
 *   normally instead of deleting on a guess.
 */
export function noteFetchFailureAction(status) {
  return status === 404 || status === 403 ? 'delete' : 'error';
}
