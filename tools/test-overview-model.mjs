/**
 * Tests for the Overview cockpit model (scripts/_overview-model.mjs).
 * Pure function — verifies stat formatting, the all-clear path, and that each
 * problem surfaces exactly one prioritized attention row routed to the right tab.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewModel } from '../scripts/_overview-model.mjs';

test('healthy world: connected, no problems → all clear', () => {
  const m = buildOverviewModel({
    connectionState: 'connected',
    connectionLabel: 'Connected',
    syncedEntities: 42,
    linkedScenes: 3,
    characters: [{ synced: true }, { synced: true }],
    issuesCount: 0,
    unmatchedMembers: 0,
    calendarAvailable: true,
    calendarInSync: true,
    errorCount: 0,
    matchedSystem: 'drawsteel',
    lastSyncTime: '12:00',
  });
  assert.equal(m.allClear, true);
  assert.equal(m.attention.length, 0);
  assert.equal(m.connection.ok, true);
  assert.match(m.connection.detail, /Last sync: 12:00/);
});

test('stats format counts and the synced/total character ratio', () => {
  const m = buildOverviewModel({
    syncedEntities: 7,
    linkedScenes: 2,
    characters: [{ synced: true }, { synced: false }, { synced: true }],
    matchedSystem: 'x',
    connectionState: 'connected',
  });
  const byTab = Object.fromEntries(m.stats.map((s) => [s.tab, s.value]));
  assert.equal(byTab.entities, '7');
  assert.equal(byTab.maps, '2');
  assert.equal(byTab.characters, '2/3');
});

test('disconnected surfaces a blocking error routed to status', () => {
  const m = buildOverviewModel({
    connectionState: 'disconnected',
    connectionLabel: 'Disconnected',
    matchedSystem: 'x',
  });
  assert.equal(m.connection.ok, false);
  const err = m.attention.find((a) => a.severity === 'error');
  assert.ok(err, 'expected a blocking error');
  assert.equal(err.tab, 'status');
  // Error must be first (highest priority).
  assert.equal(m.attention[0].severity, 'error');
});

test('each problem routes to the tab that fixes it', () => {
  const m = buildOverviewModel({
    connectionState: 'connected',
    issuesCount: 2,
    unmatchedMembers: 1,
    calendarAvailable: true,
    calendarInSync: false,
    errorCount: 5,
    matchedSystem: null,
  });
  const tabFor = (needle) => m.attention.find((a) => a.text.includes(needle))?.tab;
  assert.equal(tabFor("couldn't be matched"), 'issues');
  assert.equal(tabFor('not mapped'), 'members');
  assert.equal(tabFor('out of sync'), 'calendar');
  assert.equal(tabFor('No matching game system'), 'status');
  assert.equal(tabFor('recent sync error'), 'status');
  assert.equal(m.allClear, false);
});

test('pluralization: singular vs plural', () => {
  const one = buildOverviewModel({ connectionState: 'connected', issuesCount: 1, matchedSystem: 'x' });
  assert.match(one.attention[0].text, /1 character couldn't/);
  const many = buildOverviewModel({ connectionState: 'connected', issuesCount: 3, matchedSystem: 'x' });
  assert.match(many.attention[0].text, /3 characters couldn't/);
});

test('in-sync calendar produces no calendar alert; unavailable calendar is ignored', () => {
  const synced = buildOverviewModel({ connectionState: 'connected', calendarAvailable: true, calendarInSync: true, matchedSystem: 'x' });
  assert.equal(synced.attention.find((a) => a.tab === 'calendar'), undefined);
  const off = buildOverviewModel({ connectionState: 'connected', calendarAvailable: false, calendarInSync: false, matchedSystem: 'x' });
  assert.equal(off.attention.find((a) => a.tab === 'calendar'), undefined);
});

test('defensive: empty input does not throw and reports disconnected', () => {
  const m = buildOverviewModel();
  assert.equal(m.connection.ok, false);
  assert.equal(m.stats.length, 3);
  // No matchedSystem → the "no system" info alert is present.
  assert.ok(m.attention.some((a) => a.text.includes('No matching game system')));
});
