/**
 * Chronicle Sync — real-time calendar date-push guard (RC-4, FM-REALTIME-DATE-SIGNAL).
 *
 * When a Chronicle calendar tracks real-world time, `GET /calendar/date` carries
 * `tracks_real_time: true` — the composed `UsesRealTime()` predicate (mode ==
 * reallife AND flag; `syncapi/calendar_api_handler.go:95`) — and Chronicle's W3
 * guard rejects date writes with a 422. This module centralizes the push-side
 * reaction so calendar-sync.mjs's three hook-triggered pushes and
 * sync-dashboard.mjs's manual push button share ONE guard implementation
 * instead of forking the same logic twice (dispatch stop-and-flag).
 *
 * Pull/event sync is untouched — this only gates `PUT /calendar/date`.
 * `GET /calendar` (the structure payload) does NOT carry this field; never
 * read it from there.
 */

import { handleIfCalendarRebuilding } from './_calendar-blackout-guard.mjs';

/**
 * Session-scoped notice state. A module-level singleton (not a class field)
 * so calendar-sync.mjs and sync-dashboard.mjs — two independent classes —
 * share one "shown already" flag without either owning the other. Same
 * lifetime as the structure guard's per-instance session state
 * (calendar-sync.mjs's `_calendarSyncDisabled`, set up around line 327).
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
 * Read the `tracks_real_time` field defensively (FM-ENVELOPE-AUDIT
 * convention — never assume a payload shape). `/calendar/date` is a bare
 * single-object endpoint, but a network hiccup or an old Chronicle deploy
 * can still hand back `null`/`undefined`/something unexpected.
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
    // FM-CAL-BLACKOUT: one probe failure is classified rather than swallowed.
    // A `503 calendar_rebuilding` means the PUT this guard is about to wave
    // through is certain to fail too, so arming the session guard here and
    // answering "skip" costs the caller one request instead of two — and every
    // later push costs none, because the caller returns before probing.
    //
    // Every OTHER failure keeps the original fail-open contract below: a probe
    // that could not be read is not this guard's business, and the push
    // proceeds to succeed or fail on its own terms.
    if (handleIfCalendarRebuilding(err)) return true;
    return false;
  }
  if (!tracksRealTime(payload)) return false;
  notifyRealTimePushPaused();
  return true;
}
