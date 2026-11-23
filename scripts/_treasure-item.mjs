/**
 * How a Chronicle item page becomes a Draw Steel `treasure` item on a hero:
 * its category, kind, echelon, keywords, project and words. Chronicle owns
 * all of it, so these values are only ever written here and never read back;
 * Foundry sends back only quantity and equipped (item-sync.mjs).
 *
 * The item fields come from `GET /systems/:id/item-fields`, which serves them
 * only once the campaign's Items have switched to the system's fields. Each
 * field's `foundry_path`, `foundry_choices` and `foundry_format` say where and
 * how its value lands. A value with no Foundry equivalent is left out and
 * reported, never guessed; new fields start empty in Chronicle and stay unset
 * here.
 *
 * Pure: the CONFIG lists are passed in. See tools/test-treasure-item.mjs.
 */

import { resolveChoice } from './_creature-fields.mjs';

/** Formats this module converts for treasures; any other is skipped. */
export const TREASURE_FORMATS = new Set(['set', 'integer', 'treasure_keywords', 'html_section']);

const DESCRIPTION = 'system.description.value';

/** "Might, Reason, or Intuition" as its parts, without the joining words. */
export function splitList(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,;]|\bor\b|\band\b/i);
  return parts.map((p) => String(p).trim()).filter(Boolean);
}

/** A whole number only when the text is one: "45" and "45 (yields 1d3)" give 45; "30 or 45" gives null. */
export function soleInteger(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  const m = /^\s*(\d+)\s*(?:\([^()]*\))?\s*$/.exec(String(raw ?? ''));
  return m ? Number(m[1]) : null;
}

/** The leading number of an echelon or level: "2nd" and "2" give 2. */
function leadingInteger(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
  const m = /^\s*(\d+)/.exec(String(raw ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * One treasure keyword's key, looked up the way the treasure sheet lists
 * them: the shared keywords, then "Light Weapon" / "Medium Armor" in their
 * kind's list, then the item's kind, then its category's list, then any
 * equipment list.
 * @param {string} word
 * @param {object} equipment - CONFIG.DRAW_STEEL.equipment.
 * @param {string|null} category - the item's category key.
 * @param {string|null} kind - the item's kind key.
 * @returns {string|null}
 */
export function treasureKeyword(word, equipment, category, kind) {
  if (!equipment || typeof equipment !== 'object') return null;
  const text = String(word ?? '').trim();
  if (!text) return null;
  const shared = resolveChoice(text, equipment.keywords);
  if (shared) return shared;
  const suffixed = /^(.*\S)\s+(weapon|armor)$/i.exec(text);
  if (suffixed) {
    const key = resolveChoice(suffixed[1], equipment[suffixed[2].toLowerCase()]);
    if (key) return key;
  }
  const byCategory = { consumable: 'consumables', trinket: 'other' }[category];
  const lists = [kind, byCategory, 'consumables', 'other', 'implement', 'weapon', 'armor'];
  for (const list of lists) {
    if (!list) continue;
    const key = resolveChoice(text, equipment[list]);
    if (key) return key;
  }
  return null;
}

/** Chronicle's `{@category term|shown}` rule links as their words. */
function plainMarkup(text) {
  return String(text).replace(/\{@\w+\s+([^}|]+)(?:\|([^}]+))?\}/g, (_, term, shown) => (shown ?? term).trim());
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A field's plain text as HTML paragraphs: blank lines part paragraphs, a
 * single line break stays one. The text is escaped, so nothing in it is
 * read as markup.
 */
export function textHtml(raw) {
  const text = plainMarkup(raw).replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  return text.split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * The treasure data an item page gives, as dot paths, and the values left
 * out because Foundry has no equivalent. Words go in only when `showWords`
 * is true: an item page players cannot open in Chronicle gives its name only.
 * @param {object} p
 * @param {object} p.entity - Chronicle item page with fields_data.
 * @param {object[]} p.fields - Item field definitions from item-fields.
 * @param {(path: string) => object|null} p.choicesFor - CONFIG lookup.
 * @param {boolean} p.showWords - whether players may read the page.
 * @param {boolean} [p.clear] - also empty every mapped value the page lacks,
 *   for rewriting an item made earlier: a value taken off in Chronicle goes
 *   in Foundry too.
 * @returns {{update: Object<string, *>, unknown: string[]}}
 */
export function treasureUpdate({ entity, fields, choicesFor, showWords, clear = false }) {
  const update = {};
  const unknown = [];
  const mapped = (fields || []).filter((f) => f?.foundry_path && f.key);
  if (!showWords) return { update: clear ? emptied(mapped, update) : update, unknown };
  const data = entity?.fields_data && typeof entity.fields_data === 'object' ? entity.fields_data : {};
  const sections = [];

  // Category and kind first: the keyword lists depend on them.
  const keyOf = (path) => {
    const f = mapped.find((x) => x.foundry_path === path);
    if (!f) return null;
    return resolveChoice(data[f.key], f.foundry_choices ? choicesFor(f.foundry_choices) : null);
  };
  const category = keyOf('system.category');
  const kind = keyOf('system.kind');

  for (const f of mapped) {
    const raw = data[f.key];
    if (raw == null || raw === '' || (Array.isArray(raw) && !raw.length)) continue;
    const format = f.foundry_format;
    if (format && !TREASURE_FORMATS.has(format)) continue;
    const choices = f.foundry_choices ? choicesFor(f.foundry_choices) : null;
    if (f.foundry_choices && !choices) continue;

    if (format === 'html_section') {
      const body = textHtml(raw);
      if (body) sections.push(`<h4>${escapeHtml(f.label || f.key)}</h4>${body}`);
      continue;
    }
    if (format === 'treasure_keywords') {
      const keys = [];
      for (const word of splitList(raw)) {
        const key = treasureKeyword(word, choices, category, kind);
        if (key && !keys.includes(key)) keys.push(key);
        else if (!key) unknown.push(`${f.label || f.key}: ${word}`);
      }
      update[f.foundry_path] = keys;
      continue;
    }
    if (format === 'set') {
      const keys = [];
      for (const word of splitList(raw)) {
        const key = choices ? resolveChoice(word, choices) : word;
        if (key && !keys.includes(key)) keys.push(key);
        else if (!key) unknown.push(`${f.label || f.key}: ${word}`);
      }
      update[f.foundry_path] = keys;
      continue;
    }
    if (format === 'integer') {
      const n = f.foundry_path === 'system.echelon' ? leadingInteger(raw) : soleInteger(raw);
      if (n === null) unknown.push(`${f.label || f.key}: ${raw}`);
      else update[f.foundry_path] = n;
      continue;
    }
    if (choices) {
      const key = resolveChoice(raw, choices);
      if (key) update[f.foundry_path] = key;
      else unknown.push(`${f.label || f.key}: ${raw}`);
      continue;
    }
    update[f.foundry_path] = String(raw);
  }
  if (sections.length) update[DESCRIPTION] = sections.join('');
  return { update: clear ? emptied(mapped, update) : update, unknown };
}

/** update with every mapped path it lacks set to that field's empty value. */
function emptied(mapped, update) {
  const out = { ...update };
  for (const f of mapped) {
    if (f.foundry_path in out) continue;
    const format = f.foundry_format;
    if (format === 'set' || format === 'treasure_keywords') out[f.foundry_path] = [];
    else if (format === 'integer') out[f.foundry_path] = null;
    else out[f.foundry_path] = '';
  }
  return out;
}

/** A stable fingerprint of an update, so an unchanged page writes nothing. */
export function treasureSignature(update) {
  return JSON.stringify(Object.keys(update || {}).sort().map((k) => [k, update[k]]));
}

/**
 * Dot paths as a nested object, for a new item's data.
 * @param {Object<string, *>} update
 */
export function expandPaths(update) {
  const out = {};
  for (const [path, value] of Object.entries(update || {})) {
    const parts = path.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}
