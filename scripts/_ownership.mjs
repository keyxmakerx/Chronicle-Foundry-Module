/**
 * Chronicle Sync - Ownership mapping helper
 *
 * Single source of truth for translating a Chronicle doc's visibility into a
 * Foundry ownership `default` level, honoring the operator's dashboard
 * Permissions controls:
 *
 *   - `defaultOwnership` — the level players get for player-visible synced
 *     docs (None / Limited / Observer / Owner). Registered default is OBSERVER,
 *     which matches the pre-FM-SYNC-HARDENING hardcoded behavior.
 *   - `dmOnlyHidden` — when ON (default), a DM-only / private Chronicle doc is
 *     hidden from players (ownership NONE). When OFF, the operator has opted to
 *     surface DM-only content, so it lands at `defaultOwnership` instead.
 *
 * Security posture: fail CLOSED. Any ambiguity resolves toward LESS player
 * visibility, never more. See FM-SYNC-HARDENING §1 (wire the settings) + §3
 * (custom-visibility error path fails to NONE, enforced in journal-sync).
 *
 * Both `journal-sync.mjs` (_buildOwnership) and `note-sync.mjs`
 * (_buildNoteOwnership) consume this so the two paths can't drift.
 */

import { getSetting } from './settings.mjs';

/**
 * Resolve Foundry's ownership-level constants. Reads the `CONST` global at
 * call time (so it tracks Foundry) with a static fallback for non-Foundry
 * (test) contexts where `CONST` may be stubbed or absent.
 * @returns {{NONE: number, LIMITED: number, OBSERVER: number, OWNER: number}}
 */
function ownershipLevels() {
  const fromFoundry =
    typeof CONST !== 'undefined' && CONST?.DOCUMENT_OWNERSHIP_LEVELS;
  return fromFoundry || { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
}

/**
 * The operator-configured default ownership level for player-visible synced
 * documents, clamped to a valid Foundry level. Out-of-range / garbage values
 * fall back to OBSERVER (the historical default) rather than failing open.
 * @returns {number} A valid Foundry ownership level (0-3).
 */
export function configuredDefaultOwnership() {
  const L = ownershipLevels();
  const value = getSetting('defaultOwnership');
  // A nullish/missing setting falls back to the historical default rather
  // than silently coercing to 0 (NONE) — never hide more than configured.
  if (value === null || value === undefined || value === '') return L.OBSERVER;
  const raw = Number(value);
  if (!Number.isInteger(raw) || raw < L.NONE || raw > L.OWNER) {
    return L.OBSERVER;
  }
  return raw;
}

/**
 * Map a simple (is_private-style) Chronicle visibility to a Foundry ownership
 * `default` level, honoring `dmOnlyHidden` + `defaultOwnership`.
 *
 * @param {boolean} isPrivate - True if the doc is DM-only / private on Chronicle.
 * @returns {number} The Foundry ownership level for the `default` key.
 */
export function defaultLevelForVisibility(isPrivate) {
  const L = ownershipLevels();
  const visibleLevel = configuredDefaultOwnership();

  if (isPrivate) {
    // DM-only content. Hide from players when dmOnlyHidden is on (default);
    // otherwise the operator has chosen to surface it at the default level.
    return getSetting('dmOnlyHidden') ? L.NONE : visibleLevel;
  }

  // Player-visible content gets the configured default level.
  return visibleLevel;
}
