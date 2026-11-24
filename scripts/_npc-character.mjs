/**
 * Which Chronicle character pages are NPCs, and what a switch between the
 * system's hero and NPC actor types changes. Chronicle keeps heroes and NPCs
 * in one Character type; a system with a separate NPC actor type (Draw
 * Steel) needs them apart, or an NPC opens as an empty hero. A page is a hero
 * when a player has it, Chronicle marks it playable (a hero nobody has
 * claimed yet), or it names a class or a hero choice (ancestry, culture,
 * career, kit); every other character page is an NPC.
 * Pure: `tools/test-npc-character.mjs`.
 */

import { folderKindFor, HEROES } from './_actor-folder.mjs';
import { classPick } from './_finish-hero.mjs';
import { identityPicks } from './_identity-item-plan.mjs';

/** The NPC actor type per Foundry system, where it differs from the hero type. */
export const NPC_ACTOR_TYPES = Object.freeze({ 'draw-steel': 'npc' });

/**
 * The NPC actor type to use, or null to keep every page the hero type. The
 * type must exist in this world, so a renamed or missing type changes nothing.
 * @param {string|undefined} systemId - Foundry's `game.system.id`.
 * @param {string[]|undefined} actorTypes - Foundry's `game.documentTypes.Actor`.
 * @returns {string|null}
 */
export function npcActorTypeFor(systemId, actorTypes) {
  const type = NPC_ACTOR_TYPES[systemId];
  return type && Array.isArray(actorTypes) && actorTypes.includes(type) ? type : null;
}

/**
 * Whether a character page is a hero. Only the page decides: a GM giving a
 * player an NPC's actor does not make the page a hero.
 * @param {{entity: object, pcSubtypeId?: number|string|null, fieldDefs?: object[]}} p
 * @returns {boolean}
 */
export function isHeroPage({ entity, pcSubtypeId = null, fieldDefs = [] }) {
  if (folderKindFor({ entity, actor: null, pcSubtypeId }) === HEROES) return true;
  if (entity?.playable === true) return true;
  if (classPick(fieldDefs, entity?.fields_data)) return true;
  return Object.keys(identityPicks(fieldDefs, entity?.fields_data)).length > 0;
}

/**
 * The actor type a new actor for this page gets.
 * @param {{entity: object, pcSubtypeId?: any, fieldDefs?: object[], heroType: string, npcType: string|null}} p
 * @returns {string}
 */
export function actorTypeForPage({ entity, pcSubtypeId = null, fieldDefs = [], heroType, npcType }) {
  if (!npcType) return heroType;
  return isHeroPage({ entity, pcSubtypeId, fieldDefs }) ? heroType : npcType;
}

/**
 * The type a linked actor should be switched to, or null. A hero actor is
 * offered as an NPC only while nothing on it is a hero's: no class item and
 * no player owner, so a hero built in Foundry is never offered.
 * @param {{actor: {type: string, hasPlayerOwner?: boolean, items?: Array<{type?: string}>},
 *   entity: object, pcSubtypeId?: any, fieldDefs?: object[], heroType: string, npcType: string|null}} p
 * @returns {string|null}
 */
export function switchTarget({ actor, entity, pcSubtypeId = null, fieldDefs = [], heroType, npcType }) {
  if (!npcType || !actor || !entity) return null;
  const hero = isHeroPage({ entity, pcSubtypeId, fieldDefs });
  if (actor.type === npcType) return hero ? heroType : null;
  if (actor.type !== heroType || hero || actor.hasPlayerOwner) return null;
  const items = Array.isArray(actor.items) ? actor.items : [];
  return items.some((it) => it?.type === 'class') ? null : npcType;
}

/** The id at the end of a compendium uuid (`Compendium.x.y.Item.<id>`). */
function idOf(uuid) {
  return String(uuid ?? '').split('.').pop();
}

/**
 * What a type switch removes and adds. Items the new type cannot hold go.
 * The system's basic actions, which it gives every new hero under their
 * compendium ids, go when the actor becomes an NPC and are added back,
 * where missing, when it becomes a hero. Every other item stays.
 * @param {{items: Array<{id: string, type?: string}>, toType: string, heroType: string,
 *   invalidTypesOf?: (itemType: string) => string[]|undefined, basicUuids?: string[]}} p
 * @returns {{removeIds: string[], addUuids: string[]}}
 */
export function planTypeSwitch({ items, toType, heroType, invalidTypesOf = () => undefined, basicUuids = [] }) {
  const list = Array.isArray(items) ? items : [];
  const basicIds = new Set(basicUuids.map(idOf));
  const removeIds = list
    .filter((it) => (invalidTypesOf(it?.type) ?? []).includes(toType) || (toType !== heroType && basicIds.has(it?.id)))
    .map((it) => it.id);
  const have = new Set(list.map((it) => it?.id));
  const addUuids = toType === heroType ? basicUuids.filter((u) => !have.has(idOf(u))) : [];
  return { removeIds, addUuids };
}

/**
 * The system data an actor keeps across a switch: its biography (notes the
 * GM wrote in Foundry). Everything else starts at the new type's defaults.
 * @param {object|undefined} system - the actor's current system data, plain.
 * @returns {object}
 */
export function carriedSystem(system) {
  const bio = system?.biography;
  return bio && typeof bio === 'object' ? { biography: { ...bio } } : {};
}
