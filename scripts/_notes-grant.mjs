/**
 * Pure helpers for the player notebook: the addresses it opens, the checks
 * on every message it accepts from Chronicle, and which Chronicle page the
 * jot notes are about.
 *
 * The notes grant is a player's own token, made when they press Allow in
 * Chronicle. It reads and writes only that player's notes in one campaign,
 * so it is never the GM's sync key and never stored world-scoped.
 */

/** Chronicle's notes grant tokens all start with this. */
export const GRANT_TOKEN_PREFIX = 'cnt_';

/**
 * Chronicle's origin from the apiUrl setting, or '' when it isn't a usable
 * http(s) address.
 * @param {string} apiUrl
 * @returns {string}
 */
export function chronicleOrigin(apiUrl) {
  try {
    const u = new URL(String(apiUrl || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** apiUrl without a trailing slash; Chronicle may sit under a sub-path. */
function base(apiUrl) {
  return String(apiUrl || '').trim().replace(/\/+$/, '');
}

/**
 * The Allow window's address. `origin` is this Foundry's own address: the
 * window posts the token only back to it.
 */
export function allowUrl(apiUrl, campaignId, origin) {
  return `${base(apiUrl)}/campaigns/${encodeURIComponent(campaignId)}/notes/allow-app`
    + `?origin=${encodeURIComponent(origin)}`;
}

/** The frame page for the notebook ('journal') or the jot notes ('jots'). */
export function embedUrl(apiUrl, campaignId, mode) {
  return `${base(apiUrl)}/embed/campaigns/${encodeURIComponent(campaignId)}/notes/${mode}`;
}

/**
 * Decide whether a message from the Allow window is a grant this Foundry
 * user may keep.
 *
 * The GM's member matching is the check that the Chronicle account which
 * pressed Allow belongs to this Foundry login: a player signed in to
 * someone else's Chronicle account on a shared computer gets refused here
 * rather than seeing that person's notes.
 *
 * @param {{origin: string, data: any}} event - the message event
 * @param {object} ctx
 * @param {string} ctx.apiOrigin - chronicleOrigin(apiUrl)
 * @param {string} ctx.campaignId - the world's campaign
 * @param {string} ctx.foundryUserId - game.user.id
 * @param {Object<string,string>} ctx.mappings - userMappings (chronicleId → foundryId)
 * @returns {{kind: 'ignore'} | {kind: 'declined'} |
 *   {kind: 'refused', reason: 'unmapped'|'mismatch'|'campaign'} |
 *   {kind: 'grant', grant: {token: string, userId: string, campaignId: string}}}
 */
export function checkGrantMessage(event, ctx) {
  if (!event || !ctx.apiOrigin || event.origin !== ctx.apiOrigin) return { kind: 'ignore' };
  const d = event.data;
  if (!d || typeof d !== 'object') return { kind: 'ignore' };
  if (d.type === 'chronicle:notes-grant-declined') return { kind: 'declined' };
  if (d.type !== 'chronicle:notes-grant') return { kind: 'ignore' };
  if (typeof d.token !== 'string' || !d.token.startsWith(GRANT_TOKEN_PREFIX)) return { kind: 'ignore' };
  if (typeof d.userId !== 'string' || !d.userId) return { kind: 'ignore' };
  if (d.campaignId !== ctx.campaignId) return { kind: 'refused', reason: 'campaign' };
  const match = matchFor(d.userId, ctx);
  if (match !== 'ok') return { kind: 'refused', reason: match };
  return { kind: 'grant', grant: { token: d.token, userId: d.userId, campaignId: d.campaignId } };
}

/**
 * 'ok' when the GM matched chronicleUserId to this Foundry user; 'unmapped'
 * when the GM hasn't matched this Foundry user to anyone; 'mismatch' when
 * they matched it to a different Chronicle account.
 */
function matchFor(chronicleUserId, { foundryUserId, mappings }) {
  const map = mappings || {};
  if (map[chronicleUserId] === foundryUserId) return 'ok';
  const mine = Object.keys(map).some((k) => map[k] === foundryUserId);
  return mine ? 'mismatch' : 'unmapped';
}

/**
 * The stored grant for this Foundry user, if it still fits: same Chronicle,
 * same campaign, and the GM's matching hasn't moved since. Grants are kept
 * per Foundry user because client settings are per browser, and players
 * sometimes share one.
 *
 * @param {string} storedJson - the notesGrants client setting
 * @param {object} ctx - as checkGrantMessage
 * @returns {{token: string, userId: string, campaignId: string} | null}
 */
export function usableGrant(storedJson, ctx) {
  const all = parseGrants(storedJson);
  const g = all[ctx.foundryUserId];
  if (!g || typeof g !== 'object') return null;
  if (typeof g.token !== 'string' || !g.token.startsWith(GRANT_TOKEN_PREFIX)) return null;
  if (g.apiOrigin !== ctx.apiOrigin || g.campaignId !== ctx.campaignId) return null;
  if (matchFor(g.userId, ctx) !== 'ok') return null;
  return { token: g.token, userId: g.userId, campaignId: g.campaignId };
}

/** storedJson with this Foundry user's grant set (or removed, for null). */
export function withGrant(storedJson, foundryUserId, apiOrigin, grant) {
  const all = parseGrants(storedJson);
  if (grant) all[foundryUserId] = { ...grant, apiOrigin };
  else delete all[foundryUserId];
  return JSON.stringify(all);
}

function parseGrants(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Accept a message only from this frame's own window at Chronicle's origin.
 * @param {{origin: string, source: any, data: any}} event
 * @param {any} frameWindow - the iframe's contentWindow
 * @param {string} apiOrigin
 * @returns {object|null} the message data, or null to ignore it
 */
export function frameMessage(event, frameWindow, apiOrigin) {
  if (!event || !frameWindow || event.source !== frameWindow) return null;
  if (!apiOrigin || event.origin !== apiOrigin) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || typeof d.type !== 'string') return null;
  return d;
}

/**
 * Which Chronicle page the jot notes are about: the most recently opened
 * window, still open, that shows a Chronicle-linked document.
 */
export class PageTracker {
  constructor() {
    /** @type {Array<{appId: string, entityId: string}>} newest last */
    this._open = [];
  }

  /** A window showing entityId opened or came back to the front. */
  opened(appId, entityId) {
    this._open = this._open.filter((o) => o.appId !== appId);
    if (entityId) this._open.push({ appId, entityId });
  }

  /** A window closed. */
  closed(appId) {
    this._open = this._open.filter((o) => o.appId !== appId);
  }

  /** The entity id the jots should show, or '' for All my jots. */
  current() {
    return this._open.length ? this._open[this._open.length - 1].entityId : '';
  }
}
