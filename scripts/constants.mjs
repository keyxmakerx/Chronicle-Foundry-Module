/**
 * Chronicle Sync - Shared Constants
 *
 * Centralizes magic strings and flag namespaces used across sync modules
 * to avoid duplication and reduce the risk of typos.
 */

/** Foundry flag namespace for all Chronicle Sync data stored on documents. */
export const FLAG_SCOPE = 'chronicle-sync';

/** Module ID used for Foundry settings registration. */
export const MODULE_ID = 'chronicle-sync';

/** Module flag that marks the one hidden journal entry holding problem reports. */
export const REPORT_STORE_FLAG = 'problemReportsStore';

/**
 * Options for every document write sync itself makes, marked so the Foundry
 * hooks ignore it: only sync's own echoes are dropped, and a GM edit made
 * while sync is writing something else still pushes. A fresh object each
 * call, because Foundry 14 writes into the options it is given (`parent`,
 * `action`), which throws on a frozen object and would leak between writes
 * on a shared one. `tools/test-sync-options.mjs`.
 * @param {object} [extra] - More options for this one write.
 * @returns {object}
 */
export function syncOptions(extra) {
  return { chronicleSync: true, ...extra };
}

/** Write option marking an actor or embedded-item change as applied from Chronicle, so the update hooks do not push it back. */
export const APPLY_OPTION = 'chronicleSyncApply';
