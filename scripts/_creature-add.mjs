/**
 * Creature pages reach Foundry when they are used: a fight places one
 * (`CreatureSync.ensureActor`), or the DM presses "Add to Foundry" on the
 * page, which Chronicle sends as `creature_add.requested` and records in the
 * change feed. A request is acted on once: the highest `seq` handled per page
 * is kept, so a feed replay or the live copy of a request already handled
 * never brings back an actor the GM deleted since. Pure; see
 * tools/test-creature-add.mjs.
 */

/** The feed's resource type for an "Add to Foundry" request. */
export const ADD_TYPE = 'creature_add';

/**
 * The newest request per page in a run of feed rows.
 * @param {Array<{type?: string, resourceId?: string, seq?: number}>} changes
 * @returns {Map<string, number>} page id -> highest seq.
 */
export function addRequests(changes) {
  const out = new Map();
  for (const c of changes || []) {
    if (c?.type !== ADD_TYPE || !c.resourceId) continue;
    const seq = Number(c.seq) || 0;
    if (!out.has(c.resourceId) || seq > out.get(c.resourceId)) out.set(c.resourceId, seq);
  }
  return out;
}

/**
 * Whether a request still needs acting on. A request with no seq (Chronicle
 * could not record it) is always acted on; making an actor that exists does
 * nothing.
 * @param {Object<string, number>|null} handled - page id -> highest seq handled.
 * @param {string} entityId
 * @param {number} [seq]
 * @returns {boolean}
 */
export function isNewAdd(handled, entityId, seq) {
  const n = Number(seq) || 0;
  if (!entityId) return false;
  if (!n) return true;
  return n > (Number(handled?.[entityId]) || 0);
}

/**
 * The handled record after acting on a request; a request with no seq is
 * not recorded.
 * @param {Object<string, number>|null} handled
 * @param {string} entityId
 * @param {number} [seq]
 * @returns {Object<string, number>}
 */
export function recordAdd(handled, entityId, seq) {
  const out = { ...(handled && typeof handled === 'object' ? handled : {}) };
  const n = Number(seq) || 0;
  if (entityId && n > (Number(out[entityId]) || 0)) out[entityId] = n;
  return out;
}
