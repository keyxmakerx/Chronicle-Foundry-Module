/**
 * Chronicle Sync — Overview cockpit model
 *
 * Pure builder for the dashboard's Overview landing tab. Takes already-computed
 * pieces from the other tab-data builders and distills them into a "cockpit":
 * a connection banner, a few headline stats, and a prioritized "needs attention"
 * list that routes the GM straight to the tab that can fix each problem.
 *
 * Kept pure (no Foundry globals) so it can be unit-tested headlessly — the
 * dashboard passes plain values in and renders the returned model.
 */

/** Pluralize helper: "" for 1, "s" otherwise. */
function s(n) {
  return n === 1 ? '' : 's';
}

/**
 * Build the Overview cockpit model.
 *
 * @param {object} p
 * @param {string} p.connectionState - 'connected' | 'connecting' | 'reconnecting' | 'disconnected'
 * @param {string} p.connectionLabel - human label for the state
 * @param {number} p.syncedEntities  - count of journals linked to Chronicle entities
 * @param {number} p.linkedScenes    - count of Chronicle maps materialized
 * @param {Array}  [p.characters]    - synced-actor rows (each may have `.synced`)
 * @param {number} [p.issuesCount]   - unresolved character-link issues
 * @param {number} [p.unmatchedMembers] - campaign members with no Foundry user
 * @param {boolean}[p.calendarAvailable] - a calendar module + campaign calendar exist
 * @param {boolean}[p.calendarInSync]    - Foundry date matches Chronicle date
 * @param {number} [p.errorCount]    - recent REST/sync errors
 * @param {string|null} [p.matchedSystem] - matched Chronicle system slug, or null
 * @param {string} [p.lastSyncTime]  - last successful sync, human string
 * @returns {{connection:object, stats:Array, attention:Array, allClear:boolean}}
 */
export function buildOverviewModel(p = {}) {
  const {
    connectionState = 'disconnected',
    connectionLabel = 'Disconnected',
    syncedEntities = 0,
    linkedScenes = 0,
    characters = [],
    issuesCount = 0,
    unmatchedMembers = 0,
    calendarAvailable = false,
    calendarInSync = false,
    calendarSyncPaused = false,
    errorCount = 0,
    matchedSystem = null,
    lastSyncTime = 'Never',
  } = p;

  const ok = connectionState === 'connected';
  const charList = Array.isArray(characters) ? characters : [];
  const charsSynced = charList.filter((c) => c && c.synced).length;

  const connection = {
    state: connectionState,
    label: connectionLabel,
    ok,
    detail: ok ? `Last sync: ${lastSyncTime}` : 'Sync is paused until the connection is restored.',
  };

  const stats = [
    { label: `Entities Synced`, value: String(syncedEntities), tab: 'entities' },
    { label: `Characters Synced`, value: `${charsSynced}/${charList.length}`, tab: 'characters' },
    { label: `Maps Linked`, value: String(linkedScenes), tab: 'maps' },
  ];

  // Prioritized problems only — an empty list renders the calm "all clear" state.
  // Order matters: errors first (block sync), then warnings (data gaps), then info.
  const attention = [];

  if (!ok) {
    attention.push({
      severity: 'error',
      icon: 'fa-plug-circle-xmark',
      text: 'Not connected to Chronicle — open Status to reconnect.',
      tab: 'status',
    });
  }
  if (issuesCount > 0) {
    attention.push({
      severity: 'warn',
      icon: 'fa-link-slash',
      text: `${issuesCount} character${s(issuesCount)} couldn't be matched to Chronicle.`,
      tab: 'issues',
    });
  }
  if (unmatchedMembers > 0) {
    attention.push({
      severity: 'warn',
      icon: 'fa-user-shield',
      text: `${unmatchedMembers} campaign member${s(unmatchedMembers)} not mapped to a Foundry user.`,
      tab: 'members',
    });
  }
  if (calendarAvailable && calendarSyncPaused) {
    // Structure mismatch (B-R2): a hard pause, not a mere date drift — flag it
    // as an error so it sorts above ordinary warnings.
    attention.push({
      severity: 'error',
      icon: 'fa-calendar-xmark',
      text: 'Calendar sync paused — Foundry and Chronicle calendars have different structures.',
      tab: 'calendar',
    });
  } else if (calendarAvailable && !calendarInSync) {
    attention.push({
      severity: 'warn',
      icon: 'fa-calendar-xmark',
      text: 'Calendar date is out of sync with Chronicle.',
      tab: 'calendar',
    });
  }
  if (!matchedSystem) {
    attention.push({
      severity: 'info',
      icon: 'fa-circle-question',
      text: 'No matching game system — character fields may not sync.',
      tab: 'status',
    });
  }
  if (errorCount > 0) {
    attention.push({
      severity: 'info',
      icon: 'fa-triangle-exclamation',
      text: `${errorCount} recent sync error${s(errorCount)} — see Status.`,
      tab: 'status',
    });
  }

  return { connection, stats, attention, allClear: attention.length === 0 };
}
