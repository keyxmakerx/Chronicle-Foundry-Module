/**
 * Pure rules for a map the GM gave in Chronicle. Chronicle gives a map as a
 * handout item page ("Map: <name>") that points at the map and carries a
 * marker naming it; a Player sees the map only while a character they own
 * carries that item. In Foundry the carried item opens the map's journal for
 * that character's players, and the access goes when the item does.
 */

/** Item pages Chronicle made to hand out a map start with this. */
export const HANDOUT_PREFIX = 'Map: ';

/** The fields_data key Chronicle marks a handout with: the map's id. */
export const HANDOUT_MARKER = 'chronicle_map_handout';

/**
 * The map an item page is the handout of, or null. The marker must name the
 * same map the page points at, so a page someone merely pointed at a map is
 * not a handout.
 * @param {object} entity a Chronicle entity
 * @returns {string|null}
 */
export function handoutMapId(entity) {
  const id = entity?.map_id;
  if (typeof id !== 'string' || !id) return null;
  return entity?.fields_data?.[HANDOUT_MARKER] === id ? id : null;
}

/**
 * The Has Item lines that may be a handout: visible to players and named
 * like one. Only these are looked up, so ordinary items cost nothing.
 * @param {object[]} relations a character's relations
 * @param {string} hasItem the Has Item relation type
 * @returns {object[]}
 */
export function handoutCandidates(relations, hasItem) {
  return (relations || []).filter((r) => r?.relationType === hasItem && r.dmOnly !== true
    && typeof r.targetEntityName === 'string' && r.targetEntityName.startsWith(HANDOUT_PREFIX));
}

/**
 * Whether every player who can see the actor may see the handout page in
 * Chronicle. A handout is shown only to its holders' players, by name, so
 * each Foundry viewer must be linked to a Chronicle member the page lets
 * view it; anyone unlinked, or a default level that lets everyone look,
 * fails closed.
 * @param {object|null} perms the page's /permissions answer
 * @param {Record<string, number>} actorOwnership
 * @param {(id: string) => boolean} isGM
 * @param {(foundryUserId: string) => string|null} memberOf Chronicle member of a Foundry user
 * @param {number} limited the LIMITED ownership level
 * @returns {boolean}
 */
export function handoutSeenOnlyByHolders(perms, actorOwnership, isGM, memberOf, limited = 1) {
  if (perms?.visibility !== 'custom' || !Array.isArray(perms.permissions)) return false;
  const allowed = new Set(perms.permissions
    .filter((g) => g?.subject_type === 'user' && (g.permission === 'view' || g.permission === 'edit'))
    .map((g) => String(g.subject_id)));
  for (const [id, level] of Object.entries(actorOwnership || {})) {
    if (level < limited) continue;
    if (id === 'default') return false;
    if (isGM(id)) continue;
    const member = memberOf(id);
    if (!member || !allowed.has(String(member))) return false;
  }
  return true;
}

/**
 * The journal's list of actors that carry its map's Chronicle handout, with
 * `actorId` added or taken out.
 * @param {object} entryFlags the journal entry's module flags
 * @param {string} actorId
 * @param {boolean} carries
 * @returns {string[]}
 */
export function withHandoutHolder(entryFlags, actorId, carries) {
  const list = Array.isArray(entryFlags?.mapHandoutTo) ? entryFlags.mapHandoutTo.filter((id) => typeof id === 'string') : [];
  if (carries) return list.includes(actorId) ? list : [...list, actorId];
  return list.filter((id) => id !== actorId);
}

/**
 * Who loses the map's journal when an actor stops carrying its handout: the
 * actor's player owners that a handout raised (the journal's
 * `mapHandoutRaised` list; a level the GM set by hand is never on it), whose
 * access is still exactly OBSERVER, and who own no other actor the map is
 * still given to. Their own entry is removed, so they fall back to the
 * journal's default.
 * @param {Record<string, number>} actorOwnership the actor's `ownership`
 * @param {Record<string, number>} journalOwnership the journal's `ownership`
 * @param {Set<string>} gmIds
 * @param {Set<string>} stillGivenOwners users who own another actor still given the map
 * @param {{ OWNER: number, OBSERVER: number }} levels
 * @param {string[]} raised users a handout raised on this journal
 * @returns {string[]} user ids whose journal entry goes
 */
export function journalAccessToRevoke(actorOwnership, journalOwnership, gmIds, stillGivenOwners, levels, raised = []) {
  const out = [];
  const byHandout = new Set(Array.isArray(raised) ? raised : []);
  for (const [userId, level] of Object.entries(actorOwnership || {})) {
    if (userId === 'default' || gmIds.has(userId) || level < levels.OWNER) continue;
    if (stillGivenOwners.has(userId) || !byHandout.has(userId)) continue;
    if (journalOwnership?.[userId] === levels.OBSERVER) out.push(userId);
  }
  return out;
}
