/**
 * The arcane glass look's own figures for the NPC and monster sheet
 * (templates/npc-looks/glass/): the arcs inside the picture's ring, the
 * Interest ring's fill and colour step, the winded tick, and how brightly
 * each characteristic hex glows. Pure: no Foundry globals. The templates read
 * the result as npc.look.*; every number still comes from the sheet's own
 * figures, this only turns them into ring geometry.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The strongest characteristic that still adds glow; above it the hex is as bright as it gets. */
const LIT_AT = 3;

/**
 * Inner arcs for a ring with pathLength 100, in the hero glass's own spacing
 * (ringSegments in _hero-looks.mjs), one per state, lit where true. Empty for
 * no states, so a sheet without the thing draws no arcs.
 * @param {unknown} states
 * @returns {{dash: string, offset: number, on: boolean}[]}
 */
export function ringArcs(states) {
  const list = Array.isArray(states) ? states : [];
  const n = list.length;
  if (!n) return [];
  const gap = n > 1 ? Math.min(3, 30 / n) : 0;
  const len = round2(100 / n - gap);
  return list.map((on, i) => ({ dash: `${len} ${round2(100 - len)}`, offset: round2(-(i * (100 / n) + gap / 2)) || 0, on: !!on }));
}

/**
 * Interest as the NPC's ring: five steps of 20, and a colour band that is
 * rose while they'd refuse, orange at "No, but…", teal once they'd agree and
 * mint at the top. 'none' while Interest is unknown, so nothing is coloured
 * from a number nobody has seen.
 * @param {{interest?: unknown}|null|undefined} negotiation
 * @returns {{fill: number, band: string}}
 */
export function interestRing(negotiation) {
  const v = num(negotiation?.interest);
  if (v === null) return { fill: 0, band: 'none' };
  const step = Math.max(0, Math.min(5, Math.trunc(v)));
  return { fill: step * 20, band: `i${step}` };
}

/**
 * How lit each characteristic's hex is, 0 to 1: a +3 or better glows fully,
 * zero and below not at all, so the strong ones read before the numbers do.
 * @param {Record<string, {value?: unknown}>|null|undefined} characteristics
 * @returns {Record<string, number>}
 */
export function litHexes(characteristics) {
  const out = {};
  for (const [key, chr] of Object.entries(characteristics ?? {})) {
    const v = num(chr?.value) ?? 0;
    out[key] = round2(Math.min(1, Math.max(0, v) / LIT_AT));
  }
  return out;
}

/**
 * @param {object} npc  the sheet's own figures (npc-looks.mjs #buildModel)
 * @param {object} [_system]  Draw Steel's prepared system data, unused by this look
 * @param {{characteristics?: Record<string, {value?: unknown}>}} [env]
 * @returns {{vaArcs: object[], patienceArcs: object[], interest: {fill: number, band: string}, windedOffset: number|null, lit: Record<string, number>, nextVillain: string|null}}
 */
export function npcLookContext(npc, _system, env = {}) {
  const marks = Array.isArray(npc?.villain?.marks) ? npc.villain.marks : [];
  const windedAt = num(npc?.chronicle?.stamina?.windedAt);
  return {
    vaArcs: ringArcs(marks.map((m) => m.state !== 'used')),
    patienceArcs: ringArcs(npc?.negotiation?.patiencePips),
    interest: interestRing(npc?.negotiation),
    // The tick sits on the winded point, centred on it.
    windedOffset: windedAt === null ? null : round2(-(windedAt - 0.4)),
    lit: litHexes(env?.characteristics),
    nextVillain: marks.find((m) => m.state === 'next')?.name ?? null,
  };
}
