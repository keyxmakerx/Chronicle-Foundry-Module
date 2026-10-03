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
 * Option marker on every document write sync itself makes. The Foundry hooks
 * ignore a write that carries it, so only sync's own echoes are dropped and a
 * GM edit made while sync is writing something else still pushes.
 */
export const SYNC_OPTIONS = Object.freeze({ chronicleSync: true });
