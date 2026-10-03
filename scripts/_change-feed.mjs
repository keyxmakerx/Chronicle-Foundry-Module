/**
 * Chronicle's change feed (`GET /sync/changes?since=<seq>`): ids of what
 * changed after a cursor, so a reconnect refetches only those instead of
 * rescanning every page. The cursor is saved only after the changes have
 * been applied, so a crash or failed apply replays them; replays are
 * harmless because every apply skips a document already at that version.
 *
 * Pure — see tools/test-change-feed.mjs.
 */

/** Rows asked for per page (the server's maximum). */
export const FEED_PAGE_SIZE = 1000;

/**
 * Chronicle leaves feed rows younger than 2 s out of a read, so a cursor never
 * passes a change still committing. A client reads this long after its
 * socket opened, so everything from before the socket is old enough to show.
 */
export const FEED_SETTLE_MS = 2500;

/** Hard stop for a server that keeps answering hasMore. */
export const MAX_FEED_PAGES = 200;

/**
 * Walk the feed from `since` to its end.
 *
 * @param {(since: number) => Promise<{changes?: object[], next?: number, hasMore?: boolean, resetRequired?: boolean}>} fetchPage
 * @param {number} since
 * @returns {Promise<{changes: object[], next: number, resetRequired: boolean, complete: boolean, types: string[]|null}>}
 *   `resetRequired`: `since` is older than the feed keeps, so the caller must
 *   do a full rescan and resume from `next`. `complete` is false when the
 *   walk stopped at the page bound; `next` is then where it stopped, which is
 *   still a correct cursor for what was returned. `types`: the resource types
 *   the server records, or null from a server that does not say.
 */
export async function walkChangeFeed(fetchPage, since) {
  const changes = [];
  let cursor = since;
  let types = null;
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const res = await fetchPage(cursor);
    const next = Number(res?.next);
    if (!Number.isFinite(next)) throw new Error('change feed: response has no next cursor');
    if (Array.isArray(res?.types)) types = res.types.filter((t) => typeof t === 'string');
    if (res?.resetRequired) return { changes: [], next, resetRequired: true, complete: true, types };
    if (Array.isArray(res?.changes)) changes.push(...res.changes);
    // No forward progress would loop forever; treat it as the end.
    if (!res?.hasMore || next <= cursor) return { changes, next, resetRequired: false, complete: true, types };
    cursor = next;
  }
  return { changes, next: cursor, resetRequired: false, complete: false, types };
}

/**
 * Collapse a run of changes to one outcome per resource of `type`, in feed
 * order: `deleted` when the last change deleted it, else `created` when the
 * run created it, else `updated`.
 *
 * @param {Array<{type?: string, resourceId?: string, op?: string}>} changes
 * @param {string} type
 * @returns {Map<string, 'created'|'updated'|'deleted'>}
 */
export function collapseChanges(changes, type) {
  const out = new Map();
  for (const c of changes || []) {
    if (c?.type !== type || !c.resourceId) continue;
    const prev = out.get(c.resourceId);
    if (c.op === 'deleted') out.set(c.resourceId, 'deleted');
    else if (c.op === 'created' || prev === 'created') out.set(c.resourceId, 'created');
    else out.set(c.resourceId, 'updated');
  }
  return out;
}

/**
 * The saved cursor for this campaign, or null. A cursor saved for another
 * campaign (the GM switched) is not this campaign's position.
 *
 * `createdAfter` moves with the cursor, never on its own: a page created
 * after it and still without a journal is new. Were it the sync time, a
 * failed catch-up would leave the cursor behind while the sync time moved
 * on, and the replay would no longer count that page as new.
 *
 * `types` are the resource types the server recorded when the cursor was
 * saved: a type outside them may have changed unrecorded since, so an area
 * that needs it cannot trust the delta (see feedForArea).
 *
 * @param {{campaignId?: string, seq?: number, areas?: string[], createdAfter?: string, types?: string[]}|null|undefined} saved
 * @param {string} campaignId
 * @returns {{seq: number, areas: string[], createdAfter: string|null, types: string[]}|null}
 */
export function cursorFor(saved, campaignId) {
  if (!saved || typeof saved !== 'object' || saved.campaignId !== campaignId) return null;
  const seq = Number(saved.seq);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return {
    seq,
    areas: Array.isArray(saved.areas) ? saved.areas : [],
    createdAfter: typeof saved.createdAfter === 'string' && saved.createdAfter ? saved.createdAfter : null,
    types: Array.isArray(saved.types) ? saved.types : [],
  };
}

/**
 * What one sync area gets at connect: the collapsed changes when the saved
 * cursor was taken while that area was syncing, else a full rescan. An area
 * switched off when the cursor last moved has missed changes the feed has
 * since moved past. An area whose changes are recorded as `needsType` also
 * rescans unless the server was recording that type when the cursor was
 * saved (an older Chronicle, or one upgraded since, may not have been).
 *
 * @param {{mode: 'delta'|'full', changes?: object[]}|null} feed
 * @param {{seq: number, areas: string[], createdAfter: string|null, types?: string[]}|null} cursor
 * @param {string} area
 * @param {string} [needsType]
 * @returns {{mode: 'delta', changes: object[], createdAfter: string|null}|{mode: 'full'}}
 */
export function feedForArea(feed, cursor, area, needsType) {
  const recorded = !needsType || (cursor?.types || []).includes(needsType);
  if (feed?.mode === 'delta' && cursor?.areas?.includes(area) && recorded) {
    return { mode: 'delta', changes: feed.changes || [], createdAfter: cursor.createdAfter };
  }
  return { mode: 'full' };
}
