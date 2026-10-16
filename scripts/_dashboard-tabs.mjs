/**
 * Where a Chronicle Sync tab name leads. The rail has four sections; Linked,
 * Problems and Settings each hold panes picked from a strip at their top.
 * Names saved or linked by older versions (the seven-section rail, and before
 * it Status, Debug, History and Issues) still land where that content lives.
 */

/** The rail's sections, in rail order. */
export const DASHBOARD_TABS = ['overview', 'linked', 'problems', 'settings'];

/** Each section's panes, first is the default; Overview has none. */
export const SECTION_PANES = {
  linked: ['pages', 'characters', 'maps', 'shops', 'calendar'],
  problems: ['health', 'reports', 'history'],
  settings: ['connection', 'sync', 'calendar', 'players', 'advanced'],
};

const LEGACY = {
  entities: ['linked', 'pages'],
  characters: ['linked', 'characters'],
  issues: ['linked', 'characters'],
  maps: ['linked', 'maps'],
  shops: ['linked', 'shops'],
  calendar: ['linked', 'calendar'],
  diagnostics: ['problems', null],
  status: ['problems', 'health'],
  debug: ['problems', 'reports'],
  history: ['problems', 'history'],
};

/**
 * @param {string} name - a section name, optionally "<section>:<pane>"
 * @returns {{ tab: string, pane: string|null }} pane is null when the name
 *   doesn't choose one, so the caller keeps whichever pane was open
 */
export function resolveDashboardTab(name) {
  const [head, sub] = String(name ?? '').split(':');
  const [tab, legacyPane] = LEGACY[head] ?? [head, null];
  if (!DASHBOARD_TABS.includes(tab)) return { tab: 'overview', pane: null };
  const panes = SECTION_PANES[tab];
  if (!panes) return { tab, pane: null };
  const pane = sub ?? legacyPane;
  return { tab, pane: panes.includes(pane) ? pane : null };
}
