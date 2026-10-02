/**
 * Pure helpers for pushing a journal made in Foundry to Chronicle as a page.
 *
 * Chronicle's `POST /entities` (`apiCreateEntityRequest`) accepts only
 * name, entity_type_id, type_label, is_private, fields_data and
 * owner_user_id. It has no text field, so the journal text goes in a
 * follow-up `PUT /entities/:id` as `entry` (`apiUpdateEntityRequest`).
 * See tools/test-journal-create.mjs.
 */

/** Keys Chronicle's create request accepts. The test pins bodies to this list. */
export const ENTITY_CREATE_KEYS = Object.freeze([
  'name', 'entity_type_id', 'type_label', 'is_private', 'fields_data', 'owner_user_id',
]);

/** Unwrap a list response that is either a bare array or `{data:[...]}`. */
export function unwrapTypeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.entity_types)) return raw.entity_types;
  return [];
}

/**
 * Choose the page type for a new journal. The configured id wins when it
 * still exists. Otherwise the first enabled type that is not a character
 * type (ActorSync would claim those), and failing that the first type.
 * @param {unknown} rawTypes - GET /entity-types response.
 * @param {number|string|null|undefined} configuredId
 * @returns {number|null} null when the campaign has no types.
 */
export function pickJournalCreateType(rawTypes, configuredId) {
  const types = unwrapTypeList(rawTypes).filter((t) => t && Number(t.id) > 0 && t.enabled !== false);
  if (types.length === 0) return null;
  const wanted = Number(configuredId);
  if (wanted > 0 && types.some((t) => Number(t.id) === wanted)) return wanted;
  const firstPage = types.find((t) => t.preset_category !== 'character');
  return Number((firstPage || types[0]).id);
}

/**
 * Body for `POST /entities`.
 * @param {{name: string, entityTypeId: number, isPrivate: boolean}} p
 */
export function buildEntityCreateBody({ name, entityTypeId, isPrivate }) {
  return { name, entity_type_id: entityTypeId, is_private: !!isPrivate };
}
