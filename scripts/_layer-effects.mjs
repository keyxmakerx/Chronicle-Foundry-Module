/**
 * Chronicle transformation layers as Active Effects: one effect per layer
 * on the hero's actor, named after the layer. A layer never writes the
 * hero's own fields in Chronicle, so the effect never writes the actor's
 * source data either; taking the layer off removes the effect and the sheet
 * is back as it was.
 *
 * What an effect can carry: a `set` or `add` on a field Chronicle maps to an
 * actor path (`foundry_path`). A set of an object, such as a revenant's
 * immunities, becomes one override per member. Everything else (an
 * ancestry, which is an item; a trait added or set aside) is listed in the
 * effect's description, so the GM still sees the whole layer.
 *
 * Pure — see tools/test-layer-effects.mjs.
 */

import { escapeHtml } from './_escape-html.mjs';

/** Foundry's CONST.ACTIVE_EFFECT_MODES values used here. */
export const EFFECT_MODE = Object.freeze({ ADD: 2, OVERRIDE: 5 });

/** Flag key on an effect that sync made for a layer. */
export const LAYER_FLAG = 'layer';

/** The icon of a layer's effect: Foundry's own aura, present on every install. */
const EFFECT_ICON = 'icons/svg/aura.svg';

/** A value with `"@level"` read as the hero's level, as the Chronicle sheet does. */
function resolveLevel(v, level) {
  return v === '@level' ? level : v;
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * The scalar field defs an effect can change, by key: those with a
 * `foundry_path` on the actor's system data. Collection fields (items) are
 * left out; they are never effect keys.
 * @param {object[]} fieldDefs
 * @returns {Map<string, object>}
 */
export function effectFieldMap(fieldDefs) {
  const out = new Map();
  for (const f of fieldDefs || []) {
    if (f?.key && typeof f.foundry_path === 'string' && f.foundry_path.startsWith('system.')) out.set(f.key, f);
  }
  return out;
}

function changeValue(def, v) {
  if (def.type === 'number') {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v !== null && typeof v !== 'boolean' ? String(n) : null;
  }
  return isScalar(v) && v !== null ? String(v) : null;
}

/** A change's words for the description, when it is not an effect key. */
function describe(c, level) {
  const label = c.label ? ` (${c.label})` : '';
  const show = (v) => {
    const r = resolveLevel(v, level);
    if (isScalar(r)) return String(r);
    if (r && typeof r === 'object' && typeof r.name === 'string') return r.name;
    try { return JSON.stringify(r); } catch { return ''; }
  };
  const field = String(c.field || '').replace(/_json$/, '').replace(/_/g, ' ');
  switch (c.op) {
    case 'set': return `${field} becomes ${show(c.value)}${label}`;
    case 'add': return `${field} ${Number(c.value) < 0 ? '' : '+'}${show(c.value)}${label}`;
    case 'append': return `Adds ${show(c.value)} to ${field}`;
    case 'remove': return `Sets aside ${show(c.value)} from ${field}`;
    default: return '';
  }
}

/**
 * One layer's effect data.
 * @param {object} layer - `{id, name, source, note, changes}` as Chronicle sends it.
 * @param {Map<string, object>} fields - from effectFieldMap.
 * @param {number} level - the hero's level, for `"@level"`.
 * @returns {{data: object, fieldKeys: string[]}}
 */
export function layerEffect(layer, fields, level) {
  const changes = [];
  const words = [];
  const fieldKeys = new Set();
  for (const c of Array.isArray(layer?.changes) ? layer.changes : []) {
    const def = fields.get(c?.field);
    let made = false;
    if (def && c.op === 'add') {
      const v = changeValue({ type: 'number' }, resolveLevel(c.value, level));
      if (v !== null) {
        changes.push({ key: def.foundry_path, mode: EFFECT_MODE.ADD, value: v });
        made = true;
      }
    } else if (def && c.op === 'set') {
      const val = resolveLevel(c.value, level);
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const members = Object.entries(val)
          .map(([k, mv]) => [k, changeValue({ type: 'number' }, resolveLevel(mv, level)) ?? changeValue({}, resolveLevel(mv, level))])
          .filter(([k, mv]) => /^[A-Za-z0-9_]+$/.test(k) && mv !== null);
        for (const [k, mv] of members) changes.push({ key: `${def.foundry_path}.${k}`, mode: EFFECT_MODE.OVERRIDE, value: mv });
        made = members.length > 0;
      } else {
        const v = changeValue(def, val);
        if (v !== null) {
          changes.push({ key: def.foundry_path, mode: EFFECT_MODE.OVERRIDE, value: v });
          made = true;
        }
      }
    }
    if (made) fieldKeys.add(c.field);
    else {
      const w = describe(c, level);
      if (w) words.push(w);
    }
  }
  const lines = [];
  if (layer?.note) lines.push(`<p>${escapeHtml(layer.note)}</p>`);
  if (words.length) lines.push(`<ul>${words.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
  lines.push('<p><em>Put on in Chronicle. Take it off there.</em></p>');
  return {
    data: {
      name: String(layer?.name || 'Transformation'),
      img: EFFECT_ICON,
      description: lines.join(''),
      changes,
      disabled: false,
      transfer: false,
    },
    fieldKeys: [...fieldKeys],
  };
}

/** A stable fingerprint of what an effect was made from, so an unchanged layer writes nothing. */
export function layerSignature(layer, level) {
  return JSON.stringify([layer?.name ?? '', layer?.note ?? '', layer?.changes ?? [], level]);
}

/**
 * What to create, update and delete so the actor carries exactly one effect
 * per layer. Only effects sync made (they carry the layer flag) are ever
 * updated or deleted; the GM's own effects are never touched. An effect is
 * rewritten only when its layer or the hero's level changed, so a GM who
 * switched one off in Foundry keeps it off until the layer changes.
 *
 * @param {object} p
 * @param {object[]} p.layers - Chronicle's layers, oldest first.
 * @param {object[]} p.fieldDefs - the adapter's field defs.
 * @param {number} p.level - the hero's level.
 * @param {{id: string, flag: object}[]} p.existing - the actor's effects with this module's layer flag.
 * @param {string} p.scope - the flag scope.
 * @returns {{create: object[], update: object[], remove: string[]}}
 */
export function planLayerEffects({ layers, fieldDefs, level, existing, scope }) {
  const fields = effectFieldMap(fieldDefs);
  const lvl = Number.isFinite(Number(level)) ? Number(level) : 0;
  const byLayer = new Map();
  const remove = [];
  for (const e of existing || []) {
    const id = e?.flag?.id;
    if (!id || byLayer.has(id)) remove.push(e.id);
    else byLayer.set(id, e);
  }
  const create = [];
  const update = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    if (!layer?.id) continue;
    const sig = layerSignature(layer, lvl);
    const have = byLayer.get(layer.id);
    byLayer.delete(layer.id);
    if (have && have.flag.sig === sig) continue;
    const { data, fieldKeys } = layerEffect(layer, fields, lvl);
    const flag = {
      id: layer.id,
      sig,
      fields: fieldKeys,
      layer: { id: layer.id, name: layer.name, note: layer.note ?? '', changes: layer.changes ?? [], createdAt: layer.createdAt ?? '' },
    };
    const doc = { ...data, flags: { [scope]: { [LAYER_FLAG]: flag } } };
    if (have) {
      // The GM's on/off choice stays theirs on a rewrite.
      const { disabled, ...rest } = doc;
      update.push({ _id: have.id, ...rest });
    } else create.push(doc);
  }
  for (const e of byLayer.values()) remove.push(e.id);
  return { create, update, remove };
}

/**
 * The Chronicle field keys the actor's layer effects change. Those fields
 * are left out of pushes while a layer is on: the actor reads them with the
 * effect applied, and pushing that would write the layer into the hero's own
 * fields, where Chronicle would then apply it a second time.
 * @param {{flag: object}[]} existing
 * @returns {Set<string>}
 */
export function layeredFieldKeys(existing) {
  const out = new Set();
  for (const e of existing || []) {
    for (const k of Array.isArray(e?.flag?.fields) ? e.flag.fields : []) out.add(k);
  }
  return out;
}

/** The layers stored on the actor's effects, for a re-plan with a new level and no fetch. */
export function storedLayers(existing) {
  return (existing || []).map((e) => e?.flag?.layer).filter((l) => l && l.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
