#!/usr/bin/env node
/**
 * Chronicle Sync's four sections and their panes, and old tab names landing
 * where their content moved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDashboardTab, DASHBOARD_TABS, SECTION_PANES } from '../scripts/_dashboard-tabs.mjs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('current names resolve to themselves', () => {
  for (const tab of DASHBOARD_TABS) assert.equal(resolveDashboardTab(tab).tab, tab);
  for (const [tab, panes] of Object.entries(SECTION_PANES)) {
    for (const pane of panes) assert.deepEqual(resolveDashboardTab(`${tab}:${pane}`), { tab, pane });
    assert.deepEqual(resolveDashboardTab(tab), { tab, pane: null });
  }
});

test('names from the seven-section rail land in Linked or Problems', () => {
  assert.deepEqual(resolveDashboardTab('entities'), { tab: 'linked', pane: 'pages' });
  assert.deepEqual(resolveDashboardTab('characters'), { tab: 'linked', pane: 'characters' });
  assert.deepEqual(resolveDashboardTab('maps'), { tab: 'linked', pane: 'maps' });
  assert.deepEqual(resolveDashboardTab('shops'), { tab: 'linked', pane: 'shops' });
  assert.deepEqual(resolveDashboardTab('calendar'), { tab: 'linked', pane: 'calendar' });
  assert.deepEqual(resolveDashboardTab('diagnostics'), { tab: 'problems', pane: null });
  assert.deepEqual(resolveDashboardTab('diagnostics:reports'), { tab: 'problems', pane: 'reports' });
});

test('older names still land on the section that holds their content', () => {
  assert.deepEqual(resolveDashboardTab('status'), { tab: 'problems', pane: 'health' });
  assert.deepEqual(resolveDashboardTab('debug'), { tab: 'problems', pane: 'reports' });
  assert.deepEqual(resolveDashboardTab('history'), { tab: 'problems', pane: 'history' });
  assert.deepEqual(resolveDashboardTab('issues'), { tab: 'linked', pane: 'characters' });
});

test('settings tabs are panes of the Settings section', () => {
  assert.deepEqual(resolveDashboardTab('settings:players'), { tab: 'settings', pane: 'players' });
  assert.deepEqual(resolveDashboardTab('settings:calendar'), { tab: 'settings', pane: 'calendar' });
  assert.deepEqual(resolveDashboardTab('settings:'), { tab: 'settings', pane: null });
});

test('unknown names fall back to the overview', () => {
  for (const name of ['', undefined, 'config', 'members', 'x:nope']) {
    assert.equal(resolveDashboardTab(name).tab, 'overview');
  }
  assert.deepEqual(resolveDashboardTab('problems:nope'), { tab: 'problems', pane: null });
});

test('the rail, sections and pane strips match the four sections', () => {
  const hbs = read('templates/sync-dashboard.hbs') + read('templates/chronicle-settings.hbs');
  const rail = [...hbs.matchAll(/<a class="item[^"]*" data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rail, DASHBOARD_TABS);
  const panels = [...hbs.matchAll(/<div class="tab" data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...panels].sort(), [...DASHBOARD_TABS].sort());
  for (const [tab, panes] of Object.entries(SECTION_PANES)) {
    const shown = [...hbs.matchAll(new RegExp(`data-subpane="${tab}:([^"]+)"`, 'g'))].map((m) => m[1]);
    assert.deepEqual([...shown].sort(), [...panes].sort(), `${tab} panes`);
  }
  const strip = [...hbs.matchAll(/data-subtab="(linked|problems):([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(strip, [...SECTION_PANES.linked.map((p) => `linked:${p}`), ...SECTION_PANES.problems.map((p) => `problems:${p}`)]);
  assert.match(hbs, /data-subtab="settings:\{\{id\}\}"/);
});

test('the Settings section is the settings form, and shows alone before a campaign is connected', () => {
  const hbs = read('templates/sync-dashboard.hbs');
  const partial = '{{> "modules/chronicle-sync/templates/chronicle-settings.hbs" settings}}';
  assert.equal(hbs.split(partial).length - 1, 2);
  assert.ok(hbs.indexOf(partial) < hbs.indexOf('{{else}}'), 'the unconnected state shows the form');
  const src = read('scripts/sync-dashboard.mjs');
  assert.match(src, /templates: \['modules\/chronicle-sync\/templates\/chronicle-settings\.hbs'\]/);
  assert.match(src, /return \{ configured: false, settings: await settingsContext\(this\._settings\) \}/);
});

test('every overview jump target resolves to a real section', () => {
  const src = read('scripts/_overview-model.mjs');
  for (const [, tab] of src.matchAll(/tab: '([^']+)'/g)) {
    const resolved = resolveDashboardTab(tab);
    assert.equal(`${resolved.tab}:${resolved.pane}`, tab, tab);
  }
});

test('every localize key in the dashboard and settings templates resolves in lang/en.json', () => {
  const hbs = read('templates/sync-dashboard.hbs') + read('templates/chronicle-settings.hbs');
  const lang = JSON.parse(read('lang/en.json'));
  const keys = [...hbs.matchAll(/localize\s+(["'])([^"']+)\1/g)].map((m) => m[2]);
  assert.ok(keys.length > 100, 'expected the template to localize its labels');
  for (const key of keys) {
    const value = key.split('.').reduce((o, part) => (o == null ? o : o[part]), lang);
    assert.equal(typeof value, 'string', `${key} is missing from lang/en.json`);
  }
});

test('the overview model\'s built-in English matches lang/en.json', async () => {
  const { DEFAULT_STRINGS } = await import('../scripts/_overview-model.mjs');
  const lang = JSON.parse(read('lang/en.json'));
  assert.deepEqual(DEFAULT_STRINGS, Object.fromEntries(
    Object.keys(DEFAULT_STRINGS).map((k) => [k, lang.CHRONICLE.Dashboard.Overview[k]])));
});
