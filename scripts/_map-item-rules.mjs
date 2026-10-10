/**
 * Pure rules for giving a Chronicle map to a character in Foundry: which
 * item type carries it, and who must be able to open the map's journal.
 * The GM gives the map (Key Maker's sign-off); players never pick maps.
 */

/** Item types that read as "something you carry", in order of preference. */
const PREFERRED_ITEM_TYPES = ['loot', 'treasure', 'equipment', 'gear', 'item', 'object', 'trinket'];

/**
 * Pick the item type a map becomes on this system. Returns null when the
 * system has no usable item type (the caller says so instead of guessing).
 * @param {string[]} types the system's Item types
 * @returns {string|null}
 */
export function pickMapItemType(types) {
  const usable = (Array.isArray(types) ? types : []).filter((t) => typeof t === 'string' && t && t !== 'base');
  for (const t of PREFERRED_ITEM_TYPES) {
    if (usable.includes(t)) return t;
  }
  return usable[0] ?? null;
}

/**
 * The journal ownership changes that let every player who owns `actor`
 * open the map. Only raises access to OBSERVER, never lowers anyone, and
 * never touches GMs or the default level.
 * @param {Record<string, number>} actorOwnership the actor's `ownership`
 * @param {Record<string, number>} journalOwnership the journal's `ownership`
 * @param {Set<string>} gmIds user ids that are GMs
 * @param {{ OWNER: number, OBSERVER: number }} levels
 * @returns {Record<string, number>} user id → new level; empty when nothing changes
 */
export function journalAccessForActorOwners(actorOwnership, journalOwnership, gmIds, levels) {
  const out = {};
  for (const [userId, level] of Object.entries(actorOwnership || {})) {
    if (userId === 'default' || gmIds.has(userId)) continue;
    if (level < levels.OWNER) continue;
    const current = journalOwnership?.[userId] ?? -1;
    if (current < levels.OBSERVER) out[userId] = levels.OBSERVER;
  }
  return out;
}

/**
 * The journal ownership changes for every map journal an actor carries, once
 * the actor's owners have changed. Same rule as the give: only raises to
 * OBSERVER, never lowers, never touches GMs or the default level. A journal
 * listed twice (two items, one map) is handled once.
 * @param {Record<string, number>} actorOwnership the actor's `ownership`
 * @param {{ id: string, ownership: Record<string, number> }[]} journals the
 *   journal entries the actor's map items point at
 * @param {Set<string>} gmIds user ids that are GMs
 * @param {{ OWNER: number, OBSERVER: number }} levels
 * @returns {Map<string, Record<string, number>>} journal id → user id → new
 *   level; journals that need nothing are left out
 */
export function journalAccessForCarriedMaps(actorOwnership, journals, gmIds, levels) {
  const out = new Map();
  const seen = new Set();
  for (const j of journals || []) {
    if (!j?.id || seen.has(j.id)) continue;
    seen.add(j.id);
    const access = journalAccessForActorOwners(actorOwnership, j.ownership, gmIds, levels);
    if (Object.keys(access).length) out.set(j.id, access);
  }
  return out;
}

/**
 * The map an item carries, or null. Accepts only a JournalEntryPage UUID.
 * @param {object} flags the item's module flags
 * @returns {string|null}
 */
export function mapPageUuidOf(flags) {
  const uuid = flags?.mapPageUuid;
  return typeof uuid === 'string' && /^JournalEntry\.[A-Za-z0-9]{16}\.JournalEntryPage\.[A-Za-z0-9]{16}$/.test(uuid)
    ? uuid : null;
}
