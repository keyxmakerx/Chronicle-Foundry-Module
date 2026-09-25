/**
 * Shared entity-list page walk, used by both places that need "every
 * entity in the campaign" (JournalSync.resyncAll, the dashboard's entity
 * groups). Never hard-code a small page cap: a silent ceiling means
 * entities are never seen at all while the caller reports a completed
 * resync, which is worse than no cap. Use `walkEntityPages` and surface
 * its `truncated` flag instead.
 *
 * Pure — no Foundry globals, no api-client import — so both callers share
 * one implementation instead of two that drift. See
 * tools/test-entity-page-walk.mjs.
 */

/** Page size used for entity list requests. Matches Chronicle's list default. */
export const ENTITY_PAGE_SIZE = 100;

/**
 * Upper bound on pages walked in one pass: 200 pages x 100 = 20,000
 * entities. A bound is still needed — a broken server that always answers
 * with a full page would otherwise spin forever — but hitting it must be
 * reported (`truncated`), never silently swallowed.
 */
export const MAX_ENTITY_PAGES = 200;

/**
 * Walk the entity list to exhaustion.
 *
 * @param {(page: number, perPage: number) => Promise<unknown>} fetchPage
 *   Fetches one page. Receives the 1-based page number and the page size.
 * @param {(raw: unknown) => Array<object>} normalize
 *   Unwraps the response into an array. Chronicle returns some list endpoints
 *   bare and some enveloped, so every caller must unwrap defensively; the
 *   caller passes in whichever unwrapper it already owns.
 * @param {{pageSize?: number, maxPages?: number}} [opts]
 * @returns {Promise<{entities: Array<object>, truncated: boolean, pages: number}>}
 *   `truncated` is true only when the walk stopped at maxPages with a full
 *   page still coming back — i.e. entities certainly exist that this pass did
 *   not see. Callers must surface it.
 */
export async function walkEntityPages(fetchPage, normalize, opts = {}) {
  const pageSize = opts.pageSize || ENTITY_PAGE_SIZE;
  const maxPages = opts.maxPages || MAX_ENTITY_PAGES;

  const all = [];
  let page = 1;
  let truncated = false;

  for (;;) {
    const batch = normalize(await fetchPage(page, pageSize)) || [];
    if (batch.length === 0) break;
    all.push(...batch);

    // A short page is the end of the list. Only a FULL page means there may
    // be more, which is also why an exact multiple costs one extra request
    // rather than guessing.
    if (batch.length < pageSize) break;

    page += 1;
    if (page > maxPages) {
      truncated = true;
      break;
    }
  }

  return { entities: all, truncated, pages: page };
}
