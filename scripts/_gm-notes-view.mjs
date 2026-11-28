/**
 * What the GM's sheet shows in a GM-only box, such as Draw Steel's Director
 * Notes. Sync never saves those notes on the actor, where every player who
 * can open the sheet receives them; the GM's own client reads them from
 * Chronicle when the sheet draws and shows them there, unsaved
 * (gm-notes-view.mjs). Pure; see tools/test-gm-notes-view.mjs.
 */

import { clearableGmFields } from './_gm-field-clear.mjs';
import { readPath } from './_actor-apply-plan.mjs';

/** Controls a sheet's form would collect or that take typing. They go
 * whole; elements that only carry a form attribute keep their words and lose
 * the attribute (see droppedAttribute). */
export const FORM_PARTS = 'input, select, textarea, button, form, option, output, fieldset, prose-mirror';

/** Attributes left on no element of the notes: a name, form or
 * contenteditable would put it in the form, and Foundry reads data-* ones
 * (data-edit is saved with the form as that field, data-action runs a sheet
 * action). */
function droppedAttribute(name) {
  const n = String(name).toLowerCase();
  return n.startsWith('data-') || n.startsWith('on') || n === 'name' || n === 'form' || n === 'contenteditable';
}

/**
 * The notes as HTML for the GM's sheet, or null when they can only be shown
 * as text. The view writes into the live page, where nothing sanitizes
 * afterwards, so a missing or failing sanitizer means text, never raw HTML;
 * the operator's skip-sanitizing setting does not apply here.
 * @param {string} html
 * @param {((html: string) => string)|null} clean - Foundry's cleanHTML
 * @returns {string|null}
 */
export function notesHtml(html, clean) {
  if (typeof clean !== 'function') return null;
  try {
    const out = clean(String(html ?? ''));
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * The notes as plain words, for when they can't be shown as HTML.
 * @param {string} html
 * @returns {string}
 */
export function notesPlainText(html) {
  return String(html ?? '')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove from parsed notes every control a sheet's form would collect, and
 * from every other element each attribute that would join it to the form or
 * that Foundry acts on, so the notes inside the sheet's fieldset can never be
 * saved with it or set off a sheet action.
 * @param {{querySelectorAll: (sel: string) => Iterable<object>}} root
 * @returns {number} how many controls were removed
 */
export function stripFormParts(root) {
  let n = 0;
  for (const el of Array.from(root.querySelectorAll(FORM_PARTS))) {
    el.remove();
    n += 1;
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes ?? [])) {
      if (droppedAttribute(attr.name)) el.removeAttribute(attr.name);
    }
  }
  return n;
}

/**
 * The boxes to fill: each GM-only field the system maps to a path on the
 * actor's own data.
 * @param {Array<object>|null|undefined} fields - field defs from Chronicle
 * @returns {Array<{key: string, path: string, schemaPath: string}>}
 */
export function gmNotesBoxes(fields) {
  return clearableGmFields(fields)
    .filter((f) => f.foundry_clear_path.startsWith('system.') && f.foundry_clear_path.length > 7)
    .map((f) => ({ key: f.key, path: f.foundry_clear_path, schemaPath: f.foundry_clear_path.slice(7) }));
}

/**
 * The notes Chronicle holds for one box, read from the page fetched with the
 * GM's key.
 * @param {object|null|undefined} entity
 * @param {string} key
 * @returns {string} the stored text, or '' when there is none
 */
export function gmNotesText(entity, key) {
  const data = entity?.fields_data;
  if (!data || typeof data !== 'object') return '';
  const v = data[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Whether the actor still holds text of its own at the box's path (typed
 * there in Foundry). That text stays visible under the notes, with a line
 * saying players can read it, rather than being hidden from the GM.
 * @param {object} actor
 * @param {string} path
 * @returns {boolean}
 */
export function holdsOwnText(actor, path) {
  const v = readPath(actor, path);
  return typeof v === 'string' && v.replace(/<[^>]*>/g, '').trim() !== '';
}

/**
 * A short-lived cache of page reads, so a sheet that redraws several times
 * on opening reads Chronicle once.
 * @param {(id: string) => Promise<object|null>} read
 * @param {{ttlMs?: number, now?: () => number}} [opts]
 */
export function pageReader(read, { ttlMs = 10000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return {
    get(id) {
      const hit = cache.get(id);
      if (hit && now() - hit.at < ttlMs) return hit.promise;
      const promise = Promise.resolve().then(() => read(id));
      cache.set(id, { at: now(), promise });
      promise.catch(() => { if (cache.get(id)?.promise === promise) cache.delete(id); });
      return promise;
    },
    forget(id) { cache.delete(id); },
  };
}
