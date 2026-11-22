/**
 * The gilded card look's own figures for its templates
 * (templates/hero-looks/gilded/), beyond the chronicle.* ones every look gets.
 * Its boxes are the shared ones (Stamina bands, recovery dots, metals,
 * skills), so it adds none; only two timings differ.
 */

/**
 * How long this look's moves run (ms), where they differ from the shared
 * timings. Folding turns the card over, and entering Edit mode sends one foil
 * sweep across it; both run a little longer than the shared timings.
 */
export const MOVE_MS = Object.freeze({ fold: 700, editin: 1100 });

/**
 * Figures only this look draws, added to its templates' chronicle.* context.
 * @param {object} system  the hero's prepared system data
 * @param {{lang?: string, config?: object}} env  Foundry's language and ds.CONFIG
 * @returns {object}
 */
export function lookContext(system, env) {
  return {};
}
