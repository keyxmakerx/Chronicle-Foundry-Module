/**
 * Chronicle Sync — calendar probe state classifier.
 *
 * Pure helper mapping a failed `GET /calendar` probe (thrown by api-client) to
 * the Sync Calendar editor's import-banner state. Extracted from
 * sync-calendar.mjs so the classification is unit-testable in isolation and so
 * a future edit can't silently regress the 401/403 → "auth" banner.
 *
 * Classification anchors on an explicit numeric `err.status` when present (e.g.
 * the api-client's ConflictError) and otherwise on the authoritative
 * "Chronicle API error <status>:" prefix the api-client formats — NOT on a bare
 * digit run, so a response body that merely contains "404" (an entity named
 * "Room 404", a UUID, …) cannot misclassify the banner. Body-keyword fallbacks
 * cover transports that don't surface a numeric status.
 */

/**
 * @param {{status?: number, message?: string}|null|undefined} err
 * @returns {'absent'|'auth'|'rebuilding'|'unreachable'}
 *   - `'absent'`      — 404 / `calendar_not_configured`: Chronicle has no
 *     calendar for this campaign (import one).
 *   - `'auth'`        — 401 / 403 / `invalid_token`: token/auth problem
 *     (re-check the API key, or reinstall from a fresh campaign URL).
 *   - `'rebuilding'`  — 503 / `calendar_rebuilding`: Chronicle is up and every
 *     other subsystem still syncs; its CALENDAR is deliberately switched off
 *     while it is rebuilt (V5). Distinct from both 'absent' and 'unreachable'
 *     because the remedy differs and both of those would mislead: 'absent'
 *     says "import a calendar" (there is nowhere to import it to) and
 *     'unreachable' says "check your connection and settings" (they are fine).
 *     Nothing the GM can do fixes it, and nothing is wrong on their side.
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
 * True when a failed call is the calendar-rebuild blackout rather than a fault.
 *
 * The push/pull paths need this as a one-line predicate (they do not want a
 * banner state), and sharing it with `calendarStateFromError` keeps a single
 * definition of "is this the blackout" instead of the two-or-three that would
 * otherwise appear at the call sites.
 *
 * @param {{status?: number, code?: string, message?: string}|null|undefined} err
 * @returns {boolean}
 */
export function isCalendarRebuilding(err) {
  return calendarStateFromError(err) === 'rebuilding';
}
