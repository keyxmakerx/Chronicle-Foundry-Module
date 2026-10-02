/**
 * Session singleton that stops calendar push sites from hammering Chronicle
 * while one of its calendar routes answers `503 calendar_rebuilding`. Push
 * sites check `calendarBlackoutActive()` first and return before spending a
 * request, so a world-time tick costs nothing during the blackout.
 *
 * Self-healing: the blackout only holds for a short window, after which the
 * next push is allowed through as a probe, and any good calendar answer
 * (`noteCalendarAnswerOk`) clears it with no notice. The GM is told once,
 * when it first arms. Pulls are unaffected — see `_calendar-probe-state.mjs`.
 * Same shape as `_realtime-date-guard.mjs`.
 */

/** How long a blackout suppresses pushes before one is let through to probe. */
export const BLACKOUT_RETRY_MS = 30_000;

import { isCalendarRebuilding } from './_calendar-probe-state.mjs';

/** @type {{active: boolean, noticeShown: boolean}} */
const state = { active: false, noticeShown: false, armedAt: 0 };

/**
 * True once a calendar call has come back as the rebuild blackout this session.
 * Push sites check this FIRST and return before spending a request.
 * @returns {boolean}
 */
export function calendarBlackoutActive(now = Date.now()) {
  return state.active && now - state.armedAt < BLACKOUT_RETRY_MS;
}

/**
 * A calendar call succeeded: the blackout (if any) is over. Silent on purpose;
 * nothing the GM did caused it and nothing is left for them to do.
 */
export function noteCalendarAnswerOk() {
  state.active = false;
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
export function markCalendarRebuilding(err, now = Date.now()) {
  state.active = true;
  state.armedAt = now;
  if (state.noticeShown) return;
  state.noticeShown = true;
  const detail = typeof err?.serverMessage === 'string' && err.serverMessage
    ? err.serverMessage
    : 'Chronicle’s calendar is being rebuilt and is temporarily unavailable.';
  const msg = `Chronicle Sync: ${detail} Calendar sync is paused; `
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
  state.armedAt = 0;
}
