/**
 * Chronicle Sync - Member ↔ Foundry-user mapping view-model
 *
 * Pure builder for the dashboard Members tab. Given the Chronicle campaign
 * members, the current `userMappings` table, the available Foundry users, and
 * a member-key resolver, it produces one row per member describing the current
 * mapping and whether it is matched or UNMATCHED.
 *
 * Kept side-effect-free (no Foundry globals) so it can be unit-tested without a
 * Foundry runtime — the same pattern the sync-calendar pure helpers use.
 *
 * Security posture: an UNMATCHED member's per-player permission grants are
 * silently dropped on both push and pull, so the row's `matched=false` /
 * `UNMATCHED` badge is the operator's required signal that a wrong/missing
 * mapping is widening or narrowing access without their knowledge (audit §2).
 */

/**
 * @typedef {object} MemberRow
 * @property {string} key          - Chronicle user-id key (mapping table key).
 * @property {string} name         - Member display name.
 * @property {string} [role]       - Chronicle role label, if present.
 * @property {string|null} foundryUserId - Currently mapped Foundry user id, or null.
 * @property {string|null} foundryUserName - Currently mapped Foundry user name, or null.
 * @property {boolean} matched     - True when mapped to a live Foundry user.
 * @property {Array<{id: string, name: string, selected: boolean}>} options - Dropdown options.
 */

/**
 * Build the Members-tab rows.
 *
 * @param {object} params
 * @param {Array<object>} params.members - Chronicle members (`GET /members`).
 * @param {Object<string,string>} params.mappings - `userMappings` (chronicleId → foundryId).
 * @param {Array<{id: string, name: string}>} params.foundryUsers - `game.users` (id + name).
 * @param {(member: object) => (string|null)} params.keyOf - Member-key resolver (`memberKey`).
 * @returns {{rows: MemberRow[], matchedCount: number, unmatchedCount: number}}
 */
export function buildMemberRows({ members, mappings, foundryUsers, keyOf }) {
  const userList = Array.isArray(foundryUsers) ? foundryUsers : [];
  const map = mappings || {};
  const rows = [];
  let matchedCount = 0;

  for (const member of members || []) {
    const key = keyOf(member);
    if (!key) continue;

    const mappedId = map[key] || null;
    // A mapping only counts as "matched" if it points at a Foundry user that
    // still exists — a stale id (user deleted) must surface as UNMATCHED so the
    // operator re-maps it rather than trusting a dead link.
    const mappedUser = mappedId ? userList.find((u) => u.id === mappedId) : null;
    const matched = !!mappedUser;
    if (matched) matchedCount++;

    const options = [
      { id: '', name: '— Unmapped —', selected: !matched },
      ...userList.map((u) => ({
        id: u.id,
        name: u.name,
        selected: u.id === mappedId,
      })),
    ];

    rows.push({
      key,
      name: member.display_name || key,
      role: member.role || '',
      foundryUserId: mappedId,
      foundryUserName: mappedUser ? mappedUser.name : null,
      matched,
      options,
    });
  }

  return {
    rows,
    matchedCount,
    unmatchedCount: rows.length - matchedCount,
  };
}
