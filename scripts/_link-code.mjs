/**
 * Linking a player's Chronicle account by a code they type in Foundry. The
 * player asks Chronicle for the code while signed in; the GM's client
 * redeems it (`POST /sync/link-code`) and links the Foundry user who sent
 * it. Pure; see tools/test-link-code.mjs.
 */

/** Socket message type for a code sent to the GM's client and its answer. */
export const LINK_MESSAGE = 'chronicle-link';

const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * The code as Chronicle stores it, or null when it cannot be one: spaces and
 * dashes dropped, upper-cased, six characters of Chronicle's alphabet.
 * @param {any} raw
 * @returns {string|null}
 */
export function cleanCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ALPHABET.test(code) ? code : null;
}

/**
 * The mappings after linking `memberId` to `foundryUserId`. The code proves
 * the member chose this Foundry user, so it replaces the member's earlier
 * link, and any other member linked to that user loses the link: two
 * members never share one Foundry user.
 * @param {Object<string,string>} mappings - member id -> Foundry user id
 * @param {string} memberId
 * @param {string} foundryUserId
 * @returns {Object<string,string>}
 */
export function linkMappings(mappings, memberId, foundryUserId) {
  const out = {};
  for (const [key, id] of Object.entries(mappings || {})) {
    if (key !== memberId && id !== foundryUserId) out[key] = id;
  }
  out[memberId] = foundryUserId;
  return out;
}

/**
 * Whether this Foundry user is linked to some member.
 * @param {Object<string,string>} mappings
 * @param {string} foundryUserId
 */
export function isLinked(mappings, foundryUserId) {
  return Object.values(mappings || {}).includes(foundryUserId);
}

/**
 * Whether to open the link window by itself when a player joins: a player,
 * in a world connected to Chronicle, not linked, who has not said "Not now".
 * @param {{isGM: boolean, connected: boolean, linked: boolean, dismissed: boolean}} p
 */
export function offersLink({ isGM, connected, linked, dismissed }) {
  return !isGM && !!connected && !linked && !dismissed;
}

/**
 * The words key for a redeem's outcome, from the status the GM's client
 * passed on.
 * @param {number} status
 * @returns {'Linked'|'WrongCode'|'TooMany'|'NoGM'|'Failed'}
 */
export function outcomeKey(status) {
  if (status === 200) return 'Linked';
  if (status === 404) return 'WrongCode';
  if (status === 429) return 'TooMany';
  if (status === 504) return 'NoGM';
  return 'Failed';
}
