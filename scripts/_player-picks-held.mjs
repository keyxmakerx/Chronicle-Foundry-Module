/**
 * Chronicle Sync - picks Chronicle held from a player's change
 *
 * A player's change reaches Chronicle under the GM's key, so the push names
 * the member it is for (`actingUserId`) and Chronicle judges it as that
 * member. It stores the keys that pass and answers the rest as
 * `held: [{key, reason}]`. A held key is not an error and is never undone in
 * Foundry: the player's item stays, and the GM is told once why Chronicle
 * did not take it.
 */

/**
 * The Chronicle member a burst of player changes is made for. Only
 * meaningful once every player in the burst is known to own the character,
 * which makes them one member.
 * @param {Iterable<string>|null|undefined} players - Foundry user ids.
 * @param {(userId: string) => string|null} memberFor
 * @returns {string|null} null for a GM-only burst, or when no player is matched.
 */
export function actingMemberOf(players, memberFor) {
  if (!players) return null;
  for (const id of players) {
    const member = memberFor(id);
    if (member) return String(member);
  }
  return null;
}

/**
 * The held keys of a fields answer, cleaned for use. An older Chronicle
 * answers without `held`, which reads as nothing held.
 * @param {any} answer
 * @returns {Array<{key: string, reason: string}>}
 */
export function heldKeysOf(answer) {
  if (!Array.isArray(answer?.held)) return [];
  return answer.held
    .filter((h) => h && typeof h.key === 'string' && h.key)
    .map((h) => ({ key: h.key, reason: typeof h.reason === 'string' ? h.reason : '' }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * What the GM is told: the reasons, in Chronicle's own plain words.
 * @param {Array<{key: string, reason: string}>} held
 * @returns {string}
 */
export function describeHeld(held) {
  return held.map((h) => h.reason || `"${h.key}" can't be changed here`).join('; ');
}

/**
 * Tracks which held answer each actor's GM was already told, so a later push
 * that re-sends the same item (every mapped edit re-sends the item-derived
 * fields) does not repeat the notice, while a different refusal still shows.
 */
export class HeldNotices {
  constructor() {
    /** @type {Map<string, string>} */
    this._told = new Map();
  }

  /**
   * @param {string} actorId
   * @param {Array<{key: string, reason: string}>} held
   * @returns {boolean} true when the GM should be told now.
   */
  shouldTell(actorId, held) {
    if (!held.length) {
      this._told.delete(actorId);
      return false;
    }
    const signature = JSON.stringify(held);
    if (this._told.get(actorId) === signature) return false;
    this._told.set(actorId, signature);
    return true;
  }
}
