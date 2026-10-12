/**
 * Pure builder for the dashboard's Overview tab: a connection banner, a few
 * headline stats, and a prioritized "needs attention" list that routes the GM
 * to the tab that can fix each problem. Pure (no Foundry globals) so it is
 * unit-testable headlessly.
 */

const PREFIX = 'CHRONICLE.Dashboard.Overview.';

/**
 * English fallback for every string this model builds, keyed like lang/en.json
 * so headless callers (tests) get readable text without Foundry's i18n.
 */
export const DEFAULT_STRINGS = {
  StatEntities: 'Entities Synced',
  StatCharacters: 'Characters Synced',
  StatMaps: 'Maps Linked',
  Disconnected: 'Disconnected',
  Never: 'Never',
  LastSync: 'Last sync: {time}',
  Paused: 'Sync is paused until the connection is restored.',
  NotConnected: 'Not connected to Chronicle. Reconnect above, or open Diagnostics to see why.',
  CharactersUnmatchedOne: "{count} character couldn't be matched to Chronicle.",
  CharactersUnmatchedMany: "{count} characters couldn't be matched to Chronicle.",
  MembersUnmappedOne: '{count} campaign member not mapped to a Foundry user.',
  MembersUnmappedMany: '{count} campaign members not mapped to a Foundry user.',
  CalendarRebuilding: 'Chronicle’s calendar is being rebuilt — calendar sync is paused. Other sync is unaffected.',
  CalendarPausedReason: 'Calendar sync paused — {reason}',
  CalendarPaused: 'Calendar sync paused — see the Calendar tab.',
  CalendarOutOfSync: 'Calendar date is out of sync with Chronicle.',
  NoSystem: 'No matching game system — character fields may not sync.',
  ErrorsOne: '{count} recent sync error — see Diagnostics.',
  ErrorsMany: '{count} recent sync errors — see Diagnostics.',
};

/** Default translator: the English map above with `{name}` substitution. */
function defaultT(key, data) {
  const text = DEFAULT_STRINGS[key.slice(PREFIX.length)] ?? key;
  return data ? text.replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m)) : text;
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
 * @param {(key:string, data?:object)=>string} [p.t] - translator for full
 *   `CHRONICLE.Dashboard.Overview.*` keys; defaults to the English map
 * @returns {{connection:object, stats:Array, attention:Array, allClear:boolean}}
 */
export function buildOverviewModel(p = {}) {
  const {
    connectionState = 'disconnected',
    connectionLabel,
    syncedEntities = 0,
    linkedScenes = 0,
    characters = [],
    issuesCount = 0,
    unmatchedMembers = 0,
    calendarAvailable = false,
    calendarInSync = false,
    calendarSyncPaused = false,
    calendarPausedText = '',
    calendarRebuilding = false,
    errorCount = 0,
    matchedSystem = null,
    lastSyncTime,
    t = defaultT,
  } = p;
  const tr = (k, d) => t(PREFIX + k, d);

  const ok = connectionState === 'connected';
  const charList = Array.isArray(characters) ? characters : [];
  const charsSynced = charList.filter((c) => c && c.synced).length;

  const connection = {
    state: connectionState,
    label: connectionLabel ?? tr('Disconnected'),
    ok,
    detail: ok ? tr('LastSync', { time: lastSyncTime ?? tr('Never') }) : tr('Paused'),
  };

  const stats = [
    { label: tr('StatEntities'), value: String(syncedEntities), tab: 'entities' },
    { label: tr('StatCharacters'), value: `${charsSynced}/${charList.length}`, tab: 'characters' },
    { label: tr('StatMaps'), value: String(linkedScenes), tab: 'maps' },
  ];

  // Prioritized problems only — an empty list renders the calm "all clear" state.
  // Order matters: errors first (block sync), then warnings (data gaps), then info.
  const attention = [];

  if (!ok) {
    attention.push({
      severity: 'error',
      icon: 'fa-plug-circle-xmark',
      text: tr('NotConnected'),
      tab: 'diagnostics:health',
    });
  }
  if (issuesCount > 0) {
    attention.push({
      severity: 'warn',
      icon: 'fa-link-slash',
      text: tr(issuesCount === 1 ? 'CharactersUnmatchedOne' : 'CharactersUnmatchedMany', { count: issuesCount }),
      tab: 'characters',
    });
  }
  if (unmatchedMembers > 0) {
    attention.push({
      severity: 'warn',
      icon: 'fa-user-shield',
      text: tr(unmatchedMembers === 1 ? 'MembersUnmappedOne' : 'MembersUnmappedMany', { count: unmatchedMembers }),
      tab: 'settings:players',
    });
  }
  if (calendarRebuilding) {
    // Info, not error: calendar sync is deliberately paused during the
    // rebuild, nothing is broken and the GM can't act on it.
    attention.push({
      severity: 'info',
      icon: 'fa-screwdriver-wrench',
      text: tr('CalendarRebuilding'),
      tab: 'calendar',
    });
  } else if (calendarAvailable && calendarSyncPaused) {
    // A hard pause, not mere date drift — error severity so it sorts above
    // warnings. Use the classifier's own reason text rather than assuming why.
    attention.push({
      severity: 'error',
      icon: 'fa-calendar-xmark',
      text: calendarPausedText
        ? tr('CalendarPausedReason', { reason: calendarPausedText })
        : tr('CalendarPaused'),
      tab: 'calendar',
    });
  } else if (calendarAvailable && !calendarInSync) {
    attention.push({
      severity: 'warn',
      icon: 'fa-calendar-xmark',
      text: tr('CalendarOutOfSync'),
      tab: 'calendar',
    });
  }
  if (!matchedSystem) {
    attention.push({
      severity: 'info',
      icon: 'fa-circle-question',
      text: tr('NoSystem'),
      tab: 'diagnostics:health',
    });
  }
  if (errorCount > 0) {
    attention.push({
      severity: 'info',
      icon: 'fa-triangle-exclamation',
      text: tr(errorCount === 1 ? 'ErrorsOne' : 'ErrorsMany', { count: errorCount }),
      tab: 'diagnostics:health',
    });
  }

  return { connection, stats, attention, allClear: attention.length === 0 };
}
