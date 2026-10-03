/**
 * Which Chronicle fields an actor edit touched, so a push sends only those
 * (Chronicle's PUT /entities/:id/fields is a partial merge: anything absent
 * keeps its stored value, including fields only Chronicle edits).
 *
 * Pure — see tools/test-actor-field-diff.mjs.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `b` into a copy of `a` (later change wins). */
export function mergeChanges(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeChanges(out[k], v) : v;
  return out;
}

/**
 * True when `change` (Foundry's nested diff) touches `path`: the path
 * itself, a value above it that was replaced wholesale, or anything below it.
 * @param {object} change
 * @param {string} path - Dot path, e.g. "system.attributes.hp.value".
 */
export function changeTouchesPath(change, path) {
  if (!path || !isObj(change)) return false;
  let cur = change;
  for (const key of path.split('.')) {
    // A non-object where the path continues means a parent was replaced
    // wholesale (e.g. hp: 5 over hp: {value}), which changes the path too.
    if (!isObj(cur)) return true;
    if (!(key in cur)) {
      // Foundry reports a deleted key as `-=key`.
      return `-=${key}` in cur;
    }
    cur = cur[key];
  }
  return true;
}

/**
 * Keys of the scalar mapped fields whose Foundry path `change` touches.
 * @param {object} change
 * @param {Array<{key: string, foundry_path?: string}>} mappedFields
 * @returns {string[]}
 */
export function touchedScalarKeys(change, mappedFields) {
  return mappedFields
    .filter((f) => f.foundry_path && changeTouchesPath(change, f.foundry_path))
    .map((f) => f.key);
}
