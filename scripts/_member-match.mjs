/**
 * Which Chronicle members to link to which Foundry users without asking the
 * GM. A link grants access (notes, stashes, a claimed character's actor), so
 * a member is linked only on evidence that names one Foundry user and no one
 * else:
 *
 * 1. The GM's own Foundry setup: the member's Chronicle character is linked
 *    to an actor that exactly one player owns, or that a player has as their
 *    assigned character. The GM gave that access already.
 * 2. The same name on both sides, ignoring case.
 * 3. The same name ignoring case, spacing, punctuation and accents
 *    ("Key Maker", "keymaker", "Kéy-Maker"), when it is unique on both sides.
 *
 * A Foundry user already linked to another member is never offered again, so
 * two members never share one Foundry user. Pure; see tools/test-member-match.mjs.
 */

/** Lower case, accents and everything but letters and digits removed. */
export function looseName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const strictName = (name) => String(name ?? '').trim().toLowerCase();

/** Count of each key `keyOf` gives over `items`; empty keys are skipped. */
function counts(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (k) out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
}

/**
 * @param {object} p
 * @param {Array<object>} p.members - Chronicle members (`GET /members`).
 * @param {Object<string,string>} p.mappings - `userMappings` (member key -> Foundry user id).
 * @param {Array<{id: string, name: string, isGM?: boolean}>} p.users - Foundry users.
 * @param {(member: object) => (string|null)} p.keyOf - member key (`memberKey`).
 * @param {Map<string, Set<string>>|Object<string, Iterable<string>>} [p.evidence] -
 *   per member key, the non-GM Foundry users the GM gave that member's character to.
 * @returns {{add: Object<string,string>, how: Object<string,'setup'|'name'|'loose'>, unmatched: Array<object>}}
 *   `add`: new links to save; `unmatched`: members still without a live link.
 */
export function planMemberMatches({ members = [], mappings = {}, users = [], keyOf, evidence = new Map() }) {
  const userIds = new Set(users.map((u) => u.id));
  const gmIds = new Set(users.filter((u) => u.isGM).map((u) => u.id));
  const evidenceFor = (key) => {
    const raw = evidence instanceof Map ? evidence.get(key) : evidence?.[key];
    return raw ? [...new Set(raw)] : [];
  };

  // A link to a Foundry user that no longer exists is no link: that member
  // may be matched again, and the dead id is offered to no one.
  const taken = new Set();
  for (const id of Object.values(mappings || {})) if (userIds.has(id)) taken.add(id);

  const strictMembers = counts(members, (m) => strictName(m.display_name));
  const looseMembers = counts(members, (m) => looseName(m.display_name));
  const strictUsers = counts(users, (u) => strictName(u.name));
  const looseUsers = counts(users, (u) => looseName(u.name));

  const add = {};
  const how = {};
  const unmatched = [];
  const free = (id) => id && userIds.has(id) && !taken.has(id);
  const claim = (key, id, reason) => { add[key] = id; how[key] = reason; taken.add(id); };

  const open = [];
  for (const member of members) {
    const key = keyOf(member);
    if (!key) continue;
    if (userIds.has(mappings?.[key])) continue;
    open.push({ member, key });
  }

  // Evidence first, for every open member, so a name match cannot take a
  // Foundry user the GM's own setup gives to someone else.
  for (const { key } of open) {
    const ids = evidenceFor(key).filter((id) => userIds.has(id) && !gmIds.has(id));
    if (ids.length === 1 && free(ids[0])) claim(key, ids[0], 'setup');
  }

  for (const { member, key } of open) {
    if (add[key]) continue;
    const strict = strictName(member.display_name);
    const loose = looseName(member.display_name);
    let id = null;
    let reason = null;
    if (strict && strictMembers.get(strict) === 1 && strictUsers.get(strict) === 1) {
      id = users.find((u) => strictName(u.name) === strict)?.id ?? null;
      reason = 'name';
    } else if (loose && looseMembers.get(loose) === 1 && looseUsers.get(loose) === 1) {
      id = users.find((u) => looseName(u.name) === loose)?.id ?? null;
      reason = 'loose';
    }
    if (free(id)) claim(key, id, reason);
    else unmatched.push(member);
  }

  return { add, how, unmatched };
}
