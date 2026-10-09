/**
 * Which of a Chronicle character's mapped values an actor actually needs.
 * Writing only the differences means an echo of what the actor already
 * holds writes nothing and the write names just the fields that moved.
 * It does not guard against a stale Chronicle value: that differs from
 * the actor's, so it is still written.
 *
 * Pure — see tools/test-actor-apply-plan.mjs.
 */

/** Value at a dot path (`system.hero.primary.value`), or undefined. */
export function readPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Numbers and numeric strings compare by value; anything else deeply. */
export function sameValue(a, b) {
  if (a === b) return true;
  const numeric = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  if (numeric(a) && numeric(b) && (typeof a === 'number' || typeof b === 'number')) {
    return Number(a) === Number(b);
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

/**
 * @param {object} p
 * @param {Object<string, *>} p.update - Dot-path -> value the adapter built from the entity.
 * @param {object} p.actor - The actor (or any object with the same nested shape).
 * @returns {Object<string, *>} Only the entries whose value differs from the actor's.
 */
export function planActorApply({ update, actor }) {
  const changes = {};
  for (const [path, value] of Object.entries(update || {})) {
    if (!sameValue(readPath(actor, path), value)) changes[path] = value;
  }
  return changes;
}
