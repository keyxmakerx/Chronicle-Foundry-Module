/**
 * The night sky look's own figures for the NPC and monster sheet
 * (templates/npc-looks/sky/), beyond the `npc.*` ones every look gets. The
 * sheet sets them as `npc.look`. Pure: every figure comes from the sheet's
 * own figures and Draw Steel's prepared data, never from Foundry globals.
 *
 * The sky look draws the same four things as the hero's: a moon ringed by a
 * track and arcs, big thin numbers, a constellation, a row of small facts.
 * For a monster the ring is Stamina and the arcs are the villain actions; for
 * an NPC the ring is Interest and the arcs are Patience, and the
 * constellation is the motivations and pitfalls rather than the
 * characteristics.
 */
import { constellation } from './_hero-look-sky.mjs';

/** The ring's radius for the track, the fill and the inner arcs, in the moon's 340 by 340 space. */
const RING = Object.freeze({ centre: 170, track: 146, arc: 132 });

/** Interest and Patience run 0 to 5 in Draw Steel. */
const METER_MAX = 5;

/**
 * Where a motivation or pitfall star can sit in the constellation's 590 by
 * 240 space. The first five are the characteristics' places, so the
 * pattern reads the same on every sheet in this look; the last two are for a
 * page that lists more than five.
 */
export const MOTIVE_PLACES = Object.freeze([
  Object.freeze([70, 150]),
  Object.freeze([190, 60]),
  Object.freeze([330, 120]),
  Object.freeze([450, 40]),
  Object.freeze([520, 170]),
  Object.freeze([200, 190]),
  Object.freeze([60, 45]),
]);

/**
 * Which of the first five places a short list uses, so two or three stars
 * spread across the sky instead of crowding its left side.
 */
const SPREAD = Object.freeze({ 1: [2], 2: [1, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] });

/** How many stars the constellation holds; any more are listed under it. */
export const MAX_STARS = MOTIVE_PLACES.length;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The inner arcs of the ring: one per flag, lit where the flag is true, on a
 * circle measured as 100 (pathLength), with a small gap between them.
 * @param {boolean[]} flags
 * @returns {{dash: string, offset: number, on: boolean}[]}
 */
export function ringArcs(flags) {
  const n = flags.length;
  if (!n) return [];
  const gap = n > 1 ? Math.min(3, 30 / n) : 0;
  const len = round2(100 / n - gap);
  return flags.map((on, i) => ({ dash: `${len} ${round2(100 - len)}`, offset: round2(-(i * (100 / n) + gap / 2)), on: !!on }));
}

/**
 * The short bar that crosses the Stamina track where a creature is winded.
 * @param {unknown} windedAt  0 to 100, how far round the ring
 * @returns {{x1: number, y1: number, x2: number, y2: number}|null}
 */
export function windedMark(windedAt) {
  const at = num(windedAt);
  if (at === null || at <= 0 || at >= 100) return null;
  const a = (at / 100) * Math.PI * 2;
  const point = (r) => [round1(RING.centre + r * Math.sin(a)), round1(RING.centre - r * Math.cos(a))];
  const [x1, y1] = point(RING.track - 10);
  const [x2, y2] = point(RING.track + 11);
  return { x1, y1, x2, y2 };
}

/**
 * Interest's band: the ring, the number and the answer share one tone.
 * `none` while the meters are not known (a player before the Director shows them).
 * @param {unknown} interest
 * @returns {string}  i0 to i5, or none
 */
export function interestBand(interest) {
  const v = num(interest);
  return v === null ? 'none' : `i${clamp(Math.trunc(v), 0, METER_MAX)}`;
}

/**
 * The motivations and pitfalls as a constellation: a star for each row at its
 * place, the lines joining them, and the rows that did not fit. A line joins
 * two stars only once both are known (`veiled` until then), and the faint
 * dotted ghost of every line always shows the way.
 * @param {{key: string, label: string, kind: string, state: string}[]} [rows]  negotiation.rows
 * @returns {{stars: object[], links: {i: number, d: string, veiled: boolean}[], ghosts: {d: string}[], more: object[]}}
 */
export function motiveConstellation(rows = []) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const shown = list.slice(0, MAX_STARS);
  const picks = shown.length <= 5 ? SPREAD[shown.length] ?? [] : MOTIVE_PLACES.map((_, i) => i).slice(0, shown.length);
  const stars = shown.map((row, i) => {
    const [x, y] = MOTIVE_PLACES[picks[i]];
    return { key: row.key, label: row.label, kind: row.kind, state: row.state, x, y, halo: 22, i };
  });
  // The first five stars are joined left to right; a sixth or seventh hangs from the nearest of those before it.
  const base = stars.slice(0, 5).map((_, i) => i).sort((a, b) => stars[a].x - stars[b].x || a - b);
  const pairs = [];
  for (let k = 1; k < base.length; k++) pairs.push([base[k - 1], base[k]]);
  // With all five, the third and the fifth close the loop, as the characteristics' sky does.
  if (base.length === 5) pairs.push([base[2], base[4]]);
  for (let k = 5; k < stars.length; k++) {
    const s = stars[k];
    const dist = (j) => Math.hypot(stars[j].x - s.x, stars[j].y - s.y);
    let best = 0;
    for (let j = 1; j < k; j++) if (dist(j) < dist(best)) best = j;
    pairs.push([best, k]);
  }
  const line = (a, b) => `M${stars[a].x} ${stars[a].y}L${stars[b].x} ${stars[b].y}`;
  const links = pairs.map(([a, b], i) => ({ i, d: line(a, b), veiled: stars[a].state === 'hidden' || stars[b].state === 'hidden' }));
  const ghosts = pairs.map(([a, b]) => ({ d: line(a, b) }));
  return { stars, links, ghosts, more: list.slice(MAX_STARS) };
}

/**
 * The villain action stars: three on a short arc under the moon, as if the
 * moon's orbit ran on. One circle centred above the box, so the arc curves
 * like the moon's own rings.
 * @param {{id?: string, name?: string, order?: number, state?: string}[]} [marks]  npc.villain.marks
 * @returns {{places: {x: number, y: number}[], arc: string, labelWidth: number, next: {name: string, order: number}|null}}
 */
export function villainArc(marks = []) {
  const list = Array.isArray(marks) ? marks : [];
  const n = list.length;
  const [cx, cy, r] = [170, -160, 205];
  const xs = n === 1 ? [170] : list.map((_, i) => 68 + (i * 204) / Math.max(1, n - 1));
  const places = xs.map((x) => ({ x: round2(x / 3.4), y: round1(cy + Math.sqrt(r * r - (x - cx) ** 2)) }));
  const end = Math.round(Math.sqrt(r * r - 164 * 164));
  const arc = `M${cx - end} ${cy + 164}A${r} ${r} 0 0 0 ${cx + end} ${cy + 164}`;
  const nextMark = list.find((m) => m?.state === 'next');
  return {
    places,
    arc,
    labelWidth: n > 1 ? clamp(Math.floor(204 / (n - 1)) - 4, 52, 96) : 96,
    next: nextMark ? { name: String(nextMark.name ?? ''), order: nextMark.order } : null,
  };
}

/**
 * Figures only this look draws, set on the sheet as `npc.look`.
 * @param {object} npc  the sheet's own figures (`npc.*`)
 * @param {object} system  the actor's prepared system data
 * @param {{characteristics?: Record<string, {value?: number}>, lang?: string}} [env]  Draw Steel's characteristics, as the sheet's context holds them
 * @returns {object}
 */
export function npcLookContext(npc, system, env = {}) {
  const isMonster = npc?.shape === 'monster';
  const neg = npc?.negotiation ?? null;
  const interest = num(neg?.interest);
  const marks = npc?.villain?.marks ?? [];
  let ring;
  if (isMonster) {
    const stamina = npc?.chronicle?.stamina ?? {};
    ring = {
      fill: clamp(num(stamina.fill) ?? 0, 0, 100),
      winded: windedMark(stamina.windedAt),
      segs: ringArcs(marks.map((m) => m?.state !== 'used')),
    };
  } else {
    const patience = clamp(Math.trunc(num(neg?.patience) ?? 0), 0, METER_MAX);
    ring = {
      fill: interest === null ? 0 : clamp(Math.trunc(interest), 0, METER_MAX) * (100 / METER_MAX),
      winded: null,
      segs: ringArcs(Array.from({ length: METER_MAX }, (_, i) => i < patience)),
    };
  }
  return {
    constellation: constellation(env?.characteristics),
    band: interestBand(neg?.interest),
    known: interest !== null,
    ring,
    motives: motiveConstellation(neg?.rows),
    villain: villainArc(marks),
  };
}
