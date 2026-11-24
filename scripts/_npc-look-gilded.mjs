/**
 * The gilded card's extra figures for the NPC and monster sheet
 * (templates/npc-looks/gilded/): the coin metals, the Malice coins, the
 * Interest dial's fill and band, and where the winded mark sits on the
 * Stamina dial. Pure, so a test can check them; Handlebars cannot do this
 * arithmetic. `tools/test-npc-look-gilded.mjs`.
 */

import { plaqueMetal } from './_hero-looks.mjs';

/** The most Interest Draw Steel's tracker holds. */
const INTEREST_MAX = 5;

/** Coins in the Malice row; the field beside them holds the true number. */
const MALICE_TRACK = 10;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * A point on the dial's arc: fraction f of the way from the left foot (0) to
 * the right foot (1), at radius r from the dial's centre (150, 150).
 * @param {number} f
 * @param {number} r
 * @returns {{x: number, y: number}}
 */
export function dialPoint(f, r) {
  const a = Math.PI * (1 - f);
  return { x: round1(150 + r * Math.cos(a)), y: round1(150 - r * Math.sin(a)) };
}

/**
 * The winded mark: a tick across the track and a small gem above it. Null
 * when Stamina has no winded point (no maximum), so nothing is drawn.
 * @param {unknown} windedAt  where winded sits on the bar, 0 to 100
 * @returns {{x1: number, y1: number, x2: number, y2: number, gx: number, gy: number}|null}
 */
export function windedMark(windedAt) {
  const at = num(windedAt);
  if (at === null || at <= 0 || at >= 100) return null;
  const f = at / 100;
  const a = dialPoint(f, 105);
  const b = dialPoint(f, 135);
  const g = dialPoint(f, 147);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, gx: g.x, gy: g.y };
}

/**
 * The Interest dial: a fifth of the arc for each point, in the band its
 * colour follows. Unknown Interest (a player before the Director shows it) is
 * an empty dial in no band, never Draw Steel's starting value passed off as real.
 * @param {unknown} interest
 * @returns {{fill: number, band: string}}
 */
export function interestDial(interest) {
  const n = num(interest);
  if (n === null) return { fill: 0, band: 'none' };
  const steps = Math.min(INTEREST_MAX, Math.max(0, Math.floor(n)));
  return { fill: steps * (100 / INTEREST_MAX), band: `i${steps}` };
}

/**
 * The Malice row: ten coins lit up to the number.
 * @param {unknown} value
 * @returns {boolean[]}
 */
export function maliceCoins(value) {
  const n = num(value);
  const lit = n === null ? 0 : Math.min(MALICE_TRACK, Math.max(0, Math.floor(n)));
  return Array.from({ length: MALICE_TRACK }, (_, i) => i < lit);
}

/**
 * The figures the gilded NPC and monster templates read as `npc.look.*`.
 * @param {object} npc  the sheet's own figures (`npc.*` in the templates)
 * @param {object} system  the actor's prepared system data
 * @param {{characteristics?: Record<string, {value?: number}>}} env
 * @returns {{metals: Record<string, string>, malicePips: boolean[], interestFill: number, interestBand: string, windedMark: object|null}}
 */
export function npcLookContext(npc, system, env = {}) {
  const metals = {};
  for (const [key, chr] of Object.entries(env.characteristics ?? {})) metals[key] = plaqueMetal(chr?.value);
  const interest = interestDial(npc?.negotiation?.interest);
  return {
    metals,
    malicePips: maliceCoins(npc?.malice?.value),
    interestFill: interest.fill,
    interestBand: interest.band,
    windedMark: windedMark(npc?.chronicle?.stamina?.windedAt),
  };
}
