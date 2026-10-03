/**
 * Builds the header that tells Chronicle which module release is calling, so
 * the server can show owners a mismatch instead of guessing from behavior.
 * The builder is pure; `moduleVersionHeaders()` reads the live manifest version.
 * Pinned by `tools/test-module-version-header.mjs`.
 */

import { MODULE_ID } from './constants.mjs';

export const MODULE_VERSION_HEADER = 'X-Chronicle-Module-Version';

/**
 * @param {unknown} version - Manifest version, if known.
 * @returns {Object<string,string>} One-entry header map, or `{}` when the
 *   version is unavailable (the header is omitted rather than sent empty).
 */
export function buildModuleVersionHeaders(version) {
  if (typeof version !== 'string') return {};
  const v = version.trim();
  // Header values must be a single visible-ASCII line.
  if (!v || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(v)) return {};
  return { [MODULE_VERSION_HEADER]: v };
}

/** Header map for the running module; `{}` if `game` or the version is unavailable. */
export function moduleVersionHeaders() {
  let version;
  try { version = globalThis.game?.modules?.get(MODULE_ID)?.version; } catch { /* not ready */ }
  return buildModuleVersionHeaders(version);
}
