/**
 * Pure helper mapping a failed `GET /calendar` probe (thrown by api-client)
 * to the dashboard's calendar-banner state.
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
 *     calendar for this campaign.
 *   - `'auth'`        — 401 / 403 / `invalid_token`: token/auth problem
 *     (re-check the API key, or reinstall from a fresh campaign URL).
 *   - `'rebuilding'`  — a 503 whose body says `calendar_rebuilding`: that
 *     calendar route is deliberately unavailable while Chronicle rebuilds it;
 *     every other subsystem still syncs. Kept distinct from 'absent' (which
 *     would wrongly suggest importing a calendar) and 'unreachable' (which
 *     would wrongly blame connection/settings).
 *   - `'unreachable'` — anything else (network error, a bare 503 from a proxy
 *     or restart, other 5xx, unknown): a failed request, retried next time.
 */
export function calendarStateFromError(err) {
  const msg = String(err?.message || '');
  // Prefer an explicit numeric status; else read the authoritative status from
  // the api-client's "Chronicle API error <status>:" prefix. Never key on a
  // bare digit run in the body.
  const status = (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
  // Only Chronicle's own `calendar_rebuilding` body counts. A bare 503 is a
  // proxy or a restart, and treating it as the rebuild would silence date
  // sync for no reason. Ordered before 'absent' because Chronicle answers it
  // with 503 rather than 404 so the module doesn't take its "server too old"
  // path.
  if (err?.code === 'calendar_rebuilding' || /calendar_rebuilding/i.test(msg)) return 'rebuilding';
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
