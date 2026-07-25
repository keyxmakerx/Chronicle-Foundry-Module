// test-calendar-sync-state.mjs — FM-SYNC-WIRE-FIX fix 3: the honest four-state
// calendar sync-state classifier. Pure helper, no Foundry globals needed.
//
// Run: node --test tools/test-calendar-sync-state.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCalendarSyncState } from '../scripts/_calendar-sync-state.mjs';

const D = (year, month, day) => ({ year, month, day });

// ── paused (module _calendarSyncDisabled) — highest priority ──────────────────

test('paused wins over everything, even when dates happen to match', () => {
  const r = classifyCalendarSyncState({
    paused: true,
    pausedDetail: 'Chronicle: Gregorian 12mo/7wd · Foundry: Therin 15mo/6wd — month count',
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 15), // identical, but the module has stopped syncing
  });
  assert.equal(r.state, 'paused');
  assert.equal(r.direction, null);
  assert.match(r.detail, /Therin 15mo\/6wd/);
});

test('paused with no detail still classifies as paused with a generic reason', () => {
  const r = classifyCalendarSyncState({ paused: true, pausedDetail: null });
  assert.equal(r.state, 'paused');
  assert.match(r.detail, /paused/i);
});

// ── incompatible-structures (dashboard-detected, module NOT paused) ───────────

test('module not paused but structures differ → incompatible-structures with counts', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: false, detail: 'month count (Chronicle 12 vs Foundry 15)' },
    chronicleShape: '12mo/7wd',
    foundryShape: '15mo/6wd',
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 15),
  });
  assert.equal(r.state, 'incompatible-structures');
  assert.equal(r.direction, null);
  assert.match(r.detail, /Chronicle 12mo\/7wd vs Foundry 15mo\/6wd/);
  assert.match(r.detail, /month count/);
});

test('incompatible-structures is reachable even when the fail-open module never paused (regression: SC path)', () => {
  // The exact fail-open scenario fix 2 + fix 3 target: SimpleCalendar world, module
  // read the structure too late to pause, but the dashboard can compare now.
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: false, detail: 'weekday count (Chronicle 7 vs Foundry 10)' },
    chronicleShape: '12mo/7wd',
    foundryShape: '12mo/10wd',
    chronicleDate: D(1, 1, 1),
    foundryDate: D(1, 1, 1),
  });
  assert.equal(r.state, 'incompatible-structures');
});

test('a matching structureCmp does NOT trigger incompatible — falls through to date logic', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 15),
  });
  assert.equal(r.state, 'in-sync');
});

test('null structureCmp (could not compare) fails open — never reports incompatible', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: null,
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 16),
  });
  assert.equal(r.state, 'date-drift'); // drift, not incompatible
});

// ── date-drift (with direction) ───────────────────────────────────────────────

test('Chronicle later than Foundry → date-drift, chronicle-ahead', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1492, 5, 1),
    foundryDate: D(1492, 3, 15),
  });
  assert.equal(r.state, 'date-drift');
  assert.equal(r.direction, 'chronicle-ahead');
});

test('Foundry later than Chronicle → date-drift, foundry-ahead', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 16),
  });
  assert.equal(r.state, 'date-drift');
  assert.equal(r.direction, 'foundry-ahead');
});

test('drift detection walks year → month → day (a year difference dominates)', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1490, 12, 30),
    foundryDate: D(1492, 1, 1),
  });
  assert.equal(r.state, 'date-drift');
  assert.equal(r.direction, 'foundry-ahead'); // 1490 < 1492 despite larger month/day
});

test('unreadable local date can never be called in-sync → date-drift, unknown direction', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1492, 3, 15),
    foundryDate: null,
  });
  assert.equal(r.state, 'date-drift');
  assert.equal(r.direction, null);
});

// ── in-sync ───────────────────────────────────────────────────────────────────

test('compatible structures + equal dates → in-sync', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: { match: true, detail: '' },
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 15),
  });
  assert.equal(r.state, 'in-sync');
  assert.equal(r.direction, null);
});

test('in-sync also holds when structures were simply not comparable but dates match', () => {
  const r = classifyCalendarSyncState({
    paused: false,
    structureCmp: null,
    chronicleDate: D(1492, 3, 15),
    foundryDate: D(1492, 3, 15),
  });
  assert.equal(r.state, 'in-sync');
});

// ── all four states are reachable (the honest-badge contract) ─────────────────

test('the classifier yields exactly the four documented states across inputs', () => {
  const states = new Set([
    classifyCalendarSyncState({ paused: true }).state,
    classifyCalendarSyncState({ paused: false, structureCmp: { match: false, detail: 'x' } }).state,
    classifyCalendarSyncState({ paused: false, structureCmp: { match: true }, chronicleDate: D(1, 1, 1), foundryDate: D(1, 1, 2) }).state,
    classifyCalendarSyncState({ paused: false, structureCmp: { match: true }, chronicleDate: D(1, 1, 1), foundryDate: D(1, 1, 1) }).state,
  ]);
  assert.deepEqual(
    [...states].sort(),
    ['date-drift', 'in-sync', 'incompatible-structures', 'paused'],
  );
});
