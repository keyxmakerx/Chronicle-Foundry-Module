/**
 * The steel and banner look's own figures for its templates
 * (templates/hero-looks/steel/), beyond the chronicle.* ones every look gets.
 * Pure: every figure comes from Draw Steel's prepared data.
 */

/** How long this look's moves run (ms), where they differ from the shared timings. */
export const MOVE_MS = Object.freeze({});

/**
 * Figures only this look draws, added to its templates' chronicle.* context.
 * @param {object} system  the hero's prepared system data
 * @param {{lang?: string, config?: object}} env  Foundry's language and ds.CONFIG
 * @returns {object}
 */
export function lookContext(system, env) {
  return {};
}
