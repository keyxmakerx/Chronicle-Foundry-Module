/**
 * What the GM's sheet shows in a GM-only box, such as Draw Steel's Director
 * Notes. Sync never saves those notes on the actor, where every player who
 * can open the sheet receives them; the GM's own client reads them from
 * Chronicle when the sheet draws and shows them there, unsaved
 * (gm-notes-view.mjs). Pure; see tools/test-gm-notes-view.mjs.
 */

import { clearableGmFields } from './_gm-field-clear.mjs';
import { readPath } from './_actor-apply-plan.mjs';

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
