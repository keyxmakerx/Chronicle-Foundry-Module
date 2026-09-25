/**
 * Pure helper mapping a failed `GET /calendar` probe (thrown by api-client)
 * to the Sync Calendar editor's import-banner state.
 *
 * Classification anchors on an explicit numeric `err.status` when present,
 * otherwise on the authoritative "Chronicle API error <status>:" prefix the
 * api-client formats — never a bare digit run in the body (which could
 * misfire on an entity named "Room 404" or a UUID). Body-keyword fallbacks
 * cover transports that don't surface a numeric status.
 */

/**
 * @param {{status?: number, message?: string}|null|undefined} err
 * @returns {'absent'|'auth'|'rebuilding'|'unreachable'}
 *   - `'absent'`      — 404 / `calendar_not_configured`: Chronicle has no
 *     calendar for this campaign (import one).
 *   - `'auth'`        — 401 / 403 / `invalid_token`: token/auth problem
 *     (re-check the API key, or reinstall from a fresh campaign URL).
 *   - `'rebuilding'`  — 503 / `calendar_rebuilding`: Chronicle's calendar is
 *     deliberately unavailable during its V5 rebuild; every other subsystem
 *     still syncs. Kept distinct from 'absent' (which would wrongly suggest
 *     importing a calendar) and 'unreachable' (which would wrongly blame
 *     connection/settings) — nothing the GM can do fixes it.
 *   - `'unreachable'` — anything else (network error, other 5xx, unknown).
 */
export function calendarStateFromError(err) {
  const msg = String(err?.message || '');
  // Prefer an explicit numeric status; else read the authoritative status from
  // the api-client's "Chronicle API error <status>:" prefix. Never key on a
  // bare digit run in the body.
  const status = (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
  // Ordered before 'absent' deliberately: Chronicle answers the blackout with
  // 503 rather than 404 precisely so the module does not take its "this server
  // is too old to have the endpoint" path, and misreading it as 'absent' would
  // reintroduce that confusion one layer up.
  if (status === 503 || err?.code === 'calendar_rebuilding'
    || /calendar_rebuilding/i.test(msg)) return 'rebuilding';
  if (status === 404 || /calendar_not_configured/i.test(msg)) return 'absent';
  if (status === 401 || status === 403 || /invalid_token|unauthor/i.test(msg)) return 'auth';
  return 'unreachable';
}

/**
 * True when a failed call is the calendar-rebuild blackout rather than a
 * fault. A one-line predicate for push/pull paths that don't want a full
 * banner state, sharing `calendarStateFromError`'s single definition of
 * "is this the blackout".
 * @param {{status?: number, code?: string, message?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isCalendarRebuilding(err) {
  return calendarStateFromError(err) === 'rebuilding';
}
