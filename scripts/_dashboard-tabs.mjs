/**
 * Where a dashboard tab name leads. The rail has seven sections; Diagnostics
 * holds three panes. Names saved or linked by older versions (Status, Debug,
 * History, Issues) still land on the section that now holds their content.
 */

/** The rail's sections, in rail order. */
export const DASHBOARD_TABS = ['overview', 'entities', 'characters', 'calendar', 'maps', 'shops', 'diagnostics'];

/** The Diagnostics panes; the first is the default. */
export const DIAGNOSTIC_PANES = ['health', 'reports', 'history'];

const LEGACY = {
  status: ['diagnostics', 'health'],
  debug: ['diagnostics', 'reports'],
  history: ['diagnostics', 'history'],
  issues: ['characters', null],
};

/**
 * @param {string} name - a tab name, optionally "diagnostics:<pane>"
 * @returns {{ tab: string, pane: string|null }} pane is null when the name
 *   doesn't choose one, so the caller keeps whichever pane was open
 */
export function resolveDashboardTab(name) {
  const [head, sub] = String(name ?? '').split(':');
  const [tab, legacyPane] = LEGACY[head] ?? [head, null];
  if (!DASHBOARD_TABS.includes(tab)) return { tab: 'overview', pane: null };
  if (tab !== 'diagnostics') return { tab, pane: null };
  const pane = sub ?? legacyPane;
  return { tab, pane: DIAGNOSTIC_PANES.includes(pane) ? pane : null };
}
