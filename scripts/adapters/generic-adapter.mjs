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
 * Extract a collection-mapped field (e.g. abilities/inventory from actor.items[]).
 * Reads field.foundry_collection off the actor, optionally filters by
 * foundry_item_type, projects each entry per foundry_item_fields (or a default
 * {id,name,type}), and returns a JSON string (type json/string) or a raw array.
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

    const items = contents.map((it) => {
      if (!proj) return { id: it.id ?? null, name: it.name ?? null, type: it.type ?? null };
      const out = {};
      for (const [outKey, path] of Object.entries(proj)) {
        out[outKey] = getNestedValue(it, path) ?? null;
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
      const value = getNestedValue(actor, field.foundry_path);
      result[field.key] = value ?? null;
    }
  }
  return result;
}
