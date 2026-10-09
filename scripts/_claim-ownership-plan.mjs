/**
 * Pure planner for turning a Chronicle character claim into Foundry actor
 * ownership. Foundry's ownership is only ever widened here: the mapped
 * player gains OWNER, and anyone who held it before is reported, never
 * demoted, because a GM may have granted that access on purpose.
 */

const OWNER = 3;

/**
 * @param {object} p
 * @param {Object<string,number>} [p.ownership] - the actor's ownership map (`default` plus user ids).
 * @param {string|null} [p.chronicleOwnerId] - Chronicle's owner_user_id now.
 * @param {string|null} [p.previousOwnerId] - the owner Chronicle had when this client last applied it.
 * @param {Object<string,string>} [p.mappings] - `userMappings` (Chronicle id -> Foundry id).
 * @param {Iterable<string>} [p.foundryUserIds] - live Foundry users; a mapping to anyone else is dead.
 * @param {Iterable<string>} [p.gmUserIds] - GMs, who need no grant and are never reported as stale.
 * @param {number} [p.ownerLevel] - the OWNER constant.
 * @returns {{grantUserId: string|null, staleOwnerUserIds: string[], unmapped: boolean}}
 *   `unmapped` is true only when a claim exists but has no live Foundry user.
 */
export function planClaimOwnership({
  ownership = {},
  chronicleOwnerId = null,
  previousOwnerId = null,
  mappings = {},
  foundryUserIds = null,
  gmUserIds = [],
  ownerLevel = OWNER,
} = {}) {
  const none = { grantUserId: null, staleOwnerUserIds: [], unmapped: false };
  if (chronicleOwnerId === null || chronicleOwnerId === undefined || chronicleOwnerId === '') return none;

  const live = foundryUserIds ? new Set(foundryUserIds) : null;
  const gms = new Set(gmUserIds);
  const alive = (id) => !!id && (!live || live.has(id));

  const target = mappings[chronicleOwnerId] || null;
  if (!alive(target)) return { ...none, unmapped: true };
  if (gms.has(target)) return none;

  const levelOf = (id) => ownership[id] ?? ownership.default ?? 0;
  const grantUserId = levelOf(target) >= ownerLevel ? null : target;

  // A hand-over: the previous claimant keeps OWNER, so the GM is told.
  const stale = [];
  if (previousOwnerId && previousOwnerId !== chronicleOwnerId) {
    const before = mappings[previousOwnerId] || null;
    if (before && before !== target && !gms.has(before) && alive(before) && ownership[before] === ownerLevel) {
      stale.push(before);
    }
  }

  return { grantUserId, staleOwnerUserIds: stale, unmapped: false };
}
