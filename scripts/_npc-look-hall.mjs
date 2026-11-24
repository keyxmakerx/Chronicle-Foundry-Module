/**
 * The portrait hall's extra figures for the NPC and monster sheet
 * (templates/npc-looks/hall/): the rings' inner arcs, the Interest ring's
 * fill, the plaque metals and the Malice diamonds. Pure, so the sheet can
 * hand it its figures and a test can check them; Handlebars cannot do this
 * arithmetic. `tools/test-npc-look-hall.mjs`.
 */

import { plaqueMetal } from './_hero-looks.mjs';

/** The most Interest or Patience Draw Steel's tracker holds. */
const METER_MAX = 5;

/** Diamonds in the Malice row; the field beside them holds the true number. */
const MALICE_TRACK = 10;

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Inner arcs for a ring measured as 100 (pathLength): one per flag, lit or
 * not, with a small gap between them, as the hero's recovery arcs are.
 * @param {boolean[]} flags
 * @returns {{dash: string, offset: number, on: boolean}[]}
 */
export function arcs(flags) {
  const n = flags.length;
  if (!n) return [];
  const gap = n > 1 ? Math.min(3, 30 / n) : 0;
  const len = round2(100 / n - gap);
  return flags.map((on, i) => ({ dash: `${len} ${round2(100 - len)}`, offset: round2(-(i * (100 / n) + gap / 2)), on: !!on }));
}

/**
 * The Interest ring: filled a fifth for each point, in the band its colour
 * follows. Unknown Interest (a player before the Director shows it) is an
 * empty ring in no band, never Draw Steel's starting value passed off as real.
 * @param {unknown} interest
 * @returns {{fill: number, band: string}}
 */
export function interestRing(interest) {
  const v = num(interest);
  if (v === null) return { fill: 0, band: 'none' };
  const n = Math.max(0, Math.min(METER_MAX, Math.trunc(v)));
  return { fill: n * (100 / METER_MAX), band: `i${n}` };
}

/**
 * Malice as a row of lit diamonds, up to the track's length.
 * @param {unknown} value
 * @returns {boolean[]}
 */
export function maliceDiamonds(value) {
  const v = Math.max(0, Math.floor(num(value) ?? 0));
  return Array.from({ length: MALICE_TRACK }, (_, i) => i < v);
}

/**
 * What the hall's templates read as `npc.look.*`.
 * @param {object} npc  the sheet's figures (`npc` in the template context)
 * @param {object} [system]  Draw Steel's actor system data (unused here)
 * @param {{characteristics?: Record<string, {value?: number}>}} [env]
 * @returns {{
 *   metals: Record<string, 'gold'|'bronze'|'iron'>,
 *   interest: {fill: number, band: string},
 *   patienceArcs: {dash: string, offset: number, on: boolean}[],
 *   villainArcs: {dash: string, offset: number, on: boolean}[],
 *   villainNext: {order: number, name: string}|null,
 *   maliceDiamonds: boolean[],
 * }}
 */
export function npcLookContext(npc, system, env = {}) {
  const metals = {};
  for (const [key, chr] of Object.entries(env.characteristics ?? {})) metals[key] = plaqueMetal(chr?.value);

  const neg = npc?.negotiation ?? null;
  const marks = Array.isArray(npc?.villain?.marks) ? npc.villain.marks : [];
  const next = marks.find((m) => m.state === 'next');
  return {
    metals,
    interest: interestRing(neg?.interest),
    patienceArcs: neg ? arcs(Array.isArray(neg.patiencePips) ? neg.patiencePips : []) : [],
    villainArcs: arcs(marks.map((m) => m.state !== 'used')),
    villainNext: next ? { order: next.order, name: next.name } : null,
    maliceDiamonds: maliceDiamonds(npc?.malice?.value),
  };
}
