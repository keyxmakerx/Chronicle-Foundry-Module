/**
 * Which Chronicle characters get a new actor when Foundry connects. A
 * character made in Chronicle while the world was closed never sent its live
 * `entity.created`, so the connect pass makes its actor instead. Only one
 * made since the last sync qualifies: an older character with no actor is one
 * the GM deleted here or never imported, and must not come back on every
 * connect. One the GM deleted here and chose to keep in Chronicle is on the
 * exclusion list and stays away for good. Pure; see tools/test-actor-catch-up.mjs.
 */

/**
 * True when the page was made after `createdAfter`. No `createdAfter` (the
 * first connect) means nothing qualifies: importing is the import wizard's job.
 * @param {{created_at?: string}|null} entity
 * @param {string|null} createdAfter - ISO time saved with the last sync.
 * @returns {boolean}
 */
export function madeSince(entity, createdAfter) {
  if (!createdAfter || !entity?.created_at) return false;
  const made = Date.parse(entity.created_at);
  const since = Date.parse(createdAfter);
  return Number.isFinite(made) && Number.isFinite(since) && made > since;
}

/**
 * Whether the connect pass should make an actor for this character.
 * @param {object} p
 * @param {{id?: string, created_at?: string}|null} p.entity
 * @param {string|null} p.createdAfter
 * @param {Iterable<string>} [p.excludedIds] - pages the GM turned sync off for.
 * @returns {boolean}
 */
export function bringsInActor({ entity, createdAfter, excludedIds = [] }) {
  if (!entity?.id) return false;
  if (new Set(excludedIds).has(entity.id)) return false;
  return madeSince(entity, createdAfter);
}
