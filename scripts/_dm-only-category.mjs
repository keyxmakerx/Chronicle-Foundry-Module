/**
 * Whether a Chronicle page sits in a category only the DM team may see
 * (Chronicle's Adventures category). Chronicle hides every page in it from
 * players whatever the page's own visibility says, so sync must treat the
 * page as private too. Pure: `tools/test-dm-only-category.mjs`.
 */

/** The preset category Chronicle gives its DM-only Adventures category. */
export const DM_ONLY_PRESET = 'adventures';

/**
 * Chronicle marks the page itself (`type_dm_only`), and the category carries
 * the preset; either is enough, so a page sent without the mark (an older
 * Chronicle, a live event) is still caught by its category.
 * @param {object} entity - reads type_dm_only, entity_type_id
 * @param {Map<number, {id: number, preset_category?: string, parent_type_id?: number|null}>} [types]
 * @returns {boolean}
 */
export function inDmOnlyCategory(entity, types) {
  if (entity?.type_dm_only === true) return true;
  if (!types?.get) return false;
  const seen = new Set();
  for (let t = types.get(entity?.entity_type_id); t && !seen.has(t.id); t = types.get(t.parent_type_id)) {
    seen.add(t.id);
    if (t.preset_category === DM_ONLY_PRESET) return true;
  }
  return false;
}
