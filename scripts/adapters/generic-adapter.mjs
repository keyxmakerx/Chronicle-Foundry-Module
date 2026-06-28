/**
 * Chronicle Sync - Generic System Adapter
 *
 * A data-driven adapter that reads field definitions from the Chronicle
 * /systems/:id/character-fields API. This allows any game system — including
 * custom-uploaded ones — to sync character fields between Chronicle and Foundry
 * without a hand-written adapter, as long as the system manifest includes
 * foundry_path annotations on its character fields.
 *
 * Field definitions specify either a SCALAR mapping or a COLLECTION mapping:
 *
 *   Scalar (a single value on actor.system):
 *   - key:             Chronicle field key (e.g. "hp_current")
 *   - foundry_path:    dot-notation path on actor.system (e.g. "system.attributes.hp.value")
 *   - foundry_writable: whether Chronicle may write back to this Foundry path (default true)
 *   - type:            field type ("number", "string", etc.) for casting
 *
 *   Collection (embedded documents — abilities, inventory, features — that live in
 *   actor.items[] etc., which a dot-path cannot reach):
 *   - key:               Chronicle field key (e.g. "abilities_json")
 *   - foundry_collection: the actor collection to read ("items", "effects")
 *   - foundry_item_type:  optional Foundry item type(s) to keep (string or string[])
 *   - foundry_item_fields: projection { outKey: "dot.path.on.item" }; omit for a
 *                          default {id,name,type} projection
 *   - type:              "json"/"string" → serialized JSON string; else a raw array
 *   Collection fields are READ-ONLY today (pull only); write-back is a future tier,
 *   so they are never included in the Foundry update path.
 *
 * Every extracted value (scalar or projected) is run through
 * `normalizeFoundryValue` so live Foundry structures that `JSON.stringify`
 * cannot serialize — Sets (keywords, skills, characteristics, actor.statuses)
 * and Collections of pseudo-documents (an ability's `system.power.effects` tier
 * ladder) — become plain arrays/objects instead of `{}`.
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
 * Normalize a value read off a live Foundry document into a JSON-safe plain
 * value. Foundry models many fields as data structures that `JSON.stringify`
 * cannot serialize meaningfully:
 *   - a **Set** (keywords, skills, power-roll characteristics, actor.statuses)
 *     serializes to `{}` — must become an array;
 *   - a **Collection / ModelCollection** (a Map subclass — e.g. a CollectionField
 *     of pseudo-documents like an ability's `system.power.effects` tier ladder)
 *     also serializes to `{}` — must become an array of its members;
 *   - a **DataModel / pseudo-document** member exposes its data via `toObject()`,
 *     not own-enumerable properties (the schema fields are getters).
 *
 * This walks such structures recursively and returns arrays / plain objects /
 * primitives only. It is defensive (never throws) and depth-guarded against
 * cycles. Primitives and already-plain values pass straight through, so it is
 * safe to apply to every extracted field.
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
