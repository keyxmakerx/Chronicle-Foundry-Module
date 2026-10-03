/**
 * Which Foundry items a stash refresh may remove.
 *
 * Sync never deletes without asking, so a refresh only adds and updates. The
 * one removal is the item a just-applied move took away from a character:
 * only an item linked to THAT Chronicle item entity, on that actor, whose
 * relation no longer exists. Anything else (dragged copies, items whose
 * entity is in the trash, other orphans) is left alone.
 */

/**
 * @param {Array<{id: string, relationId: any, entityId: any}>} items - the
 *   actor's items with their sync flags.
 * @param {Iterable<any>} liveRelationIds - relation ids Chronicle still has.
 * @param {Iterable<string>} movedItemIds - Chronicle item entity ids moved away.
 * @returns {Array<{id: string, relationId: any}>}
 */
export function itemsToRemove(items, liveRelationIds, movedItemIds) {
  const moved = new Set([...(movedItemIds ?? [])].map(String));
  if (moved.size === 0) return [];
  const live = new Set(liveRelationIds ?? []);
  return (items ?? [])
    .filter((i) => i.relationId !== undefined && i.relationId !== null
      && i.entityId !== undefined && i.entityId !== null
      && moved.has(String(i.entityId)) && !live.has(i.relationId))
    .map((i) => ({ id: i.id, relationId: i.relationId }));
}

/**
 * The removal a settled move calls for, if any.
 * @param {object} result - `{status, move}` from /stashes/moves or approve.
 * @returns {{characterId: string, itemId: string}|null}
 */
export function removalFromMove(result) {
  const move = result?.move;
  if (!move || result.status !== 'applied' || move.kind !== 'item') return null;
  if (!move.itemId || move.from?.kind !== 'character' || !move.from.id) return null;
  return { characterId: String(move.from.id), itemId: String(move.itemId) };
}
