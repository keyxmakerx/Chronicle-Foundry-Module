/**
 * The GM request card, as a pure model.
 *
 * One whispered chat card per pending stash request: who asked, what, where
 * to, with Approve and Turn down buttons. Answering it (here or on the
 * website) rewrites the same card to "Approved by X" / "Turned down by X"
 * with the buttons gone. The card's state lives in message flags keyed by the
 * move id, which is also how a card is found again and how duplicates are
 * avoided.
 */

/** Card states stored in the message flag. */
export const CARD_STATE = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  FAILED: 'failed',
});

/** Server move statuses. */
const STATUS_TO_STATE = Object.freeze({
  pending: CARD_STATE.PENDING,
  applied: CARD_STATE.APPROVED,
  declined: CARD_STATE.DECLINED,
  failed: CARD_STATE.FAILED,
});

/**
 * @param {any} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Map a server move status to a card state.
 * @param {string} status
 * @returns {string|null} null for a status the card does not know.
 */
export function stateForStatus(status) {
  return STATUS_TO_STATE[status] ?? null;
}

function moneyText(n) {
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(2);
}

/**
 * Model of a request card from a /stashes/requests line.
 * @param {object} line - a normalized line (see _stash-model normalizeLine).
 * @returns {{moveId: string, who: string, what: string, where: string, state: string, by: string}}
 */
export function requestCardModel(line) {
  const money = line.kind === 'money';
  const what = money
    ? moneyText(line.amount)
    : `${line.quantity > 0 ? line.quantity : 1} × ${line.itemName || ''}`.trim();
  return {
    moveId: String(line.id),
    who: line.requesterName || '',
    what,
    isMoney: money,
    where: [line.fromName, line.toName].filter(Boolean).join(' → '),
    state: stateForStatus(line.status) ?? CARD_STATE.PENDING,
    by: '',
  };
}

/**
 * The model after the request was answered.
 * @param {object} model
 * @param {string} status - settled server status.
 * @param {string} by - display name of who answered.
 * @returns {object} a new model; the input is returned unchanged when the
 *   card is already settled (a second event must not rewrite who answered) or
 *   the status is still pending/unknown.
 */
export function settleCardModel(model, status, by) {
  if (model.state !== CARD_STATE.PENDING) return model;
  const state = stateForStatus(status);
  if (!state || state === CARD_STATE.PENDING) return model;
  return { ...model, state, by: by || '' };
}

/**
 * Which requests still need a card. A card exists once its move id appears in
 * `haveIds` (cards already in chat) or `inFlight` (being posted right now).
 * Only pending requests get a card; each move id yields at most one.
 * @param {object[]} requests - normalized lines.
 * @param {Iterable<string>} haveIds
 * @param {Iterable<string>} [inFlight]
 * @returns {object[]}
 */
export function cardsToPost(requests, haveIds, inFlight = []) {
  const seen = new Set([...haveIds].map(String));
  for (const id of inFlight) seen.add(String(id));
  const out = [];
  for (const line of requests || []) {
    if (!line || line.status !== 'pending') continue;
    const id = String(line.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(line);
  }
  return out;
}

/**
 * Card body HTML. Every server-supplied string is escaped. The buttons are
 * present only while pending; the click handlers are attached by the render
 * hook, which also checks the clicker is a GM.
 *
 * @param {object} model
 * @param {Object<string,string>} labels - localized strings: Title, Who, What,
 *   Where, Money, Approve, Decline, Approved, Declined, Failed (the answered lines
 *   take `{name}` already substituted by the caller via `answered`).
 * @param {string} answered - the localized "Approved by X" style line, used
 *   when the card is settled; ignored while pending.
 * @returns {string}
 */
export function cardHtml(model, labels, answered = '') {
  const e = escapeHtml;
  const rows = [
    `<div class="chronicle-stash-row"><span class="chronicle-stash-key">${e(labels.Who)}</span> <span>${e(model.who)}</span></div>`,
    `<div class="chronicle-stash-row"><span class="chronicle-stash-key">${e(labels.What)}</span> <span>${e(model.isMoney ? `${labels.Money} ${model.what}` : model.what)}</span></div>`,
    `<div class="chronicle-stash-row"><span class="chronicle-stash-key">${e(labels.Where)}</span> <span>${e(model.where)}</span></div>`,
  ].join('');
  let foot;
  if (model.state === CARD_STATE.PENDING) {
    foot = '<div class="chronicle-stash-actions">'
      + `<button type="button" data-stash-action="approve" data-move-id="${e(model.moveId)}">${e(labels.Approve)}</button>`
      + `<button type="button" data-stash-action="decline" data-move-id="${e(model.moveId)}">${e(labels.Decline)}</button>`
      + '</div>';
  } else {
    foot = `<div class="chronicle-stash-answer chronicle-stash-${e(model.state)}">${e(answered)}</div>`;
  }
  return `<div class="chronicle-stash-card" data-move-id="${e(model.moveId)}" data-state="${e(model.state)}">`
    + `<header class="chronicle-stash-title">${e(labels.Title)}</header>${rows}${foot}</div>`;
}

/**
 * The flag value stored on the chat message.
 * @param {object} model
 * @returns {{moveId: string, state: string, by: string, model: object}}
 */
export function cardFlag(model) {
  return { moveId: model.moveId, state: model.state, by: model.by, model };
}

/**
 * Read a card flag back, tolerating a flag from a different build.
 * @param {any} flag
 * @returns {object|null} the model, or null if the flag is not a card.
 */
export function modelFromFlag(flag) {
  const m = flag?.model;
  if (!m || typeof m !== 'object' || !m.moveId) return null;
  return {
    moveId: String(m.moveId),
    who: String(m.who ?? ''),
    what: String(m.what ?? ''),
    isMoney: m.isMoney === true,
    where: String(m.where ?? ''),
    state: Object.values(CARD_STATE).includes(flag.state) ? flag.state : CARD_STATE.PENDING,
    by: String(flag.by ?? ''),
  };
}

/**
 * Was this chat message written by a GM? Any player can create a message with
 * card markup and flags, so only a GM-authored message counts as a request
 * card. Foundry 13 calls the field `author`, 12 `user`.
 * @param {any} message
 * @returns {boolean}
 */
export function isGmAuthored(message) {
  return (message?.author ?? message?.user)?.isGM === true;
}

/**
 * The move id of a trusted request card, read from the message flag (never
 * from the rendered markup). Null for anything not GM-authored.
 * @param {any} message
 * @param {(m: any) => any} getFlag - reads the stash-request flag.
 * @returns {string|null}
 */
export function trustedCardMoveId(message, getFlag) {
  if (!isGmAuthored(message)) return null;
  const id = getFlag(message)?.moveId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Move ids that already have a trusted card.
 * @param {any[]} messages
 * @param {(m: any) => any} getFlag
 * @returns {string[]}
 */
export function collectCardMoveIds(messages, getFlag) {
  const out = [];
  for (const m of messages ?? []) {
    const id = trustedCardMoveId(m, getFlag);
    if (id) out.push(id);
  }
  return out;
}

/**
 * The trusted card message for a move id, or null.
 * @param {any[]} messages
 * @param {string|number} moveId
 * @param {(m: any) => any} getFlag
 * @returns {any|null}
 */
export function findCardMessage(messages, moveId, getFlag) {
  const want = String(moveId);
  return (messages ?? []).find((m) => trustedCardMoveId(m, getFlag) === want) ?? null;
}
