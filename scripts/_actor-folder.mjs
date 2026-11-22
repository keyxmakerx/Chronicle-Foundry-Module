/**
 * Which Actors-tab folder a Chronicle character's actor belongs in: Heroes
 * when a player has the character, NPCs for everyone else. An actor is placed
 * once, and only while it sits outside every folder, so a GM's own sorting
 * is never undone. Pure: `tools/test-actor-folder.mjs`.
 */

export const HEROES = 'heroes';
export const NPCS = 'npcs';

/** Actor flag recording that sync has placed (or been told to leave) the actor. */
export const FOLDER_PLACED_FLAG = 'folderPlaced';

/** Folder flag naming which of the two folders it is. */
export const ACTOR_FOLDER_FLAG = 'actorFolderKind';

/**
 * @param {object} p
 * @param {object} p.entity - the Chronicle character page
 * @param {{hasPlayerOwner?: boolean}} p.actor
 * @param {number|string|null} [p.pcSubtypeId]
 * @returns {'heroes'|'npcs'}
 */
export function folderKindFor({ entity, actor, pcSubtypeId = null }) {
  if (entity?.owner_user_id) return HEROES;
  if (pcSubtypeId != null && entity?.entity_type_id === pcSubtypeId) return HEROES;
  if (actor?.hasPlayerOwner) return HEROES;
  return NPCS;
}

/**
 * True while the actor has never been placed and sits in no folder.
 * @param {{folder?: unknown, getFlag?: Function}} actor
 * @param {string} scope
 */
export function needsPlacing(actor, scope) {
  if (actor?.folder) return false;
  return actor?.getFlag?.(scope, FOLDER_PLACED_FLAG) !== true;
}
