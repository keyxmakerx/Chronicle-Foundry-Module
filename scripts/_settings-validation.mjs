/**
 * Validates operator-controlled settings before they reach a Chronicle API
 * call. The module interpolates campaignId directly into every Chronicle URL
 * (`${baseUrl}/api/v1/campaigns/${campaignId}${path}`), so a malformed value
 * (empty, whitespace, non-UUID) could 404 or escape the campaign scope.
 * Pinned by `tools/test-campaign-id-validation.mjs`.
 */

/**
 * Strict UUID check (8-4-4-4-12 hex, case-insensitive). Doesn't gate on the
 * version digit since Chronicle's contract may shift.
 *
 * @param {string|unknown} id - Value to validate.
 * @returns {boolean} True iff `id` is a syntactically valid UUID.
 */
export function isValidCampaignId(id) {
  if (typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Return a user-facing error message for an invalid campaignId, or null if
 * the value is valid.
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
