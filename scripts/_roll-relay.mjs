/**
 * Shared rolls, the pure rules. Chronicle sends a finished roll
 * (`roll.made`); the active GM's client posts it to Foundry chat with
 * Chronicle's dice values, never re-rolled. The other way, a roll in Foundry
 * chat becomes a `POST /rolls` body. Everything that touches Foundry lives in
 * roll-relay.mjs; this file is plain data in, plain data out, pinned by
 * tools/test-roll-relay.mjs.
 *
 * GM-only content: a `gm` or `blind` roll is only ever built as a whisper to
 * GM users (plus the roller for `gm`), so Foundry never sends it to anyone
 * else. A Foundry message that is private to someone other than the GMs is
 * never sent to Chronicle.
 */

import { FLAG_SCOPE } from './constants.mjs';

export const ROLL_MESSAGE_TYPE = 'roll.made';
/** Flag key under the module scope: `{id, origin}`. */
export const ROLL_FLAG = 'roll';

const MIN_SIDES = 2;
const MAX_SIDES = 1000;
const MAX_DICE = 100;
const MAX_LABEL = 200;
const MAX_NAME = 100;
const SEEN_LIMIT = 500;

const isInt = (n) => Number.isInteger(n);

/**
 * Whether a `roll.made` payload is one to post in Foundry: Chronicle's own
 * roll, in full, not private to one player.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function judgeIncoming(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'empty' };
  if (typeof payload.id !== 'string' || !payload.id) return { ok: false, reason: 'no-id' };
  if (payload.origin !== 'chronicle') return { ok: false, reason: 'foreign-origin' };
  if (payload.hidden) return { ok: false, reason: 'hidden' };
  if (!['public', 'gm', 'blind'].includes(payload.mode)) return { ok: false, reason: 'mode' };
  if (!isInt(payload.total)) return { ok: false, reason: 'total' };
  const dice = cleanDice(payload.dice);
  if (!dice.length) return { ok: false, reason: 'dice' };
  return { ok: true };
}

/** The payload's dice that are well-formed; anything else is dropped. */
export function cleanDice(dice) {
  if (!Array.isArray(dice)) return [];
  return dice
    .filter((d) => d && isInt(d.sides) && isInt(d.value)
      && d.sides >= MIN_SIDES && d.sides <= MAX_SIDES && d.value >= 1 && d.value <= d.sides)
    .slice(0, MAX_DICE)
    .map((d) => ({ sides: d.sides, value: d.value }));
}

/**
 * Foundry `Roll` data (the shape `Roll.fromData` reads) carrying Chronicle's
 * results as already-evaluated terms. Runs of the same die size share one Die
 * term; the modifier follows as an operator and a number.
 * @returns {object} `{class:'Roll', formula, terms, total, evaluated, options}`
 */
export function buildRollData(payload) {
  const terms = [];
  const plus = () => terms.push({ class: 'OperatorTerm', operator: '+', evaluated: true, options: {} });
  let run = null;
  for (const d of cleanDice(payload.dice)) {
    if (run && run.faces === d.sides) {
      run.number += 1;
      run.results.push({ result: d.value, active: true });
      continue;
    }
    if (run) plus();
    run = {
      class: 'Die', number: 1, faces: d.sides, modifiers: [], evaluated: true, options: {},
      results: [{ result: d.value, active: true }],
    };
    terms.push(run);
  }
  const mod = isInt(payload.modifier) ? payload.modifier : 0;
  if (mod) {
    terms.push({ class: 'OperatorTerm', operator: mod < 0 ? '-' : '+', evaluated: true, options: {} });
    terms.push({ class: 'NumericTerm', number: Math.abs(mod), evaluated: true, options: {} });
  }
  const formula = terms.map((t) => {
    if (t.class === 'Die') return `${t.number}d${t.faces}`;
    if (t.class === 'OperatorTerm') return ` ${t.operator} `;
    return String(t.number);
  }).join('');
  return { class: 'Roll', options: {}, formula, terms, total: payload.total, evaluated: true };
}

/** The chat line's flavour: label, then the outcome in brackets. */
export function flavorFor(payload) {
  const label = String(payload.label ?? '').trim().slice(0, MAX_LABEL);
  const outcome = String(payload.outcome ?? '').trim().slice(0, MAX_LABEL);
  if (label && outcome) return `${label} (${outcome})`;
  return label || outcome;
}

/**
 * The ChatMessage data for an incoming roll.
 * @param {object} payload - A roll that passed judgeIncoming.
 * @param {object} ctx
 * @param {string[]} ctx.gmIds - Ids of the GM users.
 * @param {string|null} [ctx.rollerFoundryId] - Foundry user linked to the roller.
 * @param {string} [ctx.fallbackAlias] - Speaker name when Chronicle sent none.
 * @param {string|null} [ctx.authorId] - Foundry user the message is from.
 */
export function buildChatData(payload, { gmIds = [], rollerFoundryId = null, fallbackAlias = '', authorId = null } = {}) {
  const rolls = [buildRollData(payload)];
  const data = {
    content: String(payload.total),
    speaker: { alias: String(payload.rollerName || fallbackAlias).slice(0, MAX_NAME) },
    flavor: flavorFor(payload),
    rolls,
    flags: { [FLAG_SCOPE]: { [ROLL_FLAG]: { id: payload.id, origin: 'chronicle' } } },
  };
  if (authorId) data.author = authorId;
  if (payload.mode === 'gm') {
    data.whisper = unique([...gmIds, rollerFoundryId]);
  } else if (payload.mode === 'blind') {
    data.whisper = unique(gmIds);
    data.blind = true;
  }
  return data;
}

function unique(ids) {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))];
}

/** Bounded memory of roll ids already posted, so a repeat delivery posts once. */
export class SeenRolls {
  constructor(limit = SEEN_LIMIT) {
    this._limit = limit;
    this._ids = new Set();
  }

  /** @returns {boolean} true the first time an id is seen, false after. */
  add(id) {
    if (this._ids.has(id)) return false;
    this._ids.add(id);
    if (this._ids.size > this._limit) this._ids.delete(this._ids.values().next().value);
    return true;
  }

  has(id) { return this._ids.has(id); }
}

/** The roll flag on a message (a document or plain data), or null. */
export function rollFlag(message) {
  const flag = message?.flags?.[FLAG_SCOPE]?.[ROLL_FLAG];
  return flag && typeof flag === 'object' ? flag : null;
}

/** Whether any chat message already carries this Chronicle roll id. */
export function hasRollMessage(messages, id) {
  for (const m of messages ?? []) if (rollFlag(m)?.id === id) return true;
  return false;
}

/**
 * Which audience a Foundry chat message has, in Chronicle's words: `public`,
 * `blind`, `gm` (whispered to at least one GM and to someone besides the
 * author alone) or null for anything that must stay in Foundry (a self roll,
 * or a whisper that includes no GM).
 * @param {{blind?: boolean, whisper?: string[], author?: {id: string}, user?: {id: string}}} message
 * @param {(userId: string) => boolean} isGM
 */
export function modeOf(message, isGM) {
  if (message?.blind) return 'blind';
  const whisper = Array.isArray(message?.whisper) ? message.whisper : [];
  if (!whisper.length) return 'public';
  const authorId = message.author?.id ?? message.user?.id ?? message.author ?? null;
  if (whisper.length === 1 && whisper[0] === authorId) return null;
  return whisper.some(isGM) ? 'gm' : null;
}

function stripTags(text) {
  return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every die result still counting toward a roll's total. */
export function activeDice(roll) {
  const out = [];
  for (const term of roll?.dice ?? []) {
    for (const r of term.results ?? []) {
      if (r.active === false || r.discarded || r.rerolled) continue;
      out.push({ sides: term.faces, value: r.result });
    }
  }
  return out;
}

/**
 * The `POST /rolls` bodies for a Foundry chat message, one per roll Chronicle
 * can hold. A roll with no dice, a die it cannot store, more than 100 dice or
 * a non-whole total is left out whole rather than sent with a total the dice
 * do not add up to. Empty for a Chronicle roll, a self roll or no rolls.
 * @param {object} message - A ChatMessage document or its plain data.
 * @param {object} ctx
 * @param {(userId: string) => boolean} ctx.isGM
 * @param {string} ctx.foundryUserId - Foundry user who made the message.
 * @param {string} [ctx.userName] - That user's name, when no speaker alias.
 */
export function postBodies(message, { isGM, foundryUserId, userName = '' }) {
  if (!message?.id || rollFlag(message)) return [];
  const rolls = Array.isArray(message.rolls) ? message.rolls : [];
  if (!rolls.length) return [];
  const mode = modeOf(message, isGM);
  if (!mode) return [];
  const bodies = [];
  rolls.forEach((roll, index) => {
    const dice = activeDice(roll);
    if (!dice.length || dice.length > MAX_DICE) return;
    if (!cleanDice(dice).length || cleanDice(dice).length !== dice.length) return;
    if (!isInt(roll.total) || !roll.formula) return;
    bodies.push({
      originId: index === 0 ? message.id : `${message.id}:${index}`,
      foundryUserId,
      rollerName: (message.speaker?.alias || userName || '').slice(0, MAX_NAME),
      label: stripTags(message.flavor).slice(0, MAX_LABEL),
      formula: String(roll.formula).slice(0, 200),
      dice,
      total: roll.total,
      mode,
    });
  });
  return bodies;
}

/**
 * Whether a failed POST means this Chronicle has no rolls route, so sending
 * stops for the session. Anything else (400, a network error) is one roll's
 * trouble and does not stop the next.
 */
export function isRouteMissing(err) {
  return err?.status === 404;
}
