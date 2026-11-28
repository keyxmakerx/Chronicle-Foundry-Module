/**
 * The Dice mat panel as pure decisions: Chronicle's shared mat shows only
 * public rolls, each under its roller's name tag.
 *
 * Chronicle's socket reaches the GM's client only, and sends that key's owner
 * gm, blind and stub rolls too, so every roll is judged here before it is
 * drawn or handed on. Players get a rebuilt copy over the module socket; the
 * sender is the id the socket layer gives the listener, never a field, and
 * the receiver judges the roll again and decides for itself whose it is.
 * tools/test-dice-mat.mjs pins these.
 */

/** Chronicle's tray files under vendor/chronicle/, in load order: the art comes first. */
export const MAT_FILES = ['dice_tray_art.js', 'dice_tray_core.js'];

/** Module-socket message type. */
export const MAT_MESSAGE = 'dice-mat';

export const MAT_LEVELS = ['simple', 'flat', 'detailed'];
export const MAT_FINISHES = ['paper', 'kit'];

const SIDES = [4, 6, 8, 10, 12, 20];
const MAX_DICE = 10;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SET_RE = /^[a-z0-9-]{0,24}$/;
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const NAME_MAX = 60;
const FORMULA_MAX = 80;

/** A person's three choices, each falling back to its default when bad. */
export function cleanChoices(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    level: MAT_LEVELS.includes(r.level) ? r.level : 'detailed',
    finish: MAT_FINISHES.includes(r.finish) ? r.finish : 'paper',
    others: r.others !== false,
  };
}

function validDice(dice) {
  if (!Array.isArray(dice)) return [];
  const out = [];
  for (const d of dice) {
    if (d && SIDES.includes(d.sides) && Number.isInteger(d.value) && d.value >= 1 && d.value <= d.sides) {
      out.push({ sides: d.sides, value: d.value });
    }
  }
  return out.slice(0, MAX_DICE);
}

/** Whether a roll may be drawn on a shared mat: public, not a stub, with at least one whole die. */
export function isMatRoll(payload) {
  return !!payload && typeof payload === 'object'
    && typeof payload.id === 'string' && ID_RE.test(payload.id)
    && payload.mode === 'public' && !payload.hidden
    && validDice(payload.dice).length > 0;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * The roll rebuilt field by field, so nothing else in a payload travels on.
 * `mine` is left false; the client that draws it decides.
 * @returns {object|null} null when the roll may not be drawn
 */
export function matView(payload) {
  if (!isMatRoll(payload)) return null;
  const rd = payload.rollerDice && typeof payload.rollerDice === 'object' ? payload.rollerDice : {};
  const view = {
    id: payload.id,
    mode: 'public',
    hidden: false,
    mine: false,
    rollerId: typeof payload.rollerId === 'string' && ID_RE.test(payload.rollerId) ? payload.rollerId : '',
    rollerName: text(payload.rollerName, NAME_MAX),
    formula: text(payload.formula, FORMULA_MAX),
    dice: validDice(payload.dice),
    modifier: Number.isSafeInteger(payload.modifier) && Math.abs(payload.modifier) <= 10000 ? payload.modifier : 0,
    rollerDice: {
      set: typeof rd.set === 'string' && SET_RE.test(rd.set) ? rd.set : '',
      colour: typeof rd.colour === 'string' && COLOUR_RE.test(rd.colour) ? rd.colour : '',
    },
  };
  if (Number.isSafeInteger(payload.total) && Math.abs(payload.total) <= 100000) view.total = payload.total;
  return view;
}

/**
 * The socket envelope for players. `rollerFoundryId` is the Foundry user the
 * roller is matched to, or null; it lets that user's own client mark the roll
 * as theirs.
 */
export function matMessage(payload, rollerFoundryId = null) {
  const roll = matView(payload);
  if (!roll) return null;
  return { type: MAT_MESSAGE, roll, rollerFoundryId: typeof rollerFoundryId === 'string' ? rollerFoundryId : null };
}

/**
 * A roll from the module socket, judged again on receipt: only from a GM,
 * only a public roll, and `mine` set here from this client's own user id.
 * @returns {object|null}
 */
export function readMatMessage(data, { senderIsGM, selfId }) {
  if (!senderIsGM || !data || typeof data !== 'object' || data.type !== MAT_MESSAGE) return null;
  const view = matView(data.roll);
  if (!view) return null;
  view.mine = typeof selfId === 'string' && selfId !== '' && data.rollerFoundryId === selfId;
  return view;
}
