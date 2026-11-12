/**
 * Plans which "identity" items (ancestry, culture, career, kit) on an actor
 * must be swapped to match what Chronicle says. PURE: no Foundry globals.
 *
 * Only single-item collection fields of one concrete item type are eligible.
 * class and subclass drive the game system's own advancement, and level and
 * heroic_resource_name are read off the class item, so those stay Foundry-led
 * and are never planned here.
 */

/** Fields and item types that stay Foundry-led; embedding them by hand could leave a sheet half-built. */
const FOUNDRY_LED_KEYS = new Set(['level', 'heroic_resource_name']);
const FOUNDRY_LED_TYPES = new Set(['class', 'subclass']);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The one item type a field def maps, or null when it is not a single concrete type. */
function singleType(def) {
  const t = def.foundry_item_type;
  if (typeof t === 'string' && t) return t;
  if (Array.isArray(t) && t.length === 1 && typeof t[0] === 'string' && t[0]) return t[0];
  return null;
}

/** The field defs this feature may write (also used by the capability report). */
export function identityFieldDefs(fieldDefs) {
  return (Array.isArray(fieldDefs) ? fieldDefs : []).filter((def) => {
    if (!def || !def.key || !def.foundry_collection || !def.foundry_item_single) return false;
    if (FOUNDRY_LED_KEYS.has(def.key)) return false;
    const type = singleType(def);
    return !!type && !FOUNDRY_LED_TYPES.has(type);
  });
}

/** Each eligible field with the one item type it maps. */
export function identityFieldTypes(fieldDefs) {
  return identityFieldDefs(fieldDefs).map((def) => ({ fieldKey: def.key, itemType: singleType(def) }));
}

/**
 * Chronicle's pick for each eligible field, trimmed; empty picks left out.
 * Stored on the actor after an apply, so the next one can tell whether
 * Chronicle changed the pick or Foundry did.
 * @param {Array<object>} fieldDefs
 * @param {object} fieldsData
 * @returns {Record<string, string>}
 */
export function identityPicks(fieldDefs, fieldsData) {
  const data = fieldsData && typeof fieldsData === 'object' ? fieldsData : {};
  const out = {};
  for (const def of identityFieldDefs(fieldDefs)) {
    const raw = data[def.key];
    if (typeof raw === 'string' && raw.trim()) out[def.key] = raw.trim();
  }
  return out;
}

/**
 * @param {object} args
 * @param {Array<{id: string, name: string, type: string}>} args.items - the actor's embedded items
 * @param {Array<object>} args.fieldDefs - mapped character field defs
 * @param {object} args.fieldsData - Chronicle `fields_data`
 * @param {Record<string, string>} [args.applied] - the picks last applied to
 *   this actor. A field whose pick hasn't changed since is left alone: a
 *   different item there is the GM's own swap in Foundry, which the next
 *   field push carries to Chronicle, and replacing it would delete it.
 * @returns {Array<{fieldKey: string, itemType: string, wantName: string, removeIds: string[]}>}
 */
export function planIdentityItems({ items, fieldDefs, fieldsData, applied }) {
  const list = Array.isArray(items) ? items : [];
  const data = fieldsData && typeof fieldsData === 'object' ? fieldsData : {};
  const last = applied && typeof applied === 'object' ? applied : {};
  const plan = [];
  for (const def of identityFieldDefs(fieldDefs)) {
    const raw = data[def.key];
    if (typeof raw !== 'string') continue;
    const wantName = raw.trim();
    // An empty pick never removes the actor's item: sync does not delete without asking.
    if (!wantName) continue;
    if (typeof last[def.key] === 'string' && norm(last[def.key]) === norm(wantName)) continue;
    const itemType = singleType(def);
    const current = list.filter((it) => it && it.type === itemType);
    // The adapter reads the first item of the type, so that is the one compared.
    if (current.length && norm(current[0].name) === norm(wantName)) continue;
    // Only that first item is replaced; any others of the type (a second kit)
    // are the GM's and stay, since sync never deletes without asking.
    plan.push({ fieldKey: def.key, itemType, wantName, removeIds: current.length ? [current[0].id] : [] });
  }
  return plan;
}
