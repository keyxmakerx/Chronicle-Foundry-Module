/**
 * Pure helpers for the Stashes window: unwrapping Chronicle's stash
 * responses, validating a move before it is sent, and the wording rule that
 * tells the person whether a move happens now or needs the GM.
 *
 * Kept free of Foundry globals so the shapes the server really sends (see
 * API-CONTRACT.md, "Stashes") are pinned by tools/test-stash-model.mjs.
 */

/** Longest history the server returns; also the most the window shows. */
export const HISTORY_LIMIT = 50;

/** Move kinds on the wire. */
export const MOVE_KIND = Object.freeze({ ITEM: 'item', MONEY: 'money' });

/** Endpoint kinds on the wire. */
export const ENDPOINT_KIND = Object.freeze({ CHARACTER: 'character', STASH: 'stash' });

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function list(raw, ...keys) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of keys) if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

/**
 * One item line. The server keys it `itemId`; a missing quantity is one.
 * @param {object} raw
 * @returns {{itemId: string, name: string, quantity: number}|null}
 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = str(raw.itemId ?? raw.id);
  if (!itemId) return null;
  const q = Math.floor(num(raw.quantity ?? 1));
  return { itemId, name: str(raw.name) || itemId, quantity: q > 0 ? q : 1 };
}

function items(raw) {
  return list(raw).map(normalizeItem).filter(Boolean);
}

/**
 * Normalize a GET /stashes/view answer. Ids are always strings (a stash id may
 * arrive as a number from an older build); arrays default to empty.
 * @param {any} raw
 * @returns {object|null} null when the answer has no character.
 */
export function normalizeView(raw) {
  if (!raw || typeof raw !== 'object' || !raw.character || typeof raw.character !== 'object') return null;
  const c = raw.character;
  return {
    downtimeOpen: raw.downtimeOpen === true,
    canApprove: raw.canApprove === true,
    character: {
      id: str(c.id),
      name: str(c.name),
      // Empty when the character's system has no money field.
      moneyKey: str(c.moneyKey),
      money: num(c.money),
      items: items(c.items),
    },
    stashes: list(raw.stashes).map((s) => ({
      id: str(s?.id),
      name: str(s?.name),
      money: num(s?.money),
      items: items(s?.items),
    })).filter((s) => s.id),
    destinations: list(raw.destinations).map((d) => ({
      kind: str(d?.kind),
      id: str(d?.id),
      name: str(d?.name),
    })).filter((d) => d.id && (d.kind === ENDPOINT_KIND.CHARACTER || d.kind === ENDPOINT_KIND.STASH)),
  };
}

/**
 * One history or request line. Names are already resolved (and redacted) by
 * the server for the acting member.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id ?? raw.moveId);
  if (!id) return null;
  return {
    id,
    kind: str(raw.kind),
    status: str(raw.status),
    quantity: Math.floor(num(raw.quantity)),
    amount: num(raw.amount),
    itemName: str(raw.itemName),
    fromName: str(raw.fromName),
    toName: str(raw.toName),
    requesterName: str(raw.requesterName),
    requestedBy: str(raw.requestedBy),
    decidedBy: str(raw.decidedBy),
    reason: str(raw.reason),
    summary: str(raw.summary),
    createdAt: str(raw.createdAt),
    from: raw.from && typeof raw.from === 'object' ? { kind: str(raw.from.kind), id: str(raw.from.id) } : null,
    to: raw.to && typeof raw.to === 'object' ? { kind: str(raw.to.kind), id: str(raw.to.id) } : null,
  };
}

/**
 * Unwrap GET /stashes/history: `{history:[…]}`, or a bare/enveloped array from
 * a build that differs. Newest rows first, capped at the server's limit.
 * @param {any} raw
 * @returns {object[]}
 */
export function unwrapHistory(raw) {
  return list(raw, 'history', 'data').map(normalizeLine).filter(Boolean).slice(0, HISTORY_LIMIT);
}

/**
 * Unwrap GET /stashes/requests: `{requests:[…]}` or a bare/enveloped array.
 * @param {any} raw
 * @returns {object[]}
 */
export function unwrapRequests(raw) {
  return list(raw, 'requests', 'data').map(normalizeLine).filter(Boolean);
}

/**
 * Read a typed amount. Accepts "3", "3.5" and "3,5"; at most two decimals.
 * @param {any} text
 * @returns {number|null} null when it is not a positive amount.
 */
export function parseAmount(text) {
  const s = str(text).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/**
 * Money for display: whole numbers bare, otherwise two decimals.
 * @param {number} n
 * @returns {string}
 */
export function formatMoney(n) {
  const v = num(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function endpointOf(e) {
  if (!e || typeof e !== 'object') return null;
  const kind = str(e.kind);
  const id = str(e.id);
  if (!id || (kind !== ENDPOINT_KIND.CHARACTER && kind !== ENDPOINT_KIND.STASH)) return null;
  return { kind, id };
}

/**
 * Build and validate the POST /stashes/moves body. `actingUserId` is added
 * only when given: the GM's own window never sends it, and the relay sets it
 * itself from the socket sender.
 *
 * @param {object} p
 * @param {'item'|'money'} p.kind
 * @param {string} [p.itemId]
 * @param {number|string} [p.quantity]
 * @param {number|string} [p.amount]
 * @param {{kind: string, id: string}} p.from
 * @param {{kind: string, id: string}} p.to
 * @param {string} [p.actingUserId]
 * @returns {{ok: true, body: object}|{ok: false, error: string}}
 */
export function buildMovePayload({ kind, itemId, quantity, amount, from, to, actingUserId } = {}) {
  const f = endpointOf(from);
  const t = endpointOf(to);
  if (!f || !t) return { ok: false, error: 'endpoint' };
  if (f.kind === t.kind && f.id === t.id) return { ok: false, error: 'same' };

  const body = { kind, from: f, to: t };
  if (kind === MOVE_KIND.ITEM) {
    const id = str(itemId);
    const q = Number(quantity);
    if (!id) return { ok: false, error: 'item' };
    if (!Number.isInteger(q) || q < 1) return { ok: false, error: 'quantity' };
    body.itemId = id;
    body.quantity = q;
  } else if (kind === MOVE_KIND.MONEY) {
    const a = typeof amount === 'number' ? parseAmount(String(amount)) : parseAmount(amount);
    if (a === null) return { ok: false, error: 'amount' };
    body.amount = a;
  } else {
    return { ok: false, error: 'kind' };
  }
  if (actingUserId) body.actingUserId = String(actingUserId);
  return { ok: true, body };
}

/**
 * How a move is framed to the person: whether it happens now or is a request.
 * The GM's moves always apply, so the GM always sees "Move".
 *
 * @param {{downtimeOpen: boolean, isGM: boolean}} p
 * @returns {{immediate: boolean, hintKey: string, buttonKey: string}} lang keys
 *   under CHRONICLE.Stashes.
 */
export function moveFraming({ downtimeOpen, isGM }) {
  if (isGM) return { immediate: true, hintKey: 'HintGM', buttonKey: 'Move' };
  if (downtimeOpen) return { immediate: true, hintKey: 'HintNow', buttonKey: 'Move' };
  return { immediate: false, hintKey: 'HintAsk', buttonKey: 'Ask' };
}

/**
 * Which linked characters a settled/moved event touched, as entity ids.
 * Accepts the `stash.moved` list shape and the `stash.money_changed` single id.
 * @param {object} payload
 * @returns {string[]}
 */
export function touchedCharacterIds(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const ids = new Set();
  for (const id of list(payload.characterIds)) if (str(id)) ids.add(str(id));
  if (str(payload.characterId)) ids.add(str(payload.characterId));
  return [...ids];
}

/**
 * Does a server error mean "this Chronicle has no stash routes / the addon is
 * off"? Both answer 404 on the downtime probe.
 * @param {any} err
 * @returns {boolean}
 */
export function isFeatureMissing(err) {
  return err?.status === 404;
}
