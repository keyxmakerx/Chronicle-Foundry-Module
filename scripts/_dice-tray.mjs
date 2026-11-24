/**
 * The dice tray by the chat box, the pure rules: a pool of dice plus a
 * modifier becomes a roll formula, and a Draw Steel hero's characteristics
 * become power roll choices. Everything that touches Foundry lives in
 * dice-tray.mjs; this file is plain data in, plain data out, pinned by
 * tools/test-dice-tray.mjs.
 */

/** The dice the tray offers, smallest first. */
export const DIE_SIDES = [4, 6, 8, 10, 12, 20, 100];

/** Draw Steel's five characteristics, in the order its hero sheet lists them. */
export const DS_CHARACTERISTICS = ['might', 'agility', 'reason', 'intuition', 'presence'];

const MAX_PER_DIE = 20;
const MAX_MODIFIER = 99;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** An empty pool. */
export function createPool() {
  return { counts: {}, modifier: 0 };
}

/** The pool with `delta` more (or fewer) of one die; unknown sizes are ignored. */
export function addDie(pool, sides, delta = 1) {
  if (!DIE_SIDES.includes(sides) || !Number.isInteger(delta)) return pool;
  const counts = { ...pool.counts };
  const next = clamp((counts[sides] ?? 0) + delta, 0, MAX_PER_DIE);
  if (next) counts[sides] = next;
  else delete counts[sides];
  return { ...pool, counts };
}

/** The pool with a new modifier, kept a whole number within ±99. */
export function setModifier(pool, value) {
  const n = Math.trunc(Number(value));
  return { ...pool, modifier: Number.isFinite(n) ? clamp(n, -MAX_MODIFIER, MAX_MODIFIER) : 0 };
}

/** Whether the pool holds no dice (a modifier alone is not a roll). */
export function poolIsEmpty(pool) {
  return !DIE_SIDES.some((s) => pool.counts[s] > 0);
}

/** ` + 3`, ` - 2` or `` for a modifier, spaced the way Foundry prints formulas. */
function modifierText(mod) {
  if (!mod) return '';
  return mod > 0 ? ` + ${mod}` : ` - ${Math.abs(mod)}`;
}

/** The pool as a roll formula, largest die first, or '' when it holds no dice. */
export function formulaOf(pool) {
  if (poolIsEmpty(pool)) return '';
  const dice = [...DIE_SIDES].reverse()
    .filter((s) => pool.counts[s] > 0)
    .map((s) => `${pool.counts[s]}d${s}`)
    .join(' + ');
  return dice + modifierText(pool.modifier);
}

/** A Draw Steel power roll: 2d10 plus the characteristic. */
export function powerRollFormula(value) {
  const n = Number.isInteger(value) ? value : 0;
  return `2d10${modifierText(n)}`;
}

/**
 * The hero's characteristics as tray choices. A missing or non-numeric value
 * reads as null, so the tray shows the name without inventing a score.
 * @param {Record<string, {value?: unknown}>} [characteristics]  system.characteristics
 */
export function characteristicChoices(characteristics) {
  const src = characteristics && typeof characteristics === 'object' ? characteristics : {};
  return DS_CHARACTERISTICS.map((key) => {
    const v = src[key]?.value;
    return { key, value: Number.isInteger(v) ? v : null };
  });
}

/** `+2`, `-1`, `+0`, or '' when unknown: how a characteristic reads on its button. */
export function signed(value) {
  if (!Number.isInteger(value)) return '';
  return value < 0 ? `${value}` : `+${value}`;
}

/*
 * Die outlines on a 56 by 56 grid, the same shapes Chronicle's quick 2D dice
 * draw, so a die looks alike on both sides. A d100 borrows the d10's.
 */
const OUTLINES = {
  4: [[28, 4], [53, 49], [3, 49]],
  6: [[8, 5], [48, 5], [52, 9], [52, 47], [48, 51], [8, 51], [4, 47], [4, 9]],
  8: [[28, 2], [54, 28], [28, 54], [2, 28]],
  10: [[28, 2], [53, 23], [28, 54], [3, 23]],
  12: [[28, 2], [53, 20], [44, 52], [12, 52], [3, 20]],
  20: [[28, 2], [51, 15], [51, 41], [28, 54], [5, 41], [5, 15]],
};
OUTLINES[100] = OUTLINES[10];

/** A die's outline as SVG markup, drawn in the current text colour; '' for an unknown size. */
export function dieOutline(sides) {
  const o = OUTLINES[sides];
  if (!o) return '';
  const points = o.map((p) => p.join(',')).join(' ');
  return `<svg viewBox="0 0 56 56" aria-hidden="true" focusable="false"><polygon points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>`;
}
