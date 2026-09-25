/**
 * Data-driven adapter that reads field definitions from Chronicle's
 * `/systems/:id/character-fields` API, so any game system can sync character
 * fields without a hand-written adapter (via `foundry_path` annotations).
 *
 * A field def is either SCALAR (`foundry_path`: dot-path on actor.system,
 * `foundry_writable`, `type` for casting) or COLLECTION (`foundry_collection`:
 * actor collection name, `foundry_item_type` filter, `foundry_item_fields`
 * projection, `type` "json"/"string" for a serialized string vs raw array).
 * Collection fields are read-only (pull only); never in the Foundry update path.
 *
 * Every extracted value passes through `normalizeFoundryValue` so live Foundry
 * structures `JSON.stringify` can't serialize (Sets, Collections of
 * pseudo-documents) become plain arrays/objects instead of `{}`.
 */

/**
 * Create a generic adapter instance by fetching field definitions from the API.
 *
 * @param {import('../api-client.mjs').ChronicleAPI} api - Chronicle API client.
 * @param {string} chronicleSystemId - The Chronicle system ID (e.g. "dnd5e").
 * @returns {Promise<{systemId: string, characterTypeSlug: string, toChronicleFields: function, fromChronicleFields: function}|null>}
 */
export async function createGenericAdapter(api, chronicleSystemId) {
  let fieldDefs;
  try {
    const resp = await api.get(`/systems/${chronicleSystemId}/character-fields`);
    if (!resp || !resp.fields || resp.fields.length === 0) {
      console.warn(`Chronicle: Generic adapter — no character fields for system "${chronicleSystemId}"`);
      return null;
    }
    fieldDefs = resp;
  } catch (err) {
    console.error(`Chronicle: Generic adapter — failed to load field defs for "${chronicleSystemId}"`, err);
    return null;
  }

  // A field is pullable if it maps a scalar (foundry_path) OR a collection
  // (foundry_collection). Both are read on toChronicleFields.
  const mappedFields = fieldDefs.fields.filter((f) => f.foundry_path || f.foundry_collection);
  if (mappedFields.length === 0) {
    console.warn(`Chronicle: Generic adapter — no fields with foundry_path/foundry_collection for "${chronicleSystemId}"`);
    return null;
  }

  // Only scalar (foundry_path) fields are writable back to Foundry — collection
  // write-back is a future tier, so it is excluded from the update path here.
  const writableFields = mappedFields.filter((f) => f.foundry_path && f.foundry_writable !== false);

  console.debug(
    `Chronicle: Generic adapter loaded for "${chronicleSystemId}" — ` +
    `${mappedFields.length} fields mapped, ${writableFields.length} writable`
  );

  return {
    /** Chronicle system ID. */
    systemId: chronicleSystemId,

    /** Character entity type slug from the manifest. */
    characterTypeSlug: fieldDefs.preset_slug || `${chronicleSystemId}-character`,

    /**
     * Foundry actor type string from the manifest (e.g., "character", "hero").
     * Different game systems use different actor types — D&D 5e uses "character",
     * Draw Steel uses "hero". Defaults to "character" if not specified.
     * @type {string}
     */
    actorType: fieldDefs.foundry_actor_type || 'character',

    /**
     * Extract Chronicle-compatible fields_data from a Foundry Actor.
     * Reads each mapped field from the actor using its foundry_path.
     *
     * @param {Actor} actor - Foundry Actor document.
     * @returns {object} Chronicle fields_data object.
     */
    toChronicleFields(actor) {
      return buildChronicleFields(actor, mappedFields);
    },

    /**
     * Convert Chronicle entity fields_data into a Foundry Actor update.
     * Only writes to fields marked as foundry_writable (or defaulting to true).
     * Returns dot-notation keys for actor.update().
     *
     * @param {object} entity - Chronicle entity with fields_data.
     * @returns {object} Foundry Actor update data.
     */
    fromChronicleFields(entity) {
      const f = entity.fields_data || {};
      const update = {};

      for (const field of writableFields) {
        const value = f[field.key];
        if (value == null) continue;

        // Cast to appropriate type.
        if (field.type === 'number') {
          const num = Number(value);
          if (Number.isNaN(num)) continue;
          update[field.foundry_path] = num;
        } else {
          update[field.foundry_path] = value;
        }
      }

      // Name is synced at document level.
      if (entity.name) update.name = entity.name;

      return update;
    },
  };
}

/**
 * Read a nested value from an object using dot-notation path.
 * Supports both nested objects and Foundry's system data.
 * e.g., getNestedValue(actor, "system.abilities.str.value")
 *
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function getNestedValue(obj, path) {
  if (!path) return undefined;
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Recursively normalize a live Foundry value into a JSON-safe plain value.
 * Foundry Sets and Collections (Map subclasses, incl. pseudo-document
 * CollectionFields) serialize to `{}` under `JSON.stringify` — this walks
 * them into arrays instead. DataModel/pseudo-document members expose data via
 * `toObject()`, not own-enumerable props, so a key-copy would miss it.
 * Defensive (never throws) and depth-guarded against cycles.
 *
 * @param {*} value
 * @param {number} [depth]
 * @returns {*} a JSON-safe value (primitive | array | plain object | null)
 */
export function normalizeFoundryValue(value, depth) {
  depth = depth || 0;
  if (value == null) return value;
  if (typeof value !== 'object') return value; // primitives pass through
  if (depth > 8) return null;                   // cycle / runaway guard

  // Native Set OR Foundry Set → array of normalized members.
  if (value instanceof Set) {
    return Array.from(value, (v) => normalizeFoundryValue(v, depth + 1));
  }
  // Native array → map members.
  if (Array.isArray(value)) {
    return value.map((v) => normalizeFoundryValue(v, depth + 1));
  }
  // Foundry Collection (a Map subclass) exposes its members as `.contents`.
  // This covers CollectionField values (pseudo-document tier ladders) and the
  // actor's items/effects collections when a path points straight at one.
  if (Array.isArray(value.contents)) {
    return value.contents.map((v) => normalizeFoundryValue(v, depth + 1));
  }
  // Plain Map (no `.contents`) → array of its values.
  if (value instanceof Map) {
    return Array.from(value.values(), (v) => normalizeFoundryValue(v, depth + 1));
  }
  // DataModel / pseudo-document → its source object (schema fields are getters,
  // not own-enumerable props, so a key-copy would miss them). `toObject(false)`
  // yields the stored source (Sets already serialized to arrays); re-normalize
  // it to catch any nested live structures.
  if (typeof value.toObject === 'function') {
    try {
      return normalizeFoundryValue(value.toObject(false), depth + 1);
    } catch (e) { /* fall through to a shallow copy */ }
  }
  // Plain-ish object → normalize own enumerable props (catches nested Sets).
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = normalizeFoundryValue(value[k], depth + 1);
  }
  return out;
}

/**
 * Extract a collection-mapped field (e.g. abilities/inventory from actor.items[]).
 * Reads field.foundry_collection off the actor, optionally filters by
 * foundry_item_type, projects each entry per foundry_item_fields (or a default
 * {id,name,type}), and returns a JSON string (type json/string) or a raw array.
 * When field.foundry_item_single is set, collapses to the FIRST matching item's
 * name (or first projected value) as a plain string — for "exactly one X item"
 * fields like a hero's class/ancestry/kit.
 * Defensive — a malformed actor/collection yields an empty result, never throws.
 *
 * @param {object} actor
 * @param {object} field - field def with foundry_collection
 * @returns {string|Array}
 */
export function extractCollectionField(actor, field) {
  const wantJson = field.type === 'json' || field.type === 'string';
  const empty = wantJson ? '[]' : [];
  try {
    const coll = actor?.[field.foundry_collection];
    if (!coll) return empty;
    let contents = coll.contents
      || (typeof coll[Symbol.iterator] === 'function' ? Array.from(coll) : []);

    if (field.foundry_item_type) {
      const types = Array.isArray(field.foundry_item_type)
        ? field.foundry_item_type
        : [field.foundry_item_type];
      contents = contents.filter((it) => it && types.includes(it.type));
    }

    const proj = field.foundry_item_fields && typeof field.foundry_item_fields === 'object'
      ? field.foundry_item_fields
      : null;

    // Single-item collapse: "exactly one X item" fields (class/ancestry/kit)
    // want the item's NAME as a plain string, not a one-element JSON array.
    // Uses the first projected path when a projection is given, else item.name.
    if (field.foundry_item_single) {
      const first = contents[0];
      if (!first) return '';
      if (proj) {
        const firstPath = Object.values(proj)[0];
        return normalizeFoundryValue(getNestedValue(first, firstPath)) ?? '';
      }
      return first.name ?? '';
    }

    const items = contents.map((it) => {
      if (!proj) return { id: it.id ?? null, name: it.name ?? null, type: it.type ?? null };
      const out = {};
      for (const [outKey, path] of Object.entries(proj)) {
        out[outKey] = normalizeFoundryValue(getNestedValue(it, path)) ?? null;
      }
      return out;
    });

    return wantJson ? JSON.stringify(items) : items;
  } catch (err) {
    console.warn(`Chronicle: generic adapter — collection extract failed for "${field.key}"`, err);
    return empty;
  }
}

/**
 * Build a Chronicle fields_data object from a Foundry actor and the mapped field
 * defs. Scalar fields read their foundry_path; collection fields extract from the
 * named actor collection. PURE (no Foundry globals) → unit-testable.
 *
 * @param {object} actor
 * @param {Array<object>} mappedFields
 * @returns {object}
 */
export function buildChronicleFields(actor, mappedFields) {
  const result = {};
  for (const field of mappedFields) {
    if (field.foundry_collection) {
      result[field.key] = extractCollectionField(actor, field);
    } else {
      let value = normalizeFoundryValue(getNestedValue(actor, field.foundry_path));
      // A Set/array/object scalar (e.g. system.skills.value, actor.statuses)
      // declared on a string/json field is serialized to a JSON string so it
      // arrives as parseable JSON, mirroring how collection fields are stored.
      if (value != null && typeof value === 'object'
          && (field.type === 'string' || field.type === 'json')) {
        value = JSON.stringify(value);
      }
      result[field.key] = value ?? null;
    }
  }
  return result;
}
