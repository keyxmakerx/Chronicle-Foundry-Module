/**
 * The quest relay's wire rules. Players have no Chronicle key, so their
 * Quest Board asks the active GM's client over the module socket, and the GM
 * answers with Chronicle's players view. The GM side always asks Chronicle
 * for `audience=players`, whatever the request says: a player can never get
 * the GM's view through the relay. Pure, so tools/test-quest-relay.mjs pins it.
 */

export const QUEST_MESSAGE = 'chronicle.quests';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9]{8,32}$/;
// Chronicle's own quest routes share the /quests/:entityID path, so these
// names are never taken as a quest: /quests/party, for one, is a DM read.
const ROUTE_NAMES = new Set(['homes', 'boards', 'party', 'pay', 'give']);

/** Whether an id may name a quest page. */
export function isQuestId(id) {
  return typeof id === 'string' && ID.test(id) && !ROUTE_NAMES.has(id.toLowerCase());
}

/**
 * A player's request, checked, or null.
 * @returns {{requestId:string, what:'homes'|'boards'|'quest', kind?:string, id?:string}|null}
 */
export function sanitizeQuestRequest(data) {
  if (!data || data.type !== QUEST_MESSAGE || data.action !== 'ask') return null;
  if (typeof data.requestId !== 'string' || !REQUEST_ID.test(data.requestId)) return null;
  const { what } = data;
  if (what === 'homes') return { requestId: data.requestId, what };
  if (typeof data.id !== 'string' || !ID.test(data.id)) return null;
  if (what === 'quest') return isQuestId(data.id) ? { requestId: data.requestId, what, id: data.id } : null;
  if (what === 'boards') {
    if (data.kind === 'page') return { requestId: data.requestId, what, kind: 'page', id: data.id };
    if (data.kind === 'category' && /^\d+$/.test(data.id)) return { requestId: data.requestId, what, kind: 'category', id: data.id };
  }
  return null;
}

/** The Chronicle path a checked request reads: always the players view. */
export function questRequestPath(req) {
  switch (req?.what) {
    case 'homes': return '/quests/homes?audience=players';
    case 'boards': return `/quests/boards?${req.kind}=${encodeURIComponent(req.id)}&audience=players`;
    case 'quest': return `/quests/${encodeURIComponent(req.id)}?audience=players`;
    default: return null;
  }
}

/**
 * Per-player limit on questions, so one client cannot spend the GM's key in a
 * loop: at most `max` in any `windowMs`.
 */
export function makeAskLimiter({ max = 30, windowMs = 10000, now = () => Date.now() } = {}) {
  const seen = new Map();
  return (userId) => {
    const t = now();
    const recent = (seen.get(userId) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) { seen.set(userId, recent); return false; }
    recent.push(t);
    seen.set(userId, recent);
    return true;
  };
}

/** The status a failed Chronicle call is passed on as; nothing else of the error is. */
export function relayStatus(err) {
  const s = Number(err?.status);
  return s === 404 || s === 403 ? s : 502;
}
