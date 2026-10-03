/**
 * What to change on one actor so its Chronicle-linked items match the
 * character's "Has Item" relations. Planning from the whole list, rather
 * than applying single events, makes every reconcile safe to repeat: an item
 * already right is not written, and running it twice changes nothing.
 *
 * Nothing here deletes a Foundry item: sync never deletes without asking. An
 * item whose relation is not on this character (removed in Chronicle, or a
 * copy dragged from another actor) is only unlinked, and stays in Foundry.
 *
 * Pure — see tools/test-inventory-plan.mjs.
 */

import { FLAG_SCOPE } from './constants.mjs';

export const HAS_ITEM = 'Has Item';

/** A relation's metadata as an object, whether Chronicle sent it parsed or as a string. */
export function relationMeta(rel) {
  const m = rel?.metadata;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try {
    const parsed = JSON.parse(m);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {object[]} relations  The character's relations (`GET /entities/:id/relations`).
 * @param {Array<{id: string, relationId: *, entityId: string|null, quantity?: number, equipped?: boolean}>} items
 *   The actor's items as they stand.
 * @returns {{create: object[], update: Array<{id: string, change: object}>, adopt: Array<{id: string, relationId: *}>, unlink: string[]}}
 *   `create`: relations with no item yet. `adopt`: an item with the same
 *   Chronicle item and no live relation (a Foundry push not recorded yet, or
 *   one just unlinked), linked instead of copied. `update`: quantity or
 *   equipped differ. `unlink`: items whose relation is not on this character;
 *   their relation flag is cleared, the item kept.
 */
export function planInventory(relations, items) {
  const rels = (relations || []).filter((r) => r?.relationType === HAS_ITEM && r.id != null);
  const relIds = new Set(rels.map((r) => String(r.id)));
  const byRelation = new Map();
  const stale = [];
  for (const it of items || []) {
    if (it.relationId == null) continue;
    if (relIds.has(String(it.relationId))) byRelation.set(String(it.relationId), it);
    else stale.push(it);
  }
  // A stale item can be adopted by a live relation for the same Chronicle
  // item (Chronicle replaced the row), so it joins the unlinked pool.
  const unlinked = [...stale, ...(items || []).filter((it) => it.relationId == null)].filter((it) => it.entityId);

  const plan = { create: [], update: [], adopt: [], unlink: [] };
  for (const rel of rels) {
    const item = byRelation.get(String(rel.id));
    if (item) {
      const change = metaChange(relationMeta(rel), item);
      if (change) plan.update.push({ id: item.id, change });
      continue;
    }
    const i = unlinked.findIndex((it) => it.entityId === rel.targetEntityId);
    if (i >= 0) {
      plan.adopt.push({ id: unlinked[i].id, relationId: rel.id });
      const change = metaChange(relationMeta(rel), unlinked[i]);
      if (change) plan.update.push({ id: unlinked[i].id, change });
      unlinked.splice(i, 1);
      continue;
    }
    plan.create.push(rel);
  }
  const adopted = new Set(plan.adopt.map((a) => a.id));
  for (const it of stale) {
    if (!adopted.has(it.id)) plan.unlink.push(it.id);
  }
  return plan;
}

/** The item fields to write so it matches the relation, or null when it already does. */
function metaChange(meta, item) {
  const change = {};
  if (meta.quantity !== undefined && meta.quantity !== item.quantity) change['system.quantity'] = meta.quantity;
  if (meta.equipped !== undefined && meta.equipped !== item.equipped) change['system.equipped'] = meta.equipped;
  return Object.keys(change).length ? change : null;
}

/** New Foundry item data for a relation. */
export function itemDataFor(rel) {
  const meta = relationMeta(rel);
  return {
    name: rel.targetEntityName || 'Unknown Item',
    type: 'equipment',
    flags: { [FLAG_SCOPE]: { relationId: rel.id, entityId: rel.targetEntityId } },
    system: { quantity: meta.quantity ?? 1, equipped: meta.equipped ?? false },
  };
}
