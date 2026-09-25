/**
 * Real-time calendar date-push guard.
 *
 * When a Chronicle calendar tracks real-world time, `GET /calendar/date`
 * carries `tracks_real_time: true` and Chronicle rejects date writes with a
 * 422. This module centralizes the push-side reaction so all push sites
 * (calendar-sync.mjs's hook-triggered pushes, sync-dashboard.mjs's manual
 * push button) share one guard implementation.
 *
 * Pull/event sync is untouched — this only gates `PUT /calendar/date`.
 * `GET /calendar` (the structure payload) does NOT carry this field; never
 * read it from there.
 */

import { handleIfCalendarRebuilding } from './_calendar-blackout-guard.mjs';

/**
 * Session-scoped notice state. A module-level singleton so calendar-sync.mjs
 * and sync-dashboard.mjs — two independent classes — share one "shown
 * already" flag without either owning the other.
 */
const state = {
  noticeShown: false,
};

/**
 * Reset session state. Test-only — production code never needs to un-show
 * the notice mid-session.
 */
export function _resetRealtimeDateGuardForTests() {
  state.noticeShown = false;
}

/**
 * Read the `tracks_real_time` field defensively — a network hiccup or an
 * old Chronicle deploy can hand back `null`/`undefined`/something
 * unexpected.
 * @param {{tracks_real_time?: boolean}|null|undefined} payload
 * @returns {boolean}
 */
export function tracksRealTime(payload) {
  return payload?.tracks_real_time === true;
}

/**
 * Classify a thrown api-client error as Chronicle's W3 real-time rejection
 * (422). Mirrors `_calendar-probe-state.mjs`'s `calendarStateFromError`:
 * prefer an explicit numeric `err.status`, else parse the api-client's
 * authoritative "Chronicle API error <status>:" prefix — never key on a bare
 * digit run in the message body.
 * @param {{status?: number, message?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isRealTimeRejection(err) {
  const msg = String(err?.message || '');
  const status = (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
  return status === 422;
}

/**
 * Show the one-time-per-session GM notice that date pushes are paused.
 * Idempotent — safe to call from every gated push site (including the 422
 * backstop path); only the first call in a session actually notifies.
 */
export function notifyRealTimePushPaused() {
  if (state.noticeShown) return;
  state.noticeShown = true;
  const msg = 'Chronicle Sync: this calendar tracks real-world time — '
    + 'Foundry date changes are not pushed to Chronicle. Pulls still work.';
  console.warn(msg);
  try { globalThis.ui?.notifications?.warn(msg); } catch { /* headless */ }
}

/**
 * Fetch-before-push guard for `PUT /calendar/date`. Date pushes are rare
 * (GM advances), so the extra `GET /calendar/date` is cheap and self-heals a
 * mid-session flag flip to enabled — never rely on a session-long cached
 * value alone. A probe failure is not this guard's concern; let the push
 * attempt proceed and fail (or succeed) on its own terms.
 * @param {import('./api-client.mjs').ChronicleAPI} api
 * @returns {Promise<boolean>} true if the caller should SKIP the push.
 */
export async function shouldSkipDatePush(api) {
  let payload;
  try {
    payload = await api.get('/calendar/date');
  } catch (err) {
    // A `503 calendar_rebuilding` means the PUT this guard is about to wave
    // through is certain to fail too, so skip it here instead of costing a
    // second request. Every other probe failure fails open: it's not this
    // guard's business, so the push proceeds to succeed or fail on its own.
    if (handleIfCalendarRebuilding(err)) return true;
    return false;
  }
  if (!tracksRealTime(payload)) return false;
  notifyRealTimePushPaused();
  return true;
}
