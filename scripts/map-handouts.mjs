/**
 * Chronicle Sync - Maps given in Chronicle
 *
 * When a character carries a map's Chronicle handout item, the item opens
 * the map's journal, and the character's players may open that journal.
 * When the item goes, so does the access the handout granted. Run by item
 * sync after each inventory reconcile, on the GM's client only.
 */

import { FLAG_SCOPE, APPLY_OPTION } from './constants.mjs';
import { keyRemoval } from './_flag-removal.mjs';
import { journalAccessForActorOwners, withMapGivenTo } from './_map-item-rules.mjs';
import { withHandoutHolder, journalAccessToRevoke } from './_map-handout.mjs';

function _mapPageIn(entry) {
  return entry?.pages?.contents?.find((p) => p.getFlag(FLAG_SCOPE, 'mapId')) || null;
}

function _mapPage(mapId) {
  for (const entry of game.journal?.contents ?? []) {
    const page = _mapPageIn(entry);
    if (page?.getFlag(FLAG_SCOPE, 'mapId') === mapId) return page;
  }
  return null;
}

const _sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Bring the map journals in line with the handouts `actor` carries.
 * @param {Actor} actor
 * @param {Map<string, string>} carried item id → map id, for every handout
 *   item the actor carries on a line players can see
 */
export async function carryHandoutMaps(actor, carried) {
  if (!game.user?.isGM || !actor) return;
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const gmIds = new Set(game.users.filter((u) => u.isGM).map((u) => u.id));
  const carriedMaps = new Set(carried.values());

  for (const [itemId, mapId] of carried) {
    // A map not yet in this world is shared once map sync makes its journal
    // and the next reconcile runs.
    const page = _mapPage(mapId);
    if (!page) continue;
    const item = actor.items.get(itemId);
    if (item && (item.getFlag(FLAG_SCOPE, 'mapPageUuid') !== page.uuid || item.getFlag(FLAG_SCOPE, 'mapId') !== mapId)) {
      await item.update({ [`flags.${FLAG_SCOPE}.mapPageUuid`]: page.uuid, [`flags.${FLAG_SCOPE}.mapId`]: mapId }, { [APPLY_OPTION]: true });
    }
    const entry = page.parent;
    const flags = entry.flags?.[FLAG_SCOPE];
    const holders = withHandoutHolder(flags, actor.id, true);
    const given = withMapGivenTo(flags, actor.id);
    const access = journalAccessForActorOwners(actor.ownership, entry.ownership, gmIds, L);
    const update = {};
    if (!_sameList(flags?.mapHandoutTo, holders)) update[`flags.${FLAG_SCOPE}.mapHandoutTo`] = holders;
    if (!_sameList(flags?.mapGivenTo, given)) update[`flags.${FLAG_SCOPE}.mapGivenTo`] = given;
    for (const [userId, level] of Object.entries(access)) update[`ownership.${userId}`] = level;
    if (Object.keys(update).length) await entry.update(update);
  }

  // Only journals this actor's handouts opened are taken back; a map the GM
  // gave by hand in Foundry is never on mapHandoutTo.
  for (const entry of game.journal?.contents ?? []) {
    const flags = entry.flags?.[FLAG_SCOPE];
    if (!Array.isArray(flags?.mapHandoutTo) || !flags.mapHandoutTo.includes(actor.id)) continue;
    const mapId = _mapPageIn(entry)?.getFlag(FLAG_SCOPE, 'mapId');
    if (mapId && carriedMaps.has(mapId)) continue;
    const givenTo = (Array.isArray(flags.mapGivenTo) ? flags.mapGivenTo : []).filter((id) => id !== actor.id);
    const stillOwners = new Set();
    for (const id of givenTo) {
      for (const [userId, level] of Object.entries(game.actors.get(id)?.ownership ?? {})) {
        if (userId !== 'default' && level >= L.OWNER) stillOwners.add(userId);
      }
    }
    const revoke = journalAccessToRevoke(actor.ownership, entry.ownership, gmIds, stillOwners, L);
    await entry.update({
      [`flags.${FLAG_SCOPE}.mapHandoutTo`]: withHandoutHolder(flags, actor.id, false),
      [`flags.${FLAG_SCOPE}.mapGivenTo`]: givenTo,
      ...keyRemoval('ownership', ...revoke),
    });
  }
}
