#!/usr/bin/env node
/**
 * The dashboard's seven sections, and old tab names landing where their
 * content moved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDashboardTab, DASHBOARD_TABS } from '../scripts/_dashboard-tabs.mjs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('current names resolve to themselves', () => {
  for (const tab of DASHBOARD_TABS) assert.equal(resolveDashboardTab(tab).tab, tab);
  assert.deepEqual(resolveDashboardTab('diagnostics:history'), { tab: 'diagnostics', pane: 'history' });
  assert.deepEqual(resolveDashboardTab('diagnostics'), { tab: 'diagnostics', pane: null });
});

test('old names land on the section that holds their content', () => {
  assert.deepEqual(resolveDashboardTab('status'), { tab: 'diagnostics', pane: 'health' });
  assert.deepEqual(resolveDashboardTab('debug'), { tab: 'diagnostics', pane: 'reports' });
  assert.deepEqual(resolveDashboardTab('history'), { tab: 'diagnostics', pane: 'history' });
  assert.deepEqual(resolveDashboardTab('issues'), { tab: 'characters', pane: null });
});

test('unknown names fall back to the overview', () => {
  for (const name of ['', undefined, 'config', 'members', 'x:nope']) {
    assert.equal(resolveDashboardTab(name).tab, 'overview');
  }
  assert.deepEqual(resolveDashboardTab('diagnostics:nope'), { tab: 'diagnostics', pane: null });
});

test('the rail and the panels match the seven sections', () => {
  const hbs = read('templates/sync-dashboard.hbs');
  const rail = [...hbs.matchAll(/<a class="item[^"]*" data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...rail].sort(), [...DASHBOARD_TABS].sort());
  const panels = [...hbs.matchAll(/<div class="tab" data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...panels].sort(), [...DASHBOARD_TABS].sort());
  const panes = [...hbs.matchAll(/data-diag-pane="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(panes, ['health', 'reports', 'history']);
});

test('every overview jump target resolves to a real section', () => {
  const src = read('scripts/_overview-model.mjs');
  for (const [, tab] of src.matchAll(/tab: '([^']+)'/g)) {
    if (tab.startsWith('settings:')) continue;
    assert.equal(resolveDashboardTab(tab).tab, tab.split(':')[0], tab);
  }
});
