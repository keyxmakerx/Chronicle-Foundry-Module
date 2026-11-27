/**
 * Fills the item sync makes for a campaign's own pick-list entry (a homebrew
 * ancestry, kit...) from that entry, and plans refreshing it when the entry
 * changes in Chronicle. PURE: no Foundry globals.
 *
 * Entries come from `GET /system-entries`, which only ever returns the player
 * view, so the text is safe for an item players can open. A description that
 * still holds GM-only content is refused anyway and the item stays name-only.
 */
import { FLAG_SCOPE } from './constants.mjs';
import { hasClearSecrets } from './_gm-secrets.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';
import { entryTextHTML } from './_entry-text.mjs';

/**
 * How an item is filled from its entry: the description's HTML, since 3 the
 * system's mapped values, and since 4 the effect its numbers give the hero.
 * Raised when that changes, so items filled the old way are rewritten even
 * though their entry hasn't.
 */
export const ENTRY_TEXT_FORMAT = 4;

/** Flag on the one Active Effect sync puts on an item it made. */
export const ENTRY_EFFECT_FLAG = 'entryEffect';

/** The Active Effect change types a system may map an entry property to. */
const EFFECT_TYPES = new Set(['override', 'add', 'upgrade']);

/** Longest text a `text` mapping writes; an entry property is a short value. */
const MAX_ENTRY_TEXT = 1000;

/**
 * A mapped path: under the item's system data, at most eight segments, each
 * starting with a letter. Chronicle checks the same; this is the module's
 * own check on what it writes into a Foundry document.
 */
const ENTRY_FIELD_PATH = /^system(\.[A-Za-z][A-Za-z0-9_]*){1,8}$/;
// Names an object path could use to reach a shared prototype.
const RESERVED_SEGMENTS = new Set(['constructor', 'prototype']);

/** True when a manifest path may be written onto an item. */
export function usableEntryPath(path) {
  return typeof path === 'string' && ENTRY_FIELD_PATH.test(path)
    && !path.split('.').some((seg) => RESERVED_SEGMENTS.has(seg));
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

const escapeHTML = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** "signature_trait" -> "Signature trait". */
function label(key) {
  const words = String(key).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A list property's items, shaped like a package entry's traits. */
function listHTML(key, items) {
  const rows = items
    .filter((it) => it && typeof it === 'object' && it.name)
    .map((it) => {
      const cost = Number.isInteger(it.cost) ? ` (${it.cost} ${it.cost === 1 ? 'point' : 'points'})` : '';
      const desc = it.description ? `: ${escapeHTML(it.description)}` : '';
      return `<li><strong>${escapeHTML(it.name)}</strong>${cost}${desc}</li>`;
    });
  return rows.length ? `<h3>${escapeHTML(label(key))}</h3><ul>${rows.join('')}</ul>` : '';
}

/**
 * The item description for an entry: its own text (or summary), then its
 * details. The description is Markdown or HTML (`_entry-text.mjs`), cleaned
 * again here as at every other Chronicle ingress; the scalars and list items
 * are plain text and escaped.
 * @param {object} entry - one `GET /system-entries` row
 * @param {{mentionId?: (name: string) => string|null}} [opts] - see `mentionLookup`
 * @returns {string} HTML
 */
export function entryDescriptionHTML(entry, opts = {}) {
  const parts = [];
  const desc = typeof entry?.description === 'string' ? entryTextHTML(entry.description, opts) : '';
  if (desc) parts.push(_sanitizeIncomingHTML(desc));
  else if (entry?.summary) parts.push(`<p>${escapeHTML(entry.summary)}</p>`);

  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  const scalars = [];
  const lists = [];
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) lists.push(listHTML(key, value));
    else if (['string', 'number', 'boolean'].includes(typeof value) && value !== '') {
      scalars.push(`<li><strong>${escapeHTML(label(key))}:</strong> ${escapeHTML(value)}</li>`);
    }
  }
  if (scalars.length) parts.push(`<ul>${scalars.join('')}</ul>`);
  return parts.concat(lists.filter(Boolean)).join('');
}

/** A number, or a numeric text such as "+2"; null for anything else. */
function entryNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^\s*[+-]?\d+(\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
}

/** "+2/+2/+4" as [2, 2, 4], one number as three; null for anything else. */
function entryTiers(value) {
  const one = entryNumber(value);
  if (one !== null) return [one, one, one];
  if (typeof value !== 'string') return null;
  const parts = value.split('/').map(entryNumber);
  return parts.length === 3 && parts.every((n) => n !== null) ? parts : null;
}

/**
 * The item values an entry's properties give, as dotted paths, from the
 * field's `foundry_entry_fields` (Chronicle checked each path is under
 * `system`; checked again here). A property that is absent or doesn't read in
 * its format is left out, so the item keeps the system's default for it.
 * A mapping marked `once` is left out of a refresh: the system counted it
 * into the hero when the item was made (a career's renown) and takes the
 * item's amount back when it goes, so a rewrite would unbalance the hero.
 * @param {object} entry - one `GET /system-entries` row
 * @param {Record<string, {path: string, format: string, once?: boolean}>} [entryFields]
 * @param {{refresh?: boolean}} [opts]
 * @returns {Record<string, number|string>}
 */
export function entryItemValues(entry, entryFields, { refresh = false } = {}) {
  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  const out = {};
  for (const [key, def] of Object.entries(entryFields ?? {})) {
    const path = def?.path;
    if (!usableEntryPath(path) || !Object.hasOwn(props, key)) continue;
    if (refresh && def.once === true) continue;
    const value = props[key];
    if (def.format === 'number') {
      const n = entryNumber(value);
      if (n !== null) out[path] = n;
    } else if (def.format === 'tiers') {
      const tiers = entryTiers(value);
      if (tiers) tiers.forEach((n, i) => { out[`${path}.tier${i + 1}`] = n; });
    } else if (def.format === 'text' && ['string', 'number'].includes(typeof value)) {
      out[path] = String(value).trim().slice(0, MAX_ENTRY_TEXT);
    }
  }
  return out;
}

/** "1M" or "2" as {value, letter}; the letter only for size 1. Null otherwise. */
function entrySize(value) {
  const m = /^\s*(\d+)\s*([TSML])?\s*$/i.exec(String(value ?? ''));
  if (!m || Number(m[1]) < 1) return null;
  const size = Number(m[1]);
  return { value: size, letter: size === 1 && m[2] ? m[2].toUpperCase() : null };
}

/**
 * The Active Effect changes an entry's properties give the hero who has its
 * item, from the field's `foundry_entry_effects` (Chronicle checked each
 * mapping; checked again here). A property that is absent or doesn't read is
 * left out, so the hero keeps what they had.
 * @param {object} entry - one `GET /system-entries` row
 * @param {Record<string, {path: string, type: string, format: string}>} [entryEffects]
 * @returns {Array<{key: string, type: string, value: number|string, phase: string, priority: number|null}>}
 */
export function entryEffectChanges(entry, entryEffects) {
  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  const out = [];
  // An upgrade goes first, as the system's own ancestries set theirs, so a
  // bonus added on top (a kit's speed) adds to the ancestry's number.
  const change = (key, type, value) => out.push({ key, type, value, phase: 'initial', priority: type === 'upgrade' ? 5 : null });
  // Sorted so the same entry always gives the same changes.
  for (const [key, def] of Object.entries(entryEffects ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!usableEntryPath(def?.path) || !EFFECT_TYPES.has(def.type) || !Object.hasOwn(props, key)) continue;
    if (def.format === 'number') {
      const n = entryNumber(props[key]);
      if (n !== null) change(def.path, def.type, n);
    } else if (def.format === 'size' && def.type === 'override') {
      const size = entrySize(props[key]);
      if (!size) continue;
      change(`${def.path}.value`, 'override', size.value);
      if (size.letter) change(`${def.path}.letter`, 'override', size.letter);
    }
  }
  return out;
}

/**
 * The effect an item sync made carries, so the hero has its numbers while
 * the item is on the sheet and loses them when it goes.
 * @param {object} entry
 * @param {Array<object>} changes - from `entryEffectChanges`
 */
export function entryEffectData(entry, changes) {
  return {
    name: String(entry?.name ?? '').trim() || 'Chronicle',
    type: 'base',
    transfer: true,
    disabled: false,
    system: { changes },
    flags: { [FLAG_SCOPE]: { chronicleMade: true, [ENTRY_EFFECT_FLAG]: true } },
  };
}

/**
 * The hero's paths that the fields' effect mappings change, as a pending
 * actor change touching each one, or null when there are none. Foundry fires
 * no actor update when an item's effect changes, so sync pushes these itself
 * for Chronicle to show the hero's new numbers.
 * @param {Array<object|undefined>} mappings - `foundry_entry_effects` of the fields whose item changed
 * @returns {object|null}
 */
export function effectPathsChange(mappings) {
  const out = Object.create(null);
  let any = false;
  for (const map of mappings) {
    for (const def of Object.values(map ?? {})) {
      if (!usableEntryPath(def?.path)) continue;
      let node = out;
      const keys = def.path.split('.');
      for (const k of keys.slice(0, -1)) {
        if (!Object.hasOwn(node, k) || typeof node[k] !== 'object') node[k] = Object.create(null);
        node = node[k];
      }
      node[keys[keys.length - 1]] = true;
      any = true;
    }
  }
  return any ? structuredClone(out) : null;
}

/** The effect sync put on this item, or null. */
function madeEffect(item) {
  const effects = item?.effects?.contents ?? (Array.isArray(item?.effects) ? item.effects : []);
  return effects.find((e) => e?.flags?.[FLAG_SCOPE]?.[ENTRY_EFFECT_FLAG]) ?? null;
}

/** Dotted values as nested objects, for an item that doesn't exist yet. */
function nestValues(values) {
  // Built on prototype-less objects and own keys only, so no path can reach
  // an inherited property; cloned at the end because Foundry expects plain
  // objects.
  const out = Object.create(null);
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.');
    let node = out;
    for (const k of keys.slice(0, -1)) {
      if (!Object.hasOwn(node, k) || typeof node[k] !== 'object') node[k] = Object.create(null);
      node = node[k];
    }
    node[keys[keys.length - 1]] = value;
  }
  return structuredClone(out);
}

/** The entry for this field and name, or null. */
export function findEntry(entries, name) {
  const want = norm(name);
  if (!want || !Array.isArray(entries)) return null;
  return entries.find((e) => e && norm(e.name) === want) ?? null;
}

/**
 * The fields to write for an entry: the description, the values its
 * properties give (`entryItemValues`), the effect they give the hero
 * (`entryEffectChanges`), and flags that record which entry version filled
 * it. Null when the description is not safe to save, so the caller keeps the
 * item name-only.
 * @param {object} entry
 * @param {{mentionId?: (name: string) => string|null, entryFields?: object, entryEffects?: object}} [opts]
 * @returns {{system: object, flags: object, effects?: object[]}|null}
 */
export function entryItemFill(entry, opts = {}) {
  if (!entry) return null;
  const html = entryDescriptionHTML(entry, opts);
  if (hasClearSecrets(html)) return null;
  const { system: mapped = {} } = nestValues(entryItemValues(entry, opts.entryFields));
  const changes = entryEffectChanges(entry, opts.entryEffects);
  return {
    ...(changes.length ? { effects: [entryEffectData(entry, changes)] } : {}),
    system: { ...mapped, description: { value: html } },
    flags: {
      [FLAG_SCOPE]: {
        chronicleMade: true,
        entrySlug: entry.slug ?? '',
        entryUpdatedAt: entry.updatedAt ?? '',
        entryFormat: ENTRY_TEXT_FORMAT,
      },
    },
  };
}

/**
 * Items sync made earlier whose entry has changed since (or that were made
 * before entries could fill them, or filled by an older `ENTRY_TEXT_FORMAT`). Only the first item of the type is looked
 * at, the one the adapter reads, and only while its name still matches the
 * entry: a renamed pick is the swap planner's job.
 * @param {object} args
 * @param {Array<{id: string, name: string, type: string, flags?: object}>} args.items
 * @param {Array<{fieldKey: string, itemType: string}>} args.fields - identity fields
 * @param {object} args.fieldsData - Chronicle `fields_data`
 * @param {Record<string, Array<object>>} args.entriesByField
 * @param {(name: string) => string|null} [args.mentionId] - see `mentionLookup`
 * @param {Record<string, object>} [args.entryFieldsByField] - each field's `foundry_entry_fields`
 * @param {Record<string, object>} [args.entryEffectsByField] - each field's `foundry_entry_effects`
 * @returns {Array<{itemId: string, fieldKey: string, update: object, effect?: object}>} `effect`
 *   is `{create}`, `{update}` or `{remove}` for the item's own effect, when it changes
 */
export function planEntryRefresh({ items, fields, fieldsData, entriesByField, mentionId, entryFieldsByField, entryEffectsByField }) {
  const list = Array.isArray(items) ? items : [];
  const data = fieldsData && typeof fieldsData === 'object' ? fieldsData : {};
  const out = [];
  for (const { fieldKey, itemType } of fields ?? []) {
    const first = list.find((it) => it && it.type === itemType);
    const flags = first?.flags?.[FLAG_SCOPE];
    if (!flags?.chronicleMade) continue;
    if (typeof data[fieldKey] !== 'string' || norm(data[fieldKey]) !== norm(first.name)) continue;
    const entry = findEntry(entriesByField?.[fieldKey], first.name);
    if (!entry) continue;
    const current = flags.entryFormat === ENTRY_TEXT_FORMAT;
    if (current && flags.entryUpdatedAt && flags.entryUpdatedAt === entry.updatedAt) continue;
    const entryFields = entryFieldsByField?.[fieldKey];
    const entryEffects = entryEffectsByField?.[fieldKey];
    const fill = entryItemFill(entry, { mentionId, entryFields, entryEffects });
    if (!fill) continue;
    out.push({
      itemId: first.id,
      fieldKey,
      ...refreshEffect(first, entry, entryEffectChanges(entry, entryEffects)),
      update: {
        _id: first.id,
        ...entryItemValues(entry, entryFields, { refresh: true }),
        'system.description.value': fill.system.description.value,
        [`flags.${FLAG_SCOPE}.entrySlug`]: fill.flags[FLAG_SCOPE].entrySlug,
        [`flags.${FLAG_SCOPE}.entryUpdatedAt`]: fill.flags[FLAG_SCOPE].entryUpdatedAt,
        [`flags.${FLAG_SCOPE}.entryFormat`]: ENTRY_TEXT_FORMAT,
      },
    });
  }
  return out;
}

/** How the item's own effect changes: made, rewritten, taken off, or not at all. */
function refreshEffect(item, entry, changes) {
  const had = madeEffect(item);
  if (!had) return changes.length ? { effect: { create: entryEffectData(entry, changes) } } : {};
  if (!changes.length) return { effect: { remove: had.id ?? had._id } };
  const name = entryEffectData(entry, changes).name;
  // An entry edit that moves no number (its summary) rewrites nothing, so the
  // hero isn't pushed back to Chronicle for it.
  if (had.name === name && sameChanges(had.system?.changes, changes)) return {};
  return { effect: { update: { _id: had.id ?? had._id, name, 'system.changes': changes } } };
}

/** Whether an effect's stored changes are these, ignoring how Foundry stores values. */
function sameChanges(stored, changes) {
  const list = Array.isArray(stored) ? stored : [];
  const flat = (c) => [c?.key, c?.type, String(c?.value ?? ''), c?.phase ?? 'initial', c?.priority ?? null].join('\u0000');
  return list.length === changes.length && list.every((c, i) => flat(c) === flat(changes[i]));
}
