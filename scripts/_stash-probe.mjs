/**
 * Whether Stashes is offered in this world. The GM client probes once
 * (GET /stashes/downtime): an older Chronicle without the routes, or a
 * campaign with the Armory addon off, answers 404 and the button simply never
 * shows. Any other failure (network, 5xx) is "unknown" and is neither cached
 * nor allowed to hide the button, so a blip cannot switch the feature off.
 */

/**
 * Turn a probe attempt into a verdict.
 * @param {{error?: any}} attempt
 * @returns {true|false|null} true available, false unavailable, null unknown.
 */
export function probeVerdict(attempt) {
  const err = attempt?.error;
  if (!err) return true;
  if (err.status === 404) return false;
  return null;
}

/**
 * Decide whether the shared flag needs writing. Unknown never writes; an
 * unchanged verdict never writes.
 * @param {boolean} stored
 * @param {true|false|null} verdict
 * @returns {boolean}
 */
export function shouldStoreVerdict(stored, verdict) {
  if (verdict === null) return false;
  return !!stored !== verdict;
}

/**
 * Whether the Stashes button is offered on a sheet.
 * @param {object} p
 * @param {boolean} p.available shared availability flag
 * @param {boolean} p.isGM
 * @param {boolean} p.isCharacter actor is a character actor
 * @param {boolean} p.linked actor carries a Chronicle entity id
 * @param {boolean} p.owns current user has OWNER permission on the actor
 * @returns {boolean}
 */
export function showStashButton({ available, isGM, isCharacter, linked, owns }) {
  if (!available || !isCharacter || !linked) return false;
  return isGM || owns;
}
