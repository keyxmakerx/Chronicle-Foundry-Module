/**
 * The night sky look's own figures for its templates
 * (templates/hero-looks/sky/), beyond the chronicle.* ones every look gets.
 * Pure: every figure comes from Draw Steel's prepared data.
 */

/** How long this look's moves run (ms), where they differ from the shared timings. */
export const MOVE_MS = Object.freeze({ open: 2400, hit: 1300, heal: 2300, level: 2800 });

/** The constellation's drawing space; the SVG and the roll buttons both scale from it. */
export const CONSTELLATION_BOX = Object.freeze({ width: 590, height: 240 });

/**
 * Where each characteristic's star sits in that space. Fixed, so the
 * pattern reads the same for every hero and only the stars' sizes change.
 */
export const STAR_PLACES = Object.freeze({
  might: Object.freeze([70, 150]),
  agility: Object.freeze([190, 60]),
  reason: Object.freeze([330, 120]),
  intuition: Object.freeze([450, 40]),
  presence: Object.freeze([520, 170]),
});

/** The lines joining the stars, as pairs of characteristics, in the order they draw. */
export const STAR_LINKS = Object.freeze([
  ['might', 'agility'],
  ['agility', 'reason'],
  ['reason', 'intuition'],
  ['intuition', 'presence'],
  ['reason', 'presence'],
]);

/** The biggest star: +3 and beyond share it, so a high-level hero's star stays inside the box. */
export const MAX_TIER = 3;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);

/**
 * A star's size step: its value, held between 0 and MAX_TIER, so a
 * characteristic of 0 or less is the small star and +3 or more the big one.
 * @param {unknown} value
 * @returns {number}
 */
export function starTier(value) {
  return Math.max(0, Math.min(MAX_TIER, Math.trunc(num(value))));
}

/**
 * The outline of a four-point star for a size step, centred on 0,0.
 * @param {number} tier
 * @returns {string}
 */
export function starPath(tier) {
  const c = 7 + tier * 4;
  const p = 2 + tier;
  return `M0 ${-c}L${p} ${-p}L${c} 0L${p} ${p}L0 ${c}L${-p} ${p}L${-c} 0L${-p} ${-p}Z`;
}

/**
 * The constellation: one star per characteristic at its fixed place, sized
 * by the characteristic's value, and the lines between them.
 * @param {Record<string, {value?: number}>} [characteristics]  system.characteristics
 * @returns {{stars: Record<string, {x: number, y: number, tier: number, halo: number, path: string}>, links: {i: number, d: string}[]}}
 */
export function constellation(characteristics = {}) {
  const stars = {};
  for (const [key, [x, y]] of Object.entries(STAR_PLACES)) {
    const tier = starTier(characteristics?.[key]?.value);
    stars[key] = { x, y, tier, halo: 14 + tier * 9, path: starPath(tier) };
  }
  const links = STAR_LINKS.map(([a, b], i) => ({
    i,
    d: `M${STAR_PLACES[a][0]} ${STAR_PLACES[a][1]}L${STAR_PLACES[b][0]} ${STAR_PLACES[b][1]}`,
  }));
  return { stars, links };
}

/**
 * Figures only this look draws, added to its templates' chronicle.* context.
 * @param {object} system  the hero's prepared system data
 * @param {{lang?: string, config?: object}} env  Foundry's language and ds.CONFIG
 * @returns {object}
 */
export function lookContext(system, env) {
  return { constellation: constellation(system?.characteristics) };
}
