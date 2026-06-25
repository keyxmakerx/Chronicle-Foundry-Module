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
 * @returns {'absent'|'auth'|'unreachable'}
 *   - `'absent'`      — 404 / `calendar_not_configured`: Chronicle has no
 *     calendar for this campaign (import one).
 *   - `'auth'`        — 401 / 403 / `invalid_token`: token/auth problem
 *     (re-check the API key, or reinstall from a fresh campaign URL).
 *   - `'unreachable'` — anything else (network error, 5xx, unknown).
 */
export function calendarStateFromError(err) {
  const msg = String(err?.message || '');
  // Prefer an explicit numeric status; else read the authoritative status from
  // the api-client's "Chronicle API error <status>:" prefix. Never key on a
  // bare digit run in the body.
  const status = (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
  if (status === 404 || /calendar_not_configured/i.test(msg)) return 'absent';
  if (status === 401 || status === 403 || /invalid_token|unauthor/i.test(msg)) return 'auth';
  return 'unreachable';
}
