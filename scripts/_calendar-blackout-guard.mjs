/**
 * Chronicle Sync — calendar-blackout guard.
 *
 * FM-CAL-BLACKOUT (2026-08-21). Chronicle's calendar plugin was deleted for a
 * ground-up rebuild (V5). Its 34 REST routes stay registered and answer
 * `503 {"error":"calendar_rebuilding", …}` — deliberately 503 rather than 404,
 * so this module does not take its "that Chronicle is too old" path.
 *
 * WHAT THIS FIXES. Without it every Foundry world-time change fired TWO doomed
 * requests (the real-time pre-push probe, then the push itself) plus a red
 * console.error — un-debounced, forever. A GM running the in-game clock, or
 * advancing time per combat round, drove that pair on every tick for the whole
 * outage, and the flood filled the one 50-entry error ring the dashboard and
 * the diagnostics bundle share, evicting real map/actor/item/note errors.
 *
 * The shape is copied deliberately from `_realtime-date-guard.mjs`: a
 * module-level singleton, one notice per session, and a predicate the push
 * sites consult BEFORE spending a request. That guard already solved the same
 * class of problem (a server-side condition that should pause pushes and tell
 * the GM exactly once); this is the same idea for an outage rather than a
 * setting.
 *
 * SESSION-SCOPED ON PURPOSE. Reloading the world clears it, which is the right
 * recovery gesture once V5 lands: nothing has to guess when the calendar came
 * back. Pulls are unaffected — they fail on their own terms and are classified
 * for display by `_calendar-probe-state.mjs`.
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
