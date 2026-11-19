/**
 * Chronicle Sync - direction and held changes
 *
 * Each part of the world has a direction (both ways, from Chronicle only,
 * from Foundry only), and "Sync changes as they happen" can be switched off.
 * These helpers decide, for one change, whether it goes now, waits for the
 * GM's "Sync now", or does not go at all, and keep the list of Foundry
 * changes that are waiting. The list is saved in a world setting, so a
 * reload does not lose a change the GM has not sent yet.
 *
 * Pure; see tools/test-held-changes.mjs.
 */

/**
 * Parts whose Chronicle content is kept in Foundry documents. Only these
 * wait while live sync is off; the calendar and shops are views of Chronicle
 * and always show it as it is.
 */
export const HELD_PARTS = new Set(['journals', 'maps', 'characters', 'creatures']);

/**
 * What to do with a Foundry change bound for Chronicle.
 * @param {string} direction - 'both' | 'pull' | 'push' | 'off'
 * @param {boolean} live - "Sync changes as they happen".
 * @param {string} part
 * @returns {'send'|'hold'|'drop'}
 */
export function pushGate(direction, live, part) {
  if (direction === 'pull' || direction === 'off') return 'drop';
  return live || !HELD_PARTS.has(part) ? 'send' : 'hold';
}

/**
 * What to do with a Chronicle change bound for Foundry.
 * @param {string} direction - 'both' | 'pull' | 'push' | 'off'
 * @param {boolean} live - "Sync changes as they happen".
 * @param {string} part
 * @returns {'apply'|'hold'|'drop'}
 */
export function pullGate(direction, live, part) {
  if (direction === 'push' || direction === 'off') return 'drop';
  return live || !HELD_PARTS.has(part) ? 'apply' : 'hold';
}

/**
 * The saved list, with anything unreadable left out.
 * @param {string|Array} saved
 * @returns {Array<{key: string, part: string, kind: string, label: string, at: string, data: object}>}
 */
export function parseHeld(saved) {
  let list = saved;
  if (typeof saved === 'string') {
    try { list = JSON.parse(saved || '[]'); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r.key === 'string' && r.key
    && typeof r.kind === 'string' && typeof r.part === 'string')
    .map((r) => ({
      key: r.key, part: r.part, kind: r.kind,
      label: typeof r.label === 'string' ? r.label : '',
      at: typeof r.at === 'string' ? r.at : '',
      data: r.data && typeof r.data === 'object' ? r.data : {},
    }));
}

/**
 * Add a waiting change. One document has one entry: a later change to it
 * takes the earlier one's place in the list, with `merge` deciding what the
 * new entry carries from the old.
 * @param {Array} list
 * @param {{key: string, part: string, kind: string, label?: string, at?: string, data?: object}} change
 * @param {(before: object, next: object) => object} [merge]
 * @returns {Array} a new list
 */
export function holdChange(list, change, merge) {
  const at = list.findIndex((r) => r.key === change.key);
  const before = at >= 0 ? list[at] : null;
  const entry = {
    key: change.key, part: change.part, kind: change.kind,
    label: change.label ?? before?.label ?? '',
    at: change.at ?? new Date().toISOString(),
    data: before && merge ? merge(before, change) : (change.data ?? {}),
  };
  if (at < 0) return [...list, entry];
  return list.map((r, i) => (i === at ? entry : r));
}

/**
 * Remove a waiting change.
 * @param {Array} list
 * @param {string} key
 * @returns {Array} a new list, or the same one when the key is not in it
 */
export function dropHeld(list, key) {
  return list.some((r) => r.key === key) ? list.filter((r) => r.key !== key) : list;
}
