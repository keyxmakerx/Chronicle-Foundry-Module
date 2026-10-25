/**
 * Which monster in Foundry each creature page is, as Chronicle matches them
 * (GET /foundry-matches): a page matched to a monster Foundry reported plays
 * with Foundry's numbers or with the page's own, as the DM chose on the page.
 * Playing Foundry's numbers, the page makes no actor here and a fight places
 * Foundry's own monster; playing the page's, only the page's own actor will
 * do. Pure; see tools/test-creature-matches.mjs.
 */

/**
 * The matches by page id. Accepts `{data:[…]}` or a bare array; entries
 * without a page id are dropped.
 * @param {*} raw
 * @returns {Map<string, object>}
 */
export function unwrapMatches(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const out = new Map();
  for (const m of list) {
    if (m && typeof m.entityId === 'string' && m.entityId) out.set(m.entityId, m);
  }
  return out;
}

/** True when the page is matched and Foundry's numbers play. */
export function playsFoundry(match) {
  return !!(match && match.state === 'matched' && match.use === 'foundry' && match.monster?.name);
}

/** True when the page is matched but its own numbers play. */
export function playsPage(match) {
  return !!(match && (match.state === 'matched' || match.state === 'missing') && match.use === 'page');
}

/**
 * A fight row as it plays: a row whose page plays Foundry's numbers is placed
 * as Foundry's monster (`foundryMonster`), and one whose page plays its own
 * numbers takes only the page's actor (`pageOnly`). Other rows are unchanged.
 * @param {{entityId?: string}} row
 * @param {Map<string, object>|null} matches
 */
export function rowAsPlayed(row, matches) {
  const m = row?.entityId ? matches?.get(row.entityId) : null;
  if (playsFoundry(m)) return { ...row, foundryMonster: { name: m.monster.name, pack: m.monster.pack ?? '' } };
  if (playsPage(m)) return { ...row, pageOnly: true };
  return row;
}
