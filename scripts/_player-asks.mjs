/**
 * The GM card for a player's change to something that is not theirs, as a
 * pure model.
 *
 * A player's own creates and deletes go straight to Chronicle. When the
 * player adds or removes something on a character or page Chronicle does not
 * say is theirs, the GM's client posts one whispered chat card instead
 * ("Mira added Rope to Sela") with Send to Chronicle and Not now. Send runs
 * the same push the GM's own action would.
 *
 * Every id on a player's document is a flag the player can rewrite, so the
 * card text is only what Foundry says. At press time the GM's client reads
 * the pages those ids really name; when a name differs from what the card
 * said, the card is rewritten to show the real names and needs a second press.
 * Like `_stash-cards.mjs`, a message is a card only if a GM wrote it.
 */

import { escapeHtml } from './_escape-html.mjs';
import { isGmAuthored } from './_stash-cards.mjs';

export { isGmAuthored };

/** What the player did. */
export const ASK = Object.freeze({
  ITEM_ADD: 'item-add',
  ITEM_REMOVE: 'item-remove',
  JOURNAL_REMOVE: 'journal-remove',
  ACTOR_REMOVE: 'actor-remove',
});

/** Card states stored in the message flag. */
export const ASK_STATE = Object.freeze({
  PENDING: 'pending',
  CONFIRM: 'confirm',
  SENT: 'sent',
  DECLINED: 'declined',
  FAILED: 'failed',
  REFUSED: 'refused',
});

const SETTLED = new Set([ASK_STATE.SENT, ASK_STATE.DECLINED, ASK_STATE.FAILED, ASK_STATE.REFUSED]);

/** @param {string} state @returns {boolean} whether the card is answered. */
export function isSettled(state) {
  return SETTLED.has(state);
}

/**
 * One card per change: the kind plus the Foundry document's own id (never a
 * flag), so the same change cannot be carded twice.
 * @param {string} kind
 * @param {string} docId
 */
export function askKey(kind, docId) {
  return `${kind}:${docId}`;
}

/** Names compare ignoring case and runs of whitespace. */
export function sameName(a, b) {
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * @param {{kind: string, docId: string, who: string, name: string, where?: string,
 *   link: {entityId?: string, targetEntityId?: string, relationId?: string, actorId?: string, itemId?: string, quantity?: number, equipped?: boolean}}} p
 *   `name` and `where` are Foundry's words; `link` holds the flag ids the
 *   press re-checks.
 * @returns {object}
 */
export function askModel({ kind, docId, who, name, where = '', link = {} }) {
  return {
    key: askKey(kind, docId),
    kind,
    who: String(who ?? ''),
    name: String(name ?? ''),
    where: String(where ?? ''),
    link: { ...link },
    state: ASK_STATE.PENDING,
    reals: {},
    by: '',
    byId: '',
    note: '',
  };
}

/**
 * Whether a page's visibility lets players read it, the bar for a player's
 * new item to point at it: not hidden, and either the campaign default or a
 * custom set with a view (or edit) grant for every player or everyone. A
 * page in a DM-only category never is, whatever its own visibility says.
 * @param {{is_private?: boolean, type_dm_only?: boolean}|null} entity
 * @param {{visibility?: string, permissions?: Array<{subject_type: string, subject_id?: string|number, permission: string}>}|null} perms
 * @returns {boolean}
 */
export function playersCanView(entity, perms) {
  if (!entity || entity.is_private === true || entity.type_dm_only === true) return false;
  const visibility = perms?.visibility ?? 'default';
  if (visibility === 'default' || visibility === 'everyone') return true;
  if (visibility !== 'custom' || !Array.isArray(perms?.permissions)) return false;
  return perms.permissions.some((g) => (g?.permission === 'view' || g?.permission === 'edit')
    && (g.subject_type === 'public' || (g.subject_type === 'role' && String(g.subject_id) === '1')));
}

/**
 * What a press does, given the pages the ids really name.
 *
 * `reals` maps a role to Chronicle's own name for it: `page` (the item's
 * page, or the page being deleted) and `character`. A first press with every
 * name matching sends. A mismatch rewrites the card to show the real names
 * and waits for a second press, which sends only when those names are still
 * the ones the GM was shown.
 * @param {object} model
 * @param {{page?: string, character?: string}} reals
 * @returns {{action: 'send'|'confirm', reals: object}}
 */
export function reviewAsk(model, reals) {
  const said = { page: model.name, character: model.where };
  const differs = Object.keys(reals).filter((role) => !sameName(said[role], reals[role]));
  if (differs.length === 0) return { action: 'send', reals };
  const shown = model.reals ?? {};
  const seen = model.state === ASK_STATE.CONFIRM
    && Object.keys(reals).every((role) => shown[role] === reals[role]);
  return seen ? { action: 'send', reals } : { action: 'confirm', reals };
}

/** The model after the GM was shown the real names. */
export function confirmModel(model, reals) {
  if (isSettled(model.state)) return model;
  return { ...model, state: ASK_STATE.CONFIRM, reals: { ...reals } };
}

/**
 * The model after the request was answered.
 * @param {object} model
 * @param {string} state - one of the settled states.
 * @param {string} by - display name of who answered.
 * @param {string} [byId] - Foundry user id, so the card can say "you".
 * @param {string} [note] - why a refused or failed card was, as a card string key.
 * @returns {object} the input when already settled (a second press must not
 *   rewrite who answered) or `state` is not settled.
 */
export function settleModel(model, state, by, byId = '', note = '') {
  if (isSettled(model.state) || !isSettled(state)) return model;
  return { ...model, state, by: by || '', byId: byId ? String(byId) : '', note };
}

/**
 * Replace `{name}` placeholders in a localized template, escaping every
 * value (all of them are player-supplied).
 */
function fill(template, values) {
  return String(template)
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      return m && m[1] in values ? `<b>${escapeHtml(values[m[1]])}</b>` : escapeHtml(part);
    })
    .join('');
}

const SENTENCE_KEY = {
  [ASK.ITEM_ADD]: 'ItemAdd',
  [ASK.ITEM_REMOVE]: 'ItemRemove',
  [ASK.JOURNAL_REMOVE]: 'JournalRemove',
  [ASK.ACTOR_REMOVE]: 'ActorRemove',
};

/**
 * Card body HTML. Every string is escaped; the buttons are wired by the
 * render hook, which also checks the clicker is a GM.
 * @param {object} model
 * @param {Object<string,string>} labels - localized: ItemAdd, ItemRemove,
 *   JournalRemove, ActorRemove (with `{who}`, `{name}`, `{where}`), Points
 *   (`{page}`, `{character}`), Send, NotNow.
 * @param {string} answered - the localized answered line, used when settled.
 * @returns {string}
 */
export function cardHtml(model, labels, answered = '') {
  const e = escapeHtml;
  const sentence = fill(labels[SENTENCE_KEY[model.kind]] ?? '', { who: model.who, name: model.name, where: model.where });
  let body = `<div class="chronicle-ask-what">${sentence}</div>`;
  if (model.state === ASK_STATE.CONFIRM) {
    const r = model.reals ?? {};
    const parts = [];
    if (r.page !== undefined) parts.push(fill(labels.RealPage, { page: r.page }));
    if (r.character !== undefined) parts.push(fill(labels.RealCharacter, { character: r.character }));
    body += `<div class="chronicle-ask-real">${parts.join(' ')}</div>`;
  }
  if (isSettled(model.state)) {
    body += `<div class="chronicle-ask-answer chronicle-ask-${e(model.state)}">${e(answered)}</div>`;
  } else {
    body += '<div class="chronicle-ask-actions">'
      + `<button type="button" data-ask-action="send" data-ask-key="${e(model.key)}">${e(labels.Send)}</button>`
      + `<button type="button" data-ask-action="decline" data-ask-key="${e(model.key)}">${e(labels.NotNow)}</button>`
      + '</div>';
  }
  return `<div class="chronicle-ask-card" data-ask-key="${e(model.key)}" data-state="${e(model.state)}">${body}</div>`;
}

/** The flag value stored on the chat message. */
export function askFlag(model) {
  return { key: model.key, state: model.state, model };
}

/**
 * Read a card flag back, tolerating a flag from a different build.
 * @param {any} flag
 * @returns {object|null}
 */
export function modelFromFlag(flag) {
  const m = flag?.model;
  if (!m || typeof m !== 'object' || !m.key || !Object.values(ASK).includes(m.kind)) return null;
  return {
    key: String(m.key),
    kind: m.kind,
    who: String(m.who ?? ''),
    name: String(m.name ?? ''),
    where: String(m.where ?? ''),
    link: m.link && typeof m.link === 'object' ? { ...m.link } : {},
    state: Object.values(ASK_STATE).includes(flag.state) ? flag.state : ASK_STATE.PENDING,
    reals: m.reals && typeof m.reals === 'object' ? { ...m.reals } : {},
    by: String(m.by ?? ''),
    byId: String(m.byId ?? ''),
    note: String(m.note ?? ''),
  };
}

/**
 * The key of a trusted card, read from the message flag (never the markup).
 * Null for anything not GM-authored.
 * @param {any} message
 * @param {(m: any) => any} getFlag
 * @returns {string|null}
 */
export function trustedCardKey(message, getFlag) {
  if (!isGmAuthored(message)) return null;
  const key = getFlag(message)?.key;
  return key === undefined || key === null || key === '' ? null : String(key);
}

/** @returns {string[]} keys that already have a trusted card. */
export function collectCardKeys(messages, getFlag) {
  const out = [];
  for (const m of messages ?? []) {
    const key = trustedCardKey(m, getFlag);
    if (key) out.push(key);
  }
  return out;
}

/** @returns {any|null} the trusted card message for a key. */
export function findCardMessage(messages, key, getFlag) {
  const want = String(key);
  return (messages ?? []).find((m) => trustedCardKey(m, getFlag) === want) ?? null;
}
