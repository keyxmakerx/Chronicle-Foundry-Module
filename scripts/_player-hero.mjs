/**
 * A player with no hero in Foundry gets the hero they claimed in Chronicle.
 *
 * The connect catch-up only makes actors for characters made since the last
 * sync, because an older character with no actor may be one the GM removed
 * here. A claim is different evidence: the page now belongs to a player, and
 * if that player plays no hero in this world at all, the hero is missing, not
 * removed. So a claimed hero is brought in only when its claimant is linked
 * to a live non-GM Foundry user who owns no actor of the hero type and has no
 * assigned character. A player who already has a hero here keeps what the GM
 * gave them, and a page the GM turned sync off for stays away.
 *
 * Once that player owns the actor it also becomes their assigned character,
 * but only when they have none: a character the GM assigned is never changed.
 * Pure; see tools/test-player-hero.mjs.
 */

const OWNER = 3;

/**
 * Foundry users who already play a hero here: explicit OWNER on an actor of
 * the hero type (an actor everyone owns says nothing about anyone), or an
 * assigned character that still exists.
 * @param {object} p
 * @param {Array<{id: string, type?: string, ownership?: Object<string,number>}>} p.actors
 * @param {Array<{id: string, isGM?: boolean, character?: {id?: string}|string|null}>} p.users
 * @param {string} p.actorType
 * @param {number} [p.ownerLevel]
 * @returns {Set<string>}
 */
export function usersWithHero({ actors = [], users = [], actorType, ownerLevel = OWNER }) {
  const out = new Set();
  const actorIds = new Set(actors.map((a) => a?.id).filter(Boolean));
  const heroes = actors.filter((a) => a?.type === actorType);
  for (const user of users) {
    if (!user?.id || user.isGM) continue;
    if (actorIds.has(characterId(user))) {
      out.add(user.id);
      continue;
    }
    for (const actor of heroes) {
      const own = actor.ownership ?? {};
      if ((own.default ?? 0) >= ownerLevel) continue;
      if ((own[user.id] ?? 0) >= ownerLevel) {
        out.add(user.id);
        break;
      }
    }
  }
  return out;
}

/**
 * Which claimed heroes to bring in, and for whom.
 * @param {object} p
 * @param {Array<{entityId?: string|null, ownerKey?: string|null}>} p.claims -
 *   Chronicle heroes and the member key that owns each.
 * @param {Object<string,string>} p.mappings - `userMappings` (member key -> Foundry user id).
 * @param {Array<{id: string, isGM?: boolean}>} p.users - live Foundry users.
 * @param {Iterable<string>} p.linkedEntityIds - pages that already have an actor.
 * @param {Iterable<string>} [p.excludedIds] - pages the GM turned sync off for.
 * @param {Iterable<string>} [p.heroUserIds] - `usersWithHero`.
 * @returns {Array<{entityId: string, ownerKey: string, userId: string}>} at most one per page and one per player.
 */
export function planPlayerHeroes({ claims = [], mappings = {}, users = [], linkedEntityIds = [], excludedIds = [], heroUserIds = [] }) {
  const players = new Map(users.filter((u) => u?.id).map((u) => [u.id, u]));
  const linked = new Set(linkedEntityIds);
  const excluded = new Set(excludedIds);
  const served = new Set(heroUserIds);
  const pages = new Set();
  const out = [];
  for (const claim of claims) {
    const entityId = claim?.entityId ? String(claim.entityId) : '';
    const ownerKey = claim?.ownerKey ? String(claim.ownerKey) : '';
    if (!entityId || !ownerKey || linked.has(entityId) || excluded.has(entityId) || pages.has(entityId)) continue;
    const userId = mappings?.[ownerKey];
    const user = userId ? players.get(userId) : null;
    if (!user || user.isGM || served.has(userId)) continue;
    pages.add(entityId);
    served.add(userId);
    out.push({ entityId, ownerKey, userId });
  }
  return out;
}

/**
 * The claims the members list names: each member's character, keyed by
 * member. Chronicle reports the page a member owns as their character.
 * @param {Array<object>} members - `GET /members`.
 * @param {(member: object) => (string|null)} keyOf - `memberKey`.
 * @returns {Array<{entityId: string, ownerKey: string}>}
 */
export function memberClaims(members, keyOf) {
  const out = [];
  for (const m of members || []) {
    const ownerKey = keyOf(m);
    if (ownerKey && m?.character_entity_id) out.push({ entityId: String(m.character_entity_id), ownerKey });
  }
  return out;
}

/** The id of a user's assigned character, whether Foundry holds it as a document or an id. */
function characterId(user) {
  const c = user?.character;
  if (!c) return null;
  return typeof c === 'string' ? c : (c.id ?? null);
}

/**
 * Whether to make `actorId` this user's assigned character: a non-GM with no
 * assigned character, or one that points at an actor that no longer exists.
 * @param {object} p
 * @param {{id?: string, isGM?: boolean, character?: object|string|null}|null} p.user
 * @param {string|null} p.actorId
 * @param {Iterable<string>} p.actorIds - actors in the world now.
 * @returns {boolean}
 */
export function assignsCharacter({ user, actorId, actorIds = [] }) {
  if (!user?.id || user.isGM || !actorId) return false;
  const current = characterId(user);
  if (!current) return true;
  if (current === actorId) return false;
  return !new Set(actorIds).has(current);
}
