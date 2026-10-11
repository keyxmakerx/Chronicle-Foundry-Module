/**
 * How a Chronicle creature page becomes a Foundry NPC actor, and which values
 * Foundry may send back. Chronicle owns the stat block; Foundry owns only the
 * fields the preset lists in `foundry_pull_fields` (current Stamina and
 * conditions for Draw Steel), so the stat block update leaves those out and
 * nothing else is ever read back.
 *
 * Values convert by the field's `foundry_choices` (a list in the system's
 * CONFIG whose keys Foundry stores) and `foundry_format`. A value with no
 * Foundry equivalent is left out and reported, never guessed.
 *
 * Pure: the CONFIG lists are passed in. See tools/test-creature-fields.mjs.
 */

import { readPath, sameValue } from './_actor-apply-plan.mjs';

/** Formats this module converts; a field with any other format is skipped. */
export const CREATURE_FORMATS = new Set(['set', 'integer', 'size']);

const SIZE_LETTERS = new Set(['T', 'S', 'M', 'L']);

/** "fire giant" and "Fire Giant" both become "fireGiant". */
function camel(text) {
  const words = String(text).trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
}

/**
 * The key of `choices` that `value` names, by key or by label, ignoring case.
 * @param {*} value
 * @param {Object<string, {label?: string}>|null} choices
 * @returns {string|null}
 */
export function resolveChoice(value, choices) {
  if (value == null || !choices || typeof choices !== 'object') return null;
  const text = String(value).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const keys = Object.keys(choices);
  const byKey = keys.find((k) => k.toLowerCase() === lower);
  if (byKey) return byKey;
  const byLabel = keys.find((k) => String(choices[k]?.label ?? '').trim().toLowerCase() === lower);
  if (byLabel) return byLabel;
  const asCamel = camel(text);
  return keys.find((k) => k === asCamel) ?? null;
}

/** The first whole number in a value: 5, "5" and "5 damage" all give 5. */
function integerOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const m = /-?\d+/.exec(String(value ?? ''));
  return m ? Number(m[0]) : null;
}

/** Draw Steel size text ("1S", "2", "1 M") as Foundry's {value, letter}. */
function sizeOf(value) {
  const m = /^\s*(\d+)\s*([a-z])?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const size = { value: Number(m[1]) };
  if (size.value < 1) return null;
  const letter = m[2]?.toUpperCase();
  if (size.value === 1 && letter && SIZE_LETTERS.has(letter)) size.letter = letter;
  return size;
}

/**
 * One field's Foundry value, or `{skip}` with the reason it was left out.
 * @param {object} field - A creature field definition from Chronicle.
 * @param {*} raw - The page's value.
 * @param {(path: string) => object|null} choicesFor - CONFIG lookup.
 * @returns {{value: *}|{skip: string}}
 */
export function toFoundryValue(field, raw, choicesFor) {
  if (raw == null || raw === '') return { skip: 'empty' };
  const format = field.foundry_format;
  if (format && !CREATURE_FORMATS.has(format)) return { skip: `unknown format ${format}` };
  const choices = field.foundry_choices ? choicesFor(field.foundry_choices) : null;
  if (field.foundry_choices && !choices) return { skip: `no ${field.foundry_choices} in this system` };

  if (format === 'set') {
    const parts = Array.isArray(raw) ? raw : String(raw).split(',');
    const keys = [];
    const unknown = [];
    for (const part of parts) {
      const text = String(part).trim();
      if (!text) continue;
      const key = choices ? resolveChoice(text, choices) : text;
      if (key && !keys.includes(key)) keys.push(key);
      else if (!key) unknown.push(text);
    }
    return unknown.length ? { value: keys, unknown } : { value: keys };
  }
  if (format === 'integer') {
    const n = integerOf(raw);
    return n === null ? { skip: 'not a number' } : { value: n };
  }
  if (format === 'size') {
    const s = sizeOf(raw);
    return s ? { value: s } : { skip: 'not a size' };
  }
  if (choices) {
    const key = resolveChoice(raw, choices);
    return key ? { value: key } : { skip: `no ${field.foundry_choices} entry for "${raw}"`, unknown: [String(raw)] };
  }
  if (field.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n } : { skip: 'not a number' };
  }
  return { value: raw };
}

/**
 * The actor data a creature page gives: every mapped field except the ones
 * Foundry owns, as dot paths, plus the name.
 * @param {object} p
 * @param {object} p.entity - Chronicle entity with fields_data.
 * @param {object[]} p.fields - Creature field definitions.
 * @param {string[]} [p.pullKeys] - Fields Foundry owns.
 * @param {(path: string) => object|null} p.choicesFor
 * @returns {{update: Object<string, *>, unknown: string[]}}
 */
export function creatureUpdate({ entity, fields, pullKeys = [], choicesFor }) {
  const data = entity?.fields_data || {};
  const update = {};
  const unknown = [];
  for (const field of fields || []) {
    if (!field.foundry_path || field.foundry_collection) continue;
    if (field.foundry_writable === false || pullKeys.includes(field.key)) continue;
    const out = toFoundryValue(field, data[field.key], choicesFor);
    if (out.unknown) unknown.push(...out.unknown.map((u) => `${field.label || field.key}: ${u}`));
    if ('value' in out) update[field.foundry_path] = out.value;
  }
  if (entity?.name) update.name = entity.name;
  return { update, unknown };
}

/** Sets compare as sorted arrays; everything else as planActorApply does. */
function sameActorValue(current, value) {
  if (current instanceof Set) current = Array.from(current);
  if (Array.isArray(current) && Array.isArray(value)) {
    return JSON.stringify([...current].sort()) === JSON.stringify([...value].sort());
  }
  if (current && typeof current === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).every((k) => sameValue(current[k], value[k]));
  }
  return sameValue(current, value);
}

/** Only the entries of `update` that differ from the actor. */
export function planCreatureApply({ update, actor }) {
  const changes = {};
  for (const [path, value] of Object.entries(update || {})) {
    if (!sameActorValue(readPath(actor, path), value)) changes[path] = value;
  }
  return changes;
}

/**
 * The fields Foundry sends back for a creature: only `pullKeys`, read from the
 * actor. Sets become JSON arrays on string fields, like the hero adapter.
 * @param {object} actor
 * @param {object[]} fields
 * @param {string[]} pullKeys
 * @returns {Object<string, *>}
 */
export function creaturePull(actor, fields, pullKeys) {
  const out = {};
  for (const field of fields || []) {
    if (!pullKeys?.includes(field.key) || !field.foundry_path) continue;
    let value = readPath(actor, field.foundry_path);
    if (value instanceof Set) value = Array.from(value).sort();
    // An absent path is not a cleared value; sending null would clear it.
    if (value === undefined) continue;
    if (value != null && typeof value === 'object' && field.type === 'string') value = JSON.stringify(value);
    out[field.key] = value;
  }
  return out;
}

/**
 * Whether the director let Foundry send this creature's Stamina and
 * conditions back: the page's `foundry` system state, GM half.
 * @param {object|null} state - The system-state response, or null.
 * @returns {boolean}
 */
export function sendBackOn(state) {
  return state?.gm?.sendBack === true;
}

/**
 * The pulled fields that differ from what Chronicle last had, so one change
 * never sends the other Foundry-owned fields over newer Chronicle values.
 * @param {Object<string, *>} pulled - creaturePull's result.
 * @param {Object<string, *>} known - The page's last known values.
 * @returns {Object<string, *>}
 */
export function changedPull(pulled, known) {
  const out = {};
  for (const [key, value] of Object.entries(pulled || {})) {
    if (!sameValue(known?.[key], value)) out[key] = value;
  }
  return out;
}

/**
 * Foundry-owned values to write from the page: all of them for a new actor,
 * so it does not start from the system's default, or only `onlyKeys` (the
 * ones someone changed in Chronicle). Status sets are skipped: conditions
 * come from effects, not a stored field.
 */
export function seedPull({ entity, fields, pullKeys = [], choicesFor, onlyKeys = null }) {
  const data = entity?.fields_data || {};
  const seed = {};
  for (const field of fields || []) {
    if (!pullKeys.includes(field.key) || !field.foundry_path?.startsWith('system.')) continue;
    if (onlyKeys && !onlyKeys.includes(field.key)) continue;
    const out = toFoundryValue(field, data[field.key], choicesFor);
    if ('value' in out) seed[field.foundry_path] = out.value;
  }
  return seed;
}
