/**
 * The Crafting tab's relay, as pure decisions.
 *
 * The tab runs Chronicle's own Crafting block (vendored) against the
 * module's Chronicle stand-in. Players hold no API key, so each of the
 * block's calls goes to the active GM's client over the module socket, and
 * the GM's client calls Chronicle with the player's own member as
 * `actingUserId`. As with Stashes and the shop room:
 *
 *  - who is asking comes from the socket layer's sender, never the payload;
 *  - a request is rebuilt from known fields, so nothing extra (notably an
 *    `actingUserId`) passes through;
 *  - the sender must own the character the request is about.
 *
 * Chronicle applies the member's rules again; this is the second lock.
 * Unit-tested by tools/test-craft-relay.mjs.
 */

import { isPublicJwk } from './_stash-crypto.mjs';

/** Socket message type for crafting requests and answers. */
export const CRAFT_MESSAGE = 'craft';

/** What a player may ask for, one per call the Crafting block makes. */
export const CRAFT_ACTIONS = Object.freeze(['view', 'start', 'roll', 'cancel', 'take', 'study']);

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// How a bench's steps went, as Chronicle's roll route takes it; a roll made
// without the bench is "skipped".
const WORK = new Set(['clean', 'botched', 'steady', 'skipped']);
const MAX_PICKS = 50;
const MAX_SLOT = 99;
const MAX_REPLY_CHARS = 64 * 1024;
// The hero's view carries the pack, every known recipe and the tray.
export const MAX_VIEW_REPLY_CHARS = 1024 * 1024;

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const lineNo = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/**
 * Turn one of the Crafting block's calls into a relay action, or null for a
 * call the tab doesn't make (the Director's editors stay on Chronicle).
 * `base` is the block's own prefix, `/campaigns/<id>/crafting`.
 * @param {string} base
 * @param {string} url
 * @param {string} method
 * @param {any} body
 * @returns {{action: string, characterId?: string, projectId?: string, lineId?: number, body?: object}|null}
 */
export function craftActionFor(base, url, method, body) {
  if (typeof url !== 'string' || !url.startsWith(`${base}/`)) return null;
  const parts = url.slice(base.length + 1).split('/').map((p) => {
    try { return decodeURIComponent(p); } catch { return ''; }
  });
  const m = String(method || 'GET').toUpperCase();
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const [a, id, c, d] = parts;
  if (a === 'characters' && parts.length === 2 && m === 'GET') return { action: 'view', characterId: id };
  if (a === 'characters' && c === 'projects' && parts.length === 3 && m === 'POST') {
    return { action: 'start', characterId: id, body: { recipeId: b.recipeId, picks: b.picks } };
  }
  if (a === 'projects' && c === 'roll' && parts.length === 3 && m === 'POST') {
    return { action: 'roll', projectId: id, body: { work: b.work, bench: b.bench, version: b.version } };
  }
  if (a === 'projects' && parts.length === 2 && m === 'DELETE') return { action: 'cancel', projectId: id };
  if (a === 'spoil-lines' && (c === 'take' || c === 'study') && parts.length === 3 && m === 'POST' && d === undefined) {
    return { action: c, lineId: lineNo(id), characterId: b.characterId };
  }
  return null;
}

/**
 * Check a player's crafting request before the GM's client acts on it.
 * Returns a cleaned copy built only from the fields each action takes, or
 * null.
 */
export function sanitizeCraftRequest(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== CRAFT_MESSAGE) return null;
  if (!CRAFT_ACTIONS.includes(msg.action)) return null;
  if (!isId(msg.requestId) || !isId(msg.characterId) || !isPublicJwk(msg.publicKey)) return null;
  const out = { action: msg.action, requestId: msg.requestId, characterId: msg.characterId, publicKey: msg.publicKey };
  const b = msg.body && typeof msg.body === 'object' && !Array.isArray(msg.body) ? msg.body : {};
  switch (msg.action) {
    case 'view':
      return out;
    case 'start': {
      if (!isId(b.recipeId)) return null;
      const picks = {};
      const given = b.picks && typeof b.picks === 'object' && !Array.isArray(b.picks) ? b.picks : {};
      const slots = Object.keys(given);
      if (slots.length > MAX_PICKS) return null;
      for (const slot of slots) {
        const n = Number(slot);
        if (!Number.isInteger(n) || n < 0 || n > MAX_SLOT || String(n) !== slot || !isId(given[slot])) return null;
        picks[slot] = given[slot];
      }
      out.body = { recipeId: b.recipeId, picks };
      return out;
    }
    case 'roll': {
      const work = b.work;
      const bench = b.bench ?? '';
      const version = Number(b.version);
      if (!isId(msg.projectId) || !WORK.has(work) || (bench !== '' && !isId(bench))) return null;
      if (!Number.isSafeInteger(version) || version < 0) return null;
      out.projectId = msg.projectId;
      out.body = { work, bench, version };
      return out;
    }
    case 'cancel':
      if (!isId(msg.projectId)) return null;
      out.projectId = msg.projectId;
      return out;
    default: {
      // take and study: the line, for the request's own character.
      const lineId = lineNo(msg.lineId);
      if (!lineId) return null;
      out.lineId = lineId;
      return out;
    }
  }
}

const enc = encodeURIComponent;

/**
 * The Chronicle call for a cleaned request. `actingUserId` is the member a
 * player's request is made for; null for the GM's own tab, which runs as the
 * key holder.
 * @returns {{method: string, path: string, body?: object}}
 */
export function planCraftCall(req, actingUserId = null) {
  const q = actingUserId ? `?actingUserId=${enc(actingUserId)}` : '';
  const acting = actingUserId ? { actingUserId } : {};
  switch (req.action) {
    case 'view':
      return { method: 'GET', path: `/crafting/characters/${enc(req.characterId)}${q}` };
    case 'start':
      return { method: 'POST', path: `/crafting/characters/${enc(req.characterId)}/projects`, body: { ...req.body, ...acting } };
    case 'roll':
      return { method: 'POST', path: `/crafting/projects/${enc(req.projectId)}/roll`, body: { ...req.body, ...acting } };
    case 'cancel':
      return { method: 'DELETE', path: `/crafting/projects/${enc(req.projectId)}${q}` };
    default:
      return { method: 'POST', path: `/crafting/spoil-lines/${req.lineId}/${req.action}`, body: { characterId: req.characterId, ...acting } };
  }
}

/**
 * Check the GM's answer, once decrypted, before the player's block reads
 * it. Returns `{status, body}`, or null.
 */
export function sanitizeCraftReply(inner, action) {
  if (!inner || typeof inner !== 'object') return null;
  const status = Number(inner.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  const body = inner.body ?? null;
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return null;
  const limit = action === 'view' ? MAX_VIEW_REPLY_CHARS : MAX_REPLY_CHARS;
  if (JSON.stringify(body).length > limit) return null;
  return { status, body };
}

/**
 * The GM's chat line for a take, harvest, study or finished project, or ""
 * for a call that needs none. Plain text; the caller escapes it. `who` is
 * the Foundry user, named when it isn't the hero.
 */
export function describeCraft({ action, who, result }) {
  const r = result && typeof result === 'object' ? result : {};
  const hero = String(r.hero || r.project?.hero || 'A hero');
  const by = who && who !== hero ? ` (${who})` : '';
  const rolled = Number.isFinite(r.total) ? ` (rolled ${r.total})` : '';
  switch (action) {
    case 'take': {
      const item = String(r.item || 'something');
      if (Array.isArray(r.dice) && r.dice.length) {
        return r.got === 'nothing'
          ? `${hero}${by} harvested ${item}${rolled} and got nothing.`
          : `${hero}${by} harvested ${item}${rolled}: ${r.got || item}.`;
      }
      return `${hero}${by} took ${r.got || item}.`;
    }
    case 'study':
      if (r.known) return `${hero}${by} studied a find${rolled} and identified it as ${r.item || 'an item'}.`;
      if (r.lost) return `${hero}${by} studied a find${rolled} and it was lost.`;
      return `${hero}${by} studied a find${rolled} and didn't identify it.`;
    case 'roll': {
      const p = r.project;
      if (!p || p.status !== 'made') return '';
      return `${hero}${by} finished ${p.name || 'a project'}${p.makes ? `: ${p.makes}` : ''}.`;
    }
    default:
      return '';
  }
}

/** Whether an action changes what the hero carries, so the actor is re-read. */
export function changesPack(action, result) {
  if (action === 'take' || action === 'start') return true;
  return action === 'roll' && result?.project?.status === 'made';
}

/**
 * Turn the GM client's probe (the Director's tray) into a verdict: true when
 * it answered, false for an older Chronicle without the routes (404) or the
 * crafting addon switched off, null for anything else, which leaves the
 * shared answer as it was.
 * @param {{error?: any}} attempt
 * @returns {true|false|null}
 */
export function craftingProbeVerdict(attempt) {
  const err = attempt?.error;
  if (!err) return true;
  if (err.status === 404) return false;
  if (err.status === 403 && err.code === 'addon_disabled') return false;
  return null;
}
