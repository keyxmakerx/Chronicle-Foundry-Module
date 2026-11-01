/**
 * What saving a changed connection does to a running sync, decided without
 * Foundry so it can be tested.
 *
 * - Sync never started (first setup, or it was missing a field): start it.
 * - Same campaign, new address or key: reconnect; the client reads the
 *   address and key again each time it connects.
 * - A different campaign: reload. Every part holds links and caches for the
 *   old campaign, and swapping them under a live sync would mix the two.
 */

/**
 * @param {{ started: boolean, startedCampaign: string|null, campaign: string }} state
 * @returns {'start'|'reconnect'|'reload'}
 */
export function connectionAction({ started, startedCampaign, campaign }) {
  if (!started) return 'start';
  if (String(startedCampaign ?? '').trim() !== String(campaign ?? '').trim()) return 'reload';
  return 'reconnect';
}
