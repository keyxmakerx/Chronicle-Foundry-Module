/**
 * Session singleton that stops calendar push sites from hammering Chronicle
 * while its calendar plugin is rebuilding (503 `calendar_rebuilding`). Push
 * sites check `calendarBlackoutActive()` first and return before spending a
 * request; without it, every world-time tick fired a doomed request plus a
 * console error, and the flood evicted real errors from the shared 50-entry
 * error ring the dashboard and diagnostics bundle read.
 *
 * Session-scoped on purpose: reloading the world clears it once the rebuild
 * ships, with nothing needing to guess when the calendar came back. Pulls are
 * unaffected — see `_calendar-probe-state.mjs`. Same shape as
 * `_realtime-date-guard.mjs`.
 */

import { isCalendarRebuilding } from './_calendar-probe-state.mjs';

/** @type {{active: boolean, noticeShown: boolean}} */
const state = { active: false, noticeShown: false };

/**
 * True once a calendar call has come back as the rebuild blackout this session.
 * Push sites check this FIRST and return before spending a request.
 * @returns {boolean}
 */
export function calendarBlackoutActive() {
  return state.active;
}

/**
 * Record that Chronicle answered the blackout, and tell the GM exactly once.
 *
 * Idempotent — safe to call from every push site's catch. The notice is `info`,
 * not `warn`: nothing is broken on the GM's side and there is nothing for them
 * to fix, so an alarming banner would be a lie in the other direction.
 *
 * @param {{serverMessage?: string}|null|undefined} [err] the classified error,
 *   whose `serverMessage` (Chronicle's own prose) is preferred over ours.
 */
export function markCalendarRebuilding(err) {
  state.active = true;
  if (state.noticeShown) return;
  state.noticeShown = true;
  const detail = typeof err?.serverMessage === 'string' && err.serverMessage
    ? err.serverMessage
    : 'Chronicle’s calendar is being rebuilt and is temporarily unavailable.';
  const msg = `Chronicle Sync: ${detail} Calendar sync is paused for this session; `
    + 'journals, maps, characters, items and notes are unaffected.';
  console.warn(msg);
  try { globalThis.ui?.notifications?.info(msg); } catch { /* headless */ }
}

/**
 * Classify-and-arm in one call, for a push site's catch block.
 * @param {*} err
 * @returns {boolean} true when the error WAS the blackout (caller should return).
 */
export function handleIfCalendarRebuilding(err) {
  if (!isCalendarRebuilding(err)) return false;
  markCalendarRebuilding(err);
  return true;
}

/**
 * Test seam — resets the session singleton.
 * @private
 */
export function _resetCalendarBlackoutForTests() {
  state.active = false;
  state.noticeShown = false;
}
