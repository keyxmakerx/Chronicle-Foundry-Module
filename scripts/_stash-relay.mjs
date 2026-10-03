/**
 * The player-to-GM relay for Stashes, as pure decisions.
 *
 * Only the GM's browser holds the API key, so a player's Stashes window asks
 * the active GM client over the module socket and the GM client calls
 * Chronicle on their behalf. Every rule about WHO is asking lives here:
 *
 *  - the Chronicle member acted for is derived from the Foundry user id the
 *    socket layer attached to the message (`senderId`), never from anything
 *    in the payload;
 *  - a payload `actingUserId` or `userId` is ignored outright;
 *  - the sender must own the character the request is about.
 *
 * The server applies the member's rules again; this is the second lock.
 */

/** Socket message types, all under the module channel. */
export const STASH_MSG = Object.freeze({
  REQUEST: 'stash:request',
  REPLY: 'stash:reply',
  DOWNTIME: 'stash:downtime',
  REFRESH: 'stash:refresh',
});

/** Request actions a player may relay. */
export const STASH_ACTION = Object.freeze({
  VIEW: 'view',
  MOVE: 'move',
  HISTORY: 'history',
});

/** How long a window waits for the GM client before giving up. */
export const RELAY_TIMEOUT_MS = 10000;

/** @param {any} msg @returns {boolean} */
export function isStashMessage(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.type === 'string' && msg.type.startsWith('stash:');
}

/**
 * The Chronicle member mapped to a Foundry user. `userMappings` is
 * chronicleUserId -> foundryUserId.
 * @param {Object<string,string>} mappings
 * @param {string} foundryUserId
 * @returns {string|null}
 */
export function chronicleUserFor(mappings, foundryUserId) {
  if (!foundryUserId || !mappings || typeof mappings !== 'object') return null;
  for (const [chronicleId, fid] of Object.entries(mappings)) {
    if (fid === foundryUserId && chronicleId) return chronicleId;
  }
  return null;
}

function bad(code, message) {
  return { ok: false, error: { code, message } };
}

const enc = encodeURIComponent;

/**
 * Decide what the GM client should do for one relayed request.
 *
 * @param {object} msg - the received socket message.
 * @param {object} ctx
 * @param {string} ctx.senderId - Foundry user id supplied by the socket layer.
 * @param {Object<string,string>} ctx.mappings - `userMappings`.
 * @param {(entityId: string) => boolean} ctx.senderOwns - whether the sender
 *   owns the linked actor for this Chronicle character id.
 * @param {(body: object) => {ok: boolean, body?: object, error?: string}} ctx.buildMove
 * @returns {{ok: true, call: {method: string, path: string, body?: object}}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function planRelay(msg, { senderId, mappings, senderOwns, buildMove }) {
  if (!msg || typeof msg !== 'object') return bad('bad_request', 'Malformed request.');
  if (!senderId || typeof senderId !== 'string') return bad('no_sender', 'Unknown sender.');

  const acting = chronicleUserFor(mappings, senderId);
  if (!acting) return bad('no_mapping', 'Your Foundry user is not linked to a Chronicle member.');

  const characterId = typeof msg.characterId === 'string' ? msg.characterId : '';
  if (!characterId) return bad('bad_request', 'No character named.');

  switch (msg.action) {
    case STASH_ACTION.VIEW: {
      // A window may look at a destination character's contents (the server
      // redacts for the member); that is allowed only from a window whose own
      // character the sender owns.
      const own = senderOwns(characterId);
      const peek = msg.contextCharacterId && senderOwns(String(msg.contextCharacterId));
      if (!own && !peek) return bad('not_owner', 'You do not own that character.');
      return {
        ok: true,
        call: { method: 'GET', path: `/stashes/view?characterId=${enc(characterId)}&actingUserId=${enc(acting)}` },
      };
    }
    case STASH_ACTION.HISTORY: {
      if (!senderOwns(characterId)) return bad('not_owner', 'You do not own that character.');
      return {
        ok: true,
        call: { method: 'GET', path: `/stashes/history?characterId=${enc(characterId)}&actingUserId=${enc(acting)}` },
      };
    }
    case STASH_ACTION.MOVE: {
      if (!senderOwns(characterId)) return bad('not_owner', 'You do not own that character.');
      const move = msg.move && typeof msg.move === 'object' ? msg.move : null;
      if (!move) return bad('bad_request', 'No move given.');
      const from = move.from;
      if (from?.kind === 'character' && !senderOwns(String(from.id))) {
        return bad('not_owner', 'You do not own the character this move comes from.');
      }
      // Rebuilt from fields, so anything extra in the payload (notably any
      // actingUserId) is dropped before the sender's own member id is added.
      const built = buildMove({
        kind: move.kind, itemId: move.itemId, quantity: move.quantity, amount: move.amount,
        from: move.from, to: move.to, actingUserId: acting,
      });
      if (!built.ok) return bad('bad_request', `Invalid move (${built.error}).`);
      return { ok: true, call: { method: 'POST', path: '/stashes/moves', body: built.body } };
    }
    default:
      return bad('bad_request', 'Unknown action.');
  }
}

/**
 * The API call for the GM's own window. No acting member is named, so the call
 * runs as the key holder (the GM) with no relay checks: the GM may open and
 * move for any linked character.
 *
 * @param {object} msg - same shape as a relayed request.
 * @param {{buildMove: Function}} ctx
 * @returns {{ok: true, call: object}|{ok: false, error: {code: string, message: string}}}
 */
export function planDirect(msg, { buildMove }) {
  const characterId = typeof msg?.characterId === 'string' ? msg.characterId : '';
  if (!characterId) return bad('bad_request', 'No character named.');
  switch (msg.action) {
    case STASH_ACTION.VIEW:
      return { ok: true, call: { method: 'GET', path: `/stashes/view?characterId=${enc(characterId)}` } };
    case STASH_ACTION.HISTORY:
      return { ok: true, call: { method: 'GET', path: `/stashes/history?characterId=${enc(characterId)}` } };
    case STASH_ACTION.MOVE: {
      const m = msg.move && typeof msg.move === 'object' ? msg.move : null;
      if (!m) return bad('bad_request', 'No move given.');
      const built = buildMove({ kind: m.kind, itemId: m.itemId, quantity: m.quantity, amount: m.amount, from: m.from, to: m.to });
      if (!built.ok) return bad('bad_request', `Invalid move (${built.error}).`);
      return { ok: true, call: { method: 'POST', path: '/stashes/moves', body: built.body } };
    }
    default:
      return bad('bad_request', 'Unknown action.');
  }
}

/**
 * Shape a Chronicle error for the wire so a player's window can show it
 * without a stack trace or the raw response body.
 * @param {any} err
 * @returns {{code: string, message: string, status?: number}}
 */
export function relayErrorFrom(err) {
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status === 404) return { code: 'not_found', message: err?.serverMessage || 'Not found.', status };
  if (status === 403) return { code: 'forbidden', message: err?.serverMessage || 'Not allowed.', status };
  if (status === 409) return { code: 'conflict', message: err?.data?.message || err?.serverMessage || 'That could not be applied.', status };
  if (status === 400) return { code: 'bad_request', message: err?.serverMessage || 'That was not accepted.', status };
  return { code: 'api_error', message: 'Chronicle could not be reached.', status };
}

/**
 * Pending requests from a window, each with a timeout. Timers are injectable
 * so the timeout paths are testable.
 */
export class PendingRequests {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {typeof setTimeout} [opts.setTimer]
   * @param {typeof clearTimeout} [opts.clearTimer]
   * @param {() => string} [opts.makeId]
   */
  constructor({ timeoutMs = RELAY_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, makeId } = {}) {
    this._timeoutMs = timeoutMs;
    this._set = setTimer;
    this._clear = clearTimer;
    this._seq = 0;
    this._makeId = makeId || (() => `r${Date.now().toString(36)}${(this._seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    /** @type {Map<string, {resolve: Function, timer: any}>} */
    this._map = new Map();
  }

  /** Number of requests awaiting an answer. */
  get size() { return this._map.size; }

  /**
   * Register a request.
   * @param {any} [owner] - who is waiting, for scoped cancellation.
   * @returns {{id: string, promise: Promise<any>}} The promise resolves with
   *   the reply, or with `{ok:false,error:{code:'timeout'}}` if none comes.
   */
  create(owner = null) {
    const id = this._makeId();
    const promise = new Promise((resolve) => {
      const timer = this._set(() => {
        if (this._map.delete(id)) resolve({ ok: false, error: { code: 'timeout', message: 'No answer from the GM.' } });
      }, this._timeoutMs);
      this._map.set(id, { resolve, timer, owner });
    });
    return { id, promise };
  }

  /**
   * Deliver a reply. Replies for unknown ids (late, or meant for someone
   * else) are ignored.
   * @param {string} id
   * @param {object} reply
   * @returns {boolean} whether it matched a waiting request.
   */
  settle(id, reply) {
    const entry = this._map.get(id);
    if (!entry) return false;
    this._map.delete(id);
    this._clear(entry.timer);
    entry.resolve(reply);
    return true;
  }

  /**
   * Fail what is waiting: everything, or only the requests made for `owner`
   * (a closing window must not cancel another window's requests).
   * @param {any} [owner]
   */
  cancelAll(owner) {
    for (const [id, entry] of this._map) {
      if (owner !== undefined && entry.owner !== owner) continue;
      this._clear(entry.timer);
      entry.resolve({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
      this._map.delete(id);
    }
  }
}

/**
 * Whether this client should answer relayed requests: the user must be a GM
 * and be the active one, so two GMs never both answer.
 * @param {{isGM: boolean, id: string}} user
 * @param {{id: string}|null|undefined} activeGM
 * @returns {boolean}
 */
export function isAnsweringGM(user, activeGM) {
  return !!user?.isGM && !!activeGM && activeGM.id === user.id;
}
