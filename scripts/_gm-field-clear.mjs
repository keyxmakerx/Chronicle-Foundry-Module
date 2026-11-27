/**
 * Clearing GM-only values an earlier sync wrote onto a hero.
 *
 * Chronicle sends a GM-only character field with no Foundry mapping, only
 * the path the system manifest names for it (`foundry_clear_path`). Sync
 * never writes there, but a world synced before that may still hold the GM's
 * text on the actor, where every player who can open the sheet reads it.
 *
 * The value is cleared only when it is still the text Chronicle holds for
 * that field, so the GM's own writing typed in Foundry is never erased. Any
 * other text left at such a path is reported, for the GM to check by hand.
 * Pure; see tools/test-gm-field-clear.mjs.
 */

import { readPath } from './_actor-apply-plan.mjs';

/**
 * The GM-only fields that name a path to clear.
 * @param {Array<object>|null|undefined} fields - field defs from Chronicle.
 * @returns {Array<{key: string, label?: string, foundry_clear_path: string}>}
 */
export function clearableGmFields(fields) {
  return (Array.isArray(fields) ? fields : []).filter(
    (f) => f?.gm_only && typeof f.key === 'string' && f.key
      && typeof f.foundry_clear_path === 'string' && f.foundry_clear_path,
  );
}

/** Text with its spacing evened out, so a stored copy still matches. */
function comparable(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * What to clear on one hero.
 *
 * @param {object} p
 * @param {object} p.actor - the Foundry actor (or its plain data).
 * @param {object|null} p.entity - the Chronicle page, read with the Owner key.
 * @param {Array<object>} p.fields - clearableGmFields of the adapter.
 * @returns {{update: Object<string, string>, kept: string[], keptMark: string}}
 *   update empties each path still holding Chronicle's text; kept names the
 *   fields whose path holds other text, and keptMark fingerprints that text
 *   so the GM is told about it once, not on every connect.
 */
export function planGmFieldClear({ actor, entity, fields }) {
  const update = {};
  const kept = [];
  const keptText = [];
  const data = entity?.fields_data && typeof entity.fields_data === 'object' ? entity.fields_data : {};
  for (const f of clearableGmFields(fields)) {
    const here = comparable(readPath(actor, f.foundry_clear_path));
    if (!here) continue;
    if (here === comparable(data[f.key])) {
      update[f.foundry_clear_path] = '';
    } else {
      kept.push(f.label || f.key);
      keptText.push(`${f.foundry_clear_path}\n${here}`);
    }
  }
  return { update, kept, keptMark: keptText.length ? fingerprint(keptText.join('\n')) : '' };
}

/**
 * A short fingerprint of text (FNV-1a), stored on the actor in place of the
 * text itself, which must not be copied anywhere players can read.
 * @param {string} text
 * @returns {string}
 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Whether any clearable path on the actor holds text, so the page is worth
 * fetching.
 * @param {object} actor
 * @param {Array<object>} fields
 * @returns {boolean}
 */
export function holdsGmFieldText(actor, fields) {
  return clearableGmFields(fields).some((f) => comparable(readPath(actor, f.foundry_clear_path)) !== '');
}
