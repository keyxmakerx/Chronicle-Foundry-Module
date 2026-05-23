/**
 * Chronicle Sync — Settings input validators (FM-SEC-CHUNK-5)
 *
 * Validates operator-controlled settings BEFORE they reach a Chronicle
 * API call. Today's surface: campaignId. The module reads campaignId
 * from Foundry's world settings and uses it in every Chronicle URL
 * (`${baseUrl}/api/v1/campaigns/${campaignId}${path}`). A misconfigured
 * (typo'd, empty, non-UUID) value would interpolate into the URL and
 * either 404 from Chronicle (best case) or escape the campaign scope
 * (e.g. `..` injection — low risk since the operator controls the
 * setting, but T-O3 says don't trust operator-self-honesty either).
 *
 * Per FM-SEC-CHUNK-5 / FM-SECURITY-AUDIT §2 P-7.
 *
 * Exported for the regression test at tools/test-campaign-id-validation.mjs.
 */

/**
 * UUID v4 format check. Chronicle's campaign IDs are UUID v4
 * (per `.ai.md` and the install URL shape
 * `/api/v1/campaigns/<uuid>/foundry-vtt/module.json`).
 *
 * Accepts both lowercase and uppercase hex (case-insensitive). Requires
 * the exact 8-4-4-4-12 dash positions. Rejects whitespace, empty
 * strings, non-UUID strings, malformed UUIDs.
 *
 * @param {string|unknown} id - Value to validate.
 * @returns {boolean} True iff `id` is a syntactically valid UUID.
 */
export function isValidCampaignId(id) {
  if (typeof id !== 'string') return false;
  // Strict UUID — 8-4-4-4-12 hex. Case-insensitive. Rejects v1/v2/v3
  // distinctions deliberately (Chronicle issues v4 but we don't gate
  // on the version digit because future contracts may shift).
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Return a user-facing error message for an invalid campaignId, or
 * null if the value is valid. Callers can use this for both the
 * `ui.notifications.error` call AND a console-error context.
 *
 * @param {string|unknown} id
 * @returns {string|null}
 */
export function describeCampaignIdError(id) {
  if (typeof id !== 'string') return 'Chronicle: campaignId setting is missing or not a string. Open Module Settings → Chronicle Sync → Campaign ID and paste the campaign UUID from Chronicle.';
  if (id.length === 0) return 'Chronicle: campaignId setting is empty. Open Module Settings → Chronicle Sync → Campaign ID and paste the campaign UUID from Chronicle.';
  if (id.trim() !== id) return 'Chronicle: campaignId setting has surrounding whitespace. Trim it in Module Settings → Chronicle Sync → Campaign ID.';
  if (!isValidCampaignId(id)) return 'Chronicle: campaignId setting is not a valid UUID. Expected 8-4-4-4-12 hex (e.g. "abc12345-6789-4abc-def0-123456789abc"). Open Module Settings → Chronicle Sync → Campaign ID.';
  return null;
}
