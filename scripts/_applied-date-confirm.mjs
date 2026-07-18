/**
 * Chronicle Sync — applied-date confirmation (FM-SYNC-CONFIRMED-DATE).
 *
 * Pairs with a parallel Chronicle-side change (C-SYNC-APPLIED-BEACON).
 * Chronicle's sync chip distinguishes what Foundry SAW (the #548 beacon,
 * recorded server-side on every `GET /calendar/date`) from what it actually
 * APPLIED to the active Foundry calendar module. This module owns the
 * Foundry-side half: `POST /calendar/date/confirm` with the applied
 * `{year, month, day}`.
 *
 * The endpoint is OPTIONAL — only present on Chronicle deployments that have
 * shipped the applied-beacon release. A 404 (route doesn't exist) or 405
 * (method not allowed — an older router that doesn't recognize the path)
 * means an un-upgraded Chronicle; that is tolerated silently (one debug log
 * per session, no retries) so this module keeps working unchanged against
 * pre-upgrade servers. Any other failure is logged and swallowed by the
 * caller — a missed confirmation only leaves Chronicle's "applied" beacon
 * stale, it never blocks or retries sync.
 */

/**
 * Session-scoped "not supported" log state. A module-level singleton
 * (mirrors `_realtime-date-guard.mjs`'s `state.noticeShown`) so every call
 * site sharing this helper logs the tolerance exactly once per session
 * instead of once per apply.
 */
const state = {
  notSupportedLogged: false,
};

/**
 * Reset session state. Test-only.
 */
export function _resetAppliedDateConfirmForTests() {
  state.notSupportedLogged = false;
}

/**
 * Classify a thrown api-client error as "the confirm endpoint isn't present
 * on this Chronicle deployment" (404 route-not-found, or 405 method-not-
 * allowed). Mirrors `_realtime-date-guard.mjs`'s `isRealTimeRejection`:
 * prefer an explicit numeric `err.status`, else parse the api-client's
 * authoritative "Chronicle API error <status>:" prefix — never key on a
 * bare digit run in the message body.
 * @param {{status?: number, message?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isConfirmNotSupported(err) {
  const msg = String(err?.message || '');
  const status = (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
  return status === 404 || status === 405;
}

/**
 * Log the "confirm endpoint not supported" tolerance once per session.
 * Deliberately `console.debug` only (never `ui.notifications`) — an
 * un-upgraded Chronicle is an expected, non-actionable condition for the
 * GM, not an error.
 */
export function notifyConfirmNotSupportedOnce() {
  if (state.notSupportedLogged) return;
  state.notSupportedLogged = true;
  console.debug(
    'Chronicle: /calendar/date/confirm is not available on this Chronicle deployment '
    + '(older server, applied-beacon release not yet installed) — skipping applied-date confirmation.',
  );
}

/**
 * POST the applied date to Chronicle. Callers must invoke this ONLY after a
 * real, successful local apply — never speculatively, never on a bare
 * fetch/pull. Best-effort and non-throwing: a 404/405 is tolerated via
 * `notifyConfirmNotSupportedOnce`; any other failure is debug-logged and
 * swallowed so a confirmation hiccup never surfaces as a sync error or
 * blocks the (already-completed) apply.
 * @param {import('./api-client.mjs').ChronicleAPI} api
 * @param {{year:number, month:number, day:number}} date
 * @returns {Promise<void>}
 */
export async function confirmAppliedDate(api, date) {
  if (!api || !date) return;
  try {
    await api.post('/calendar/date/confirm', {
      year: date.year,
      month: date.month,
      day: date.day,
    });
  } catch (err) {
    if (isConfirmNotSupported(err)) {
      notifyConfirmNotSupportedOnce();
      return;
    }
    console.debug('Chronicle: Failed to confirm applied date', err?.message);
  }
}
