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

// A Chronicle older than the version header lists no such name in its CORS
// allow-list, so the browser refuses every preflight that carries it. Once a
// request fails that way the header is dropped for the rest of the session.
let refusedByServer = false;

/** Stop sending the header for this session (an older Chronicle refused it). */
export function markModuleVersionHeaderRefused() { refusedByServer = true; }

/** Test hook: forget a refusal. */
export function resetModuleVersionHeaderRefusal() { refusedByServer = false; }

/**
 * Header map for the running module; `{}` if `game` or the version is
 * unavailable, or the server refused the header earlier this session.
 */
export function moduleVersionHeaders() {
  if (refusedByServer) return {};
  let version;
  try { version = globalThis.game?.modules?.get(MODULE_ID)?.version; } catch { /* not ready */ }
  return buildModuleVersionHeaders(version);
}

/**
 * Whether a fetch failure should be retried once without the version header:
 * a network-level TypeError (what a refused CORS preflight looks like) on a
 * request that carried it.
 *
 * @param {unknown} err - What fetch threw.
 * @param {Object<string,string>} headers - The headers that request sent.
 */
export function shouldRetryWithoutVersionHeader(err, headers) {
  return !refusedByServer && err instanceof TypeError && !!headers && MODULE_VERSION_HEADER in headers;
}
