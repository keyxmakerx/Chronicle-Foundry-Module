/**
 * Walk `GET /sync/pull` to the end. The endpoint returns rows ordered by
 * `updated_at` with `has_more`, filters with a strict `updated_at > since`,
 * and has no cursor. Resuming from the last row's own timestamp would skip
 * rows that share it beyond the page edge, so the next page starts just
 * before that timestamp and rows already seen are dropped by id. The caller
 * must keep the FIRST response's `server_time` as its next starting point,
 * and only after the whole walk and its processing succeeded.
 *
 * Pure — see tools/test-sync-pull-walk.mjs.
 */

/** Rows asked for per page (the server's maximum). */
export const PULL_PAGE_SIZE = 1000;

/** Hard stop for a server that keeps answering has_more. */
export const MAX_PULL_PAGES = 500;

/** One millisecond before `ts`, as RFC3339; null when `ts` doesn't parse. */
function justBefore(ts) {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms - 1).toISOString() : null;
}

/**
 * @param {(since: string) => Promise<{mappings?: Array<{updated_at?: string}>, has_more?: boolean, server_time?: string}>} fetchPage
 * @param {string} since - Starting point (RFC3339).
 * @returns {Promise<{mappings: object[], serverTime: string|undefined, complete: boolean}>}
 *   `complete` is false when the walk stopped early (no forward progress or
 *   the page bound), so the caller must not advance its saved time.
 */
export async function walkSyncPull(fetchPage, since) {
  const mappings = [];
  const seen = new Set();
  let serverTime;
  let cursor = since;
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const res = await fetchPage(cursor);
    if (page === 0) serverTime = res?.server_time;
    const rows = Array.isArray(res?.mappings) ? res.mappings : [];
    let fresh = 0;
    for (const row of rows) {
      const key = row?.id ?? JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      mappings.push(row);
      fresh++;
    }
    if (!res?.has_more) return { mappings, serverTime, complete: true };
    const lastTs = rows.length ? rows[rows.length - 1]?.updated_at : undefined;
    let next = justBefore(lastTs);
    // A whole page at one timestamp can't be paged through with a strict
    // `>` and no cursor; step past it rather than repeat it forever. Only
    // rows at that exact second beyond a full page are missed.
    if (next && (next === cursor || fresh === 0)) next = lastTs;
    // No timestamp to resume from, or no forward progress: stop rather than
    // loop forever, and tell the caller the walk is incomplete.
    if (!next || next === cursor) return { mappings, serverTime, complete: false };
    cursor = next;
  }
  return { mappings, serverTime, complete: false };
}
