/**
 * The update keys that remove flags. Foundry 14 replaced the `-=key: null`
 * form with a ForcedDeletion operator, warns on every use of the old one,
 * and drops it in 16. Older Foundry (and the Node tests, which have no
 * `foundry`) keep the `-=` form. `tools/test-flag-removal.mjs`.
 */

/**
 * @param {string} scope - The flag scope, normally the module id.
 * @param {...string} keys - Flags to remove.
 * @returns {Record<string, *>} entries to spread into a document update.
 */
export function flagRemoval(scope, ...keys) {
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  const out = {};
  for (const key of keys) {
    if (typeof ForcedDeletion === 'function') out[`flags.${scope}.${key}`] = new ForcedDeletion();
    else out[`flags.${scope}.-=${key}`] = null;
  }
  return out;
}

/**
 * Whether `change` (an update diff seen in a hook) removes `key`, in either
 * form.
 * @param {object} change
 * @param {string} key
 * @returns {boolean}
 */
export function removesKey(change, key) {
  if (!change || typeof change !== 'object') return false;
  if (`-=${key}` in change) return true;
  const ForcedDeletion = globalThis.foundry?.data?.operators?.ForcedDeletion;
  return typeof ForcedDeletion === 'function' && change[key] instanceof ForcedDeletion;
}
