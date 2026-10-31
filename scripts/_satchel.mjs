/**
 * Pure helpers for the Satchel window (scripts/satchel.mjs).
 * tools/test-satchel.mjs pins them.
 */

/** The Satchel's tabs, in the order they are drawn. */
export const SATCHEL_TABS = ['notebook', 'quests', 'stash', 'crafting'];

/** A known tab, or the notebook for anything else. */
export function satchelTab(tab) {
  return SATCHEL_TABS.includes(tab) ? tab : 'notebook';
}

/**
 * Whose stash the Stash tab (and whose crafting the Crafting tab) shows: the
 * player's assigned character when it is a synced one they may open, else
 * their first such actor by name, so the choice is the same every time.
 * @param {{character?: object|null}} user
 * @param {object[]} actors
 * @param {{linked: (a: object) => boolean, allowed: (a: object) => boolean}} test
 * @returns {object|null}
 */
export function stashActor(user, actors, { linked, allowed }) {
  const ok = (a) => !!a && linked(a) && allowed(a);
  if (ok(user?.character)) return user.character;
  return (Array.isArray(actors) ? actors : [])
    .filter(ok)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}
