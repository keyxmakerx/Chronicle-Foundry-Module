/**
 * Cut scenes in Foundry, as pure decisions.
 *
 * Chronicle sends a showing to the GM's client only (`cutscene.foundry`),
 * naming its viewers by Chronicle member id. The GM's client finds the
 * Foundry users those members are matched to and hands the scene to the
 * ones playing now. The module socket may reach every client, so the scene
 * itself never travels in the clear: the GM knocks on one user's client with
 * the showing id, that client answers with a one-off public key, and the
 * scene comes back encrypted to it (_stash-crypto.mjs). Every rule about who
 * may have a scene lives here:
 *
 *  - who asks is the Foundry user id the socket layer gives the listener,
 *    never a payload field;
 *  - a scene goes only to a user matched to one of the showing's viewers,
 *    and only while its rewatch window is open;
 *  - the watch-again list is asked for the asker's own member, never one
 *    named in the request;
 *  - a Director's preview plays on one GM's own screen and never goes on
 *    the module socket at all.
 *
 * tools/test-cutscene-relay.mjs pins these.
 */

import { chronicleUserFor } from './_stash-relay.mjs';

/** Module-socket message types, all under the module channel. */
export const CUTSCENE_MSG = Object.freeze({
  KNOCK: 'cutscene:knock',
  FETCH: 'cutscene:fetch',
  PLAY: 'cutscene:play',
  STOP: 'cutscene:stop',
  LIST: 'cutscene:list',
  LIST_REPLY: 'cutscene:list-reply',
});

/** Chronicle WebSocket types the GM's client acts on. */
export const CUTSCENE_WS = Object.freeze({
  SHOW: 'cutscene.foundry',
  STOP: 'cutscene.foundry_stop',
  PREVIEW: 'cutscene.foundry_preview',
});

/** A player who opens Foundry this soon after a showing started still gets it live. */
export const LATE_JOIN_MS = 2 * 60 * 1000;

/** Chronicle's add-on slug for Cut scenes. */
export const CUTSCENES_ADDON = 'cutscenes';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9]{8,32}$/;
const NAME_MAX = 200;

/** @param {any} msg @returns {boolean} */
export function isCutsceneMessage(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.type === 'string' && msg.type.startsWith('cutscene:');
}

/** Whether a string can be a showing id. */
export function isShowingId(id) {
  return typeof id === 'string' && ID.test(id);
}

/** A showing id from Chronicle (a UUID, or a number), as a string, or null. */
export function showingIdOf(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return isShowingId(id) ? id : null;
}

/** Whether a string can be a request id from `PendingRequests`. */
export function isRequestId(id) {
  return typeof id === 'string' && REQUEST_ID.test(id);
}

function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return NaN;
  return Date.parse(value);
}

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The scene as the engine takes it, keeping only the scene's own keys. The
 * engine validates each layer again and draws nothing for a kind it does
 * not know, so this only refuses a value that is not a scene at all.
 * @param {any} scene
 * @returns {object|null}
 */
export function cleanScene(scene) {
  if (!plainObject(scene)) return null;
  const out = {};
  if (typeof scene.id === 'string') out.id = scene.id;
  if (typeof scene.name === 'string') out.name = scene.name.slice(0, NAME_MAX);
  out.background = plainObject(scene.background) ? scene.background : { kind: 'none' };
  out.overlays = Array.isArray(scene.overlays) ? scene.overlays.filter(plainObject) : [];
  out.text = Array.isArray(scene.text) ? scene.text.filter(plainObject) : [];
  out.ending = plainObject(scene.ending) ? scene.ending : { kind: 'tap' };
  return out;
}

/**
 * One showing as the module keeps it: times as epoch milliseconds.
 * @typedef {object} Showing
 * @property {string} showingId
 * @property {string} name
 * @property {number} shownAt
 * @property {number} rewatchUntil
 * @property {object} scene
 */

/**
 * One showing from Chronicle (the WS payload, a list entry or a decrypted
 * reply), checked, or null.
 * @param {any} raw
 * @param {number} [fallbackShownAt] - when the payload carries no time
 * @returns {Showing|null}
 */
export function cleanShowing(raw, fallbackShownAt = Date.now()) {
  const showingId = plainObject(raw) ? showingIdOf(raw.showingId) : null;
  if (!showingId) return null;
  const scene = cleanScene(raw.scene);
  const rewatchUntil = timeOf(raw.rewatchUntil);
  if (!scene || !Number.isFinite(rewatchUntil)) return null;
  const shown = timeOf(raw.shownAt);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : (scene.name || '');
  return {
    showingId,
    name: name.slice(0, NAME_MAX),
    shownAt: Number.isFinite(shown) ? shown : fallbackShownAt,
    rewatchUntil,
    scene,
  };
}

/**
 * A `cutscene.foundry` payload, checked: the showing plus its viewers'
 * Chronicle member ids.
 * @param {any} payload
 * @param {number} now
 * @returns {(Showing & {viewers: string[]})|null}
 */
export function parseFoundryShowing(payload, now = Date.now()) {
  const showing = cleanShowing(payload, now);
  if (!showing) return null;
  const viewers = Array.isArray(payload.viewers)
    ? [...new Set(payload.viewers.filter((v) => (typeof v === 'string' && v) || typeof v === 'number').map(String))]
    : [];
  return { ...showing, viewers };
}

/**
 * A `cutscene.foundry_preview` payload, checked: the Director's unsaved
 * scene, who pressed Preview in Foundry (their Chronicle member id) and the
 * preview's id. Nothing is stored for a preview on either side.
 * @param {any} payload
 * @returns {{previewId: string, director: string, scene: object}|null}
 */
export function parseFoundryPreview(payload) {
  if (!plainObject(payload)) return null;
  const previewId = showingIdOf(payload.previewId);
  const scene = cleanScene(payload.scene);
  const director = typeof payload.director === 'string' || typeof payload.director === 'number' ? String(payload.director) : '';
  if (!previewId || !scene) return null;
  return { previewId, director, scene };
}

/**
 * Which Foundry client plays a Director's preview: the GM their Chronicle
 * member is matched to, when that GM is playing now; otherwise the active
 * GM, the one whose screen runs the table. Never a player's client, even
 * when the Director is matched to a player user.
 * @param {string} director - Chronicle member id
 * @param {Object<string,string>} mappings - `userMappings` (member → Foundry user)
 * @param {Array<{id: string, active: boolean, isGM: boolean}>} users
 * @param {string|null|undefined} activeGMId
 * @returns {string|null} the Foundry user id, or null when no GM is here
 */
export function previewPlayer(director, mappings, users, activeGMId) {
  const map = plainObject(mappings) ? mappings : {};
  const list = Array.isArray(users) ? users : [];
  const own = director ? list.find((u) => u?.id === map[director]) : null;
  if (own?.isGM && own.active) return own.id;
  const gm = activeGMId ? list.find((u) => u?.id === activeGMId) : null;
  return gm?.isGM ? gm.id : null;
}

/**
 * Which Foundry users a showing goes to now. A viewer matched to a user who
 * is playing gets it live; one matched to a user who is not here is away
 * (Chronicle keeps it in their watch-again list); one with no Foundry user
 * at all is left to Chronicle.
 * @param {string[]} viewers - Chronicle member ids
 * @param {Object<string,string>} mappings - `userMappings` (member → Foundry user)
 * @param {Array<{id: string, active: boolean}>} users - Foundry users
 * @returns {{deliver: string[], away: string[], unmapped: string[]}}
 */
export function viewerTargets(viewers, mappings, users) {
  const map = plainObject(mappings) ? mappings : {};
  const byId = new Map((Array.isArray(users) ? users : []).map((u) => [u?.id, u]));
  const deliver = [];
  const away = [];
  const unmapped = [];
  for (const member of new Set(Array.isArray(viewers) ? viewers : [])) {
    const fid = map[member];
    const user = fid ? byId.get(fid) : null;
    if (!user) unmapped.push(member);
    else if (user.active) { if (!deliver.includes(user.id)) deliver.push(user.id); }
    else away.push(member);
  }
  return { deliver, away, unmapped };
}

/**
 * Whether the GM's client may hand a showing's scene to the client that
 * asked. Only for live playback: a stopped showing is not started again.
 * @param {(Showing & {viewers: string[], stopped?: boolean})|null|undefined} showing
 * @param {string} senderId - Foundry user id from the socket layer
 * @param {Object<string,string>} mappings
 * @param {number} now
 * @returns {{ok: true, member: string}|{ok: false, reason: string}}
 */
export function mayFetch(showing, senderId, mappings, now = Date.now()) {
  if (!showing) return { ok: false, reason: 'unknown' };
  const member = chronicleUserFor(mappings, senderId);
  if (!member || !showing.viewers?.includes(member)) return { ok: false, reason: 'not_viewer' };
  if (showing.stopped) return { ok: false, reason: 'stopped' };
  if (!(showing.rewatchUntil > now)) return { ok: false, reason: 'expired' };
  return { ok: true, member };
}

/**
 * The live showings a user who just opened Foundry should still get: not
 * stopped, started within `LATE_JOIN_MS`, one of their member's, and not
 * already handed to them.
 * @param {Iterable<Showing & {viewers: string[], stopped?: boolean, delivered?: Set<string>}>} showings
 * @param {string} foundryUserId
 * @param {Object<string,string>} mappings
 * @param {number} now
 * @returns {string[]} showing ids, oldest first
 */
export function lateJoinShowings(showings, foundryUserId, mappings, now = Date.now()) {
  const member = chronicleUserFor(mappings, foundryUserId);
  if (!member) return [];
  return [...showings]
    .filter((s) => !s.stopped && now - s.shownAt <= LATE_JOIN_MS && s.rewatchUntil > now
      && s.viewers?.includes(member) && !s.delivered?.has(foundryUserId))
    .sort((a, b) => a.shownAt - b.shownAt)
    .map((s) => s.showingId);
}

/**
 * The sync API path for one member's watch-again list.
 * @param {string} member
 * @returns {string}
 */
export function showingsPath(member) {
  return `/cutscenes/showings?user=${encodeURIComponent(member)}`;
}

/**
 * Chronicle's list answer (bare array or `{data:[…]}`), checked.
 * @param {any} body
 * @param {number} now
 * @returns {Showing[]}
 */
export function cleanShowingList(body, now = Date.now()) {
  const rows = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
  return rows.map((r) => cleanShowing(r, now)).filter(Boolean);
}

/**
 * The showings still inside their rewatch window, newest first.
 * @param {Showing[]} list
 * @param {number} now
 * @returns {Showing[]}
 */
export function showingsWithin(list, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && s.rewatchUntil > now)
    .sort((a, b) => b.shownAt - a.shownAt || String(a.showingId).localeCompare(String(b.showingId)));
}

/**
 * Chronicle's list plus the showings this client received this session,
 * one row per showing (Chronicle's wins), expired ones gone.
 * @param {Showing[]} fromChronicle
 * @param {Showing[]} remembered
 * @param {number} now
 * @returns {Showing[]}
 */
export function mergeShowings(fromChronicle, remembered, now = Date.now()) {
  const byId = new Map();
  for (const s of Array.isArray(remembered) ? remembered : []) if (s?.showingId) byId.set(s.showingId, s);
  for (const s of Array.isArray(fromChronicle) ? fromChronicle : []) if (s?.showingId) byId.set(s.showingId, s);
  return showingsWithin([...byId.values()], now);
}

/**
 * How long until the next showing in the list leaves its window, so the
 * list can drop it then; null when nothing will. Capped so a far-off expiry
 * never overflows a timer.
 * @param {Showing[]} list
 * @param {number} now
 * @param {number} [cap]
 * @returns {number|null}
 */
export function nextExpiryDelay(list, now = Date.now(), cap = 6 * 60 * 60 * 1000) {
  let next = Infinity;
  for (const s of Array.isArray(list) ? list : []) {
    if (s?.rewatchUntil > now && s.rewatchUntil < next) next = s.rewatchUntil;
  }
  if (next === Infinity) return null;
  return Math.min(cap, Math.max(0, next - now) + 250);
}

/**
 * When a row's window closes, for "until 10:30 PM": the time alone today,
 * the weekday and time within a week, else the date and time.
 * @param {number} until
 * @param {number} now
 * @param {{locale?: string, timeZone?: string}} [opts]
 * @returns {string}
 */
export function untilLabel(until, now = Date.now(), { locale, timeZone } = {}) {
  const tz = timeZone ? { timeZone } : {};
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...tz }).format(until);
  const day = (ms) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...tz }).format(ms);
  if (day(until) === day(now)) return time;
  if (until - now < 6 * 24 * 60 * 60 * 1000) {
    return `${new Intl.DateTimeFormat(locale, { weekday: 'short', ...tz }).format(until)} ${time}`;
  }
  return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...tz }).format(until)} ${time}`;
}

/**
 * Whether Chronicle has the Cut scenes add-on on, from `GET /addons`
 * (bare array or `{data:[…]}`): true or false, or null when the list could
 * not be read, so a failed read never hides the tab.
 * @param {{error?: any, body?: any}} attempt
 * @returns {true|false|null}
 */
export function cutscenesVerdict(attempt) {
  if (attempt?.error) return null;
  const body = attempt?.body;
  const list = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null);
  if (!list) return null;
  const row = list.find((a) => a?.slug === CUTSCENES_ADDON);
  return !!row && row.enabled !== false;
}

/**
 * Turn a failed list call into the error code the Satchel words.
 * @param {any} err
 * @returns {{code: string}}
 */
export function listErrorFrom(err) {
  const status = Number(err?.status);
  if (status === 403) return { code: 'off' };
  if (status === 404) return { code: 'missing' };
  return { code: 'unreachable' };
}
