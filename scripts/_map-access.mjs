/**
 * Who may open a synced map's journal. Chronicle shows every map to every
 * member (GM-only pins, shadowed areas and hidden fog are taken out per
 * viewer), and players can read a map there but not change it, so a map
 * journal opens to players at the dashboard's level for player-visible docs,
 * never above Observer: an owner could rewrite the journal's flags, such as
 * who the map was given to. The access is set once per journal, so a GM who
 * hides a map afterwards keeps it hidden.
 *
 * Pure. See tools/test-map-access.mjs.
 */

/** Journal flag: the players' access has been set on this map journal. */
export const MAP_ACCESS_FLAG = 'playerAccess';

/**
 * The `default` ownership level a map journal gives players.
 * @param {number} configured the dashboard's level for player-visible docs
 * @param {{NONE: number, OBSERVER: number}} levels Foundry's ownership levels
 * @returns {number}
 */
export function mapPlayerLevel(configured, levels) {
  const n = Number(configured);
  if (!Number.isInteger(n) || n < levels.NONE) return levels.NONE;
  return Math.min(n, levels.OBSERVER);
}

/**
 * The update that gives an existing map journal its players' access, or null
 * when it already has it. Access is only raised: a user the GM already let
 * in, or a default the GM set higher, is left as it is. Null for a level
 * of None as well.
 * @param {Record<string, number>|undefined} ownership the journal's ownership
 * @param {boolean} applied whether `MAP_ACCESS_FLAG` is already set
 * @param {number} level from `mapPlayerLevel`
 * @param {string} scope the module's flag scope
 * @returns {object|null}
 */
export function mapAccessUpdate(ownership, applied, level, scope) {
  // A dashboard level of None gives nothing and records nothing, so maps
  // open once the GM raises it.
  if (applied || !(level > 0)) return null;
  const current = Number.isInteger(ownership?.default) ? ownership.default : 0;
  const update = { [`flags.${scope}.${MAP_ACCESS_FLAG}`]: true };
  if (level > current) update['ownership.default'] = level;
  return update;
}
