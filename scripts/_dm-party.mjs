/**
 * Pure helpers for the DM Screen's Party tab: whose stash view to read, and
 * the shared stashes from that view as rows.
 */

import { formatMoney, normalizeView } from './_stash-model.mjs';

/**
 * The character the Party tab reads stashes through. Chronicle answers a
 * stash view for one character, and every hero sees the same shared stashes,
 * so any player character synced from Chronicle will do; the first by name
 * keeps the choice stable.
 * @param {Array<{id: string, name: string, entityId: string|null, playerOwned: boolean}>} actors
 * @returns {{id: string, name: string, entityId: string}|null}
 */
export function stashHero(actors) {
  const heroes = (actors ?? []).filter((a) => a?.id && a.entityId && a.playerOwned);
  heroes.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  const hero = heroes[0];
  return hero ? { id: String(hero.id), name: String(hero.name ?? ''), entityId: String(hero.entityId) } : null;
}

/**
 * The shared stashes from a raw stash view, ready to draw.
 * @param {any} raw - GET /stashes/view as Chronicle sent it
 * @returns {Array<{id: string, name: string, money: string, items: Array<{name: string, quantity: number}>}>|null}
 *   null when the answer isn't a stash view
 */
export function stashRows(raw) {
  const view = normalizeView(raw);
  if (!view) return null;
  return view.stashes.map((s) => ({
    id: s.id,
    name: s.name,
    money: formatMoney(s.money),
    items: s.items.map((i) => ({ name: i.name, quantity: i.quantity })),
  }));
}
