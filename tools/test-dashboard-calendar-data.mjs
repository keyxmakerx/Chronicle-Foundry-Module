#!/usr/bin/env node
/**
 * The dashboard's Calendar tab shows Chronicle's own date and world state:
 * no Foundry calendar is read or compared, and an unavailable Chronicle
 * calendar says why instead of reading as "no calendar".
 *
 * Run: node --test tools/test-dashboard-calendar-data.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
};
let syncCalendar = true;
globalThis.game = globalThis.game || {
  settings: { get: (_scope, key) => (key === 'syncCalendar' ? syncCalendar : null), register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {}, once: () => {} };

const { SyncDashboard } = await import('../scripts/sync-dashboard.mjs');
const { CalendarSync } = await import('../scripts/calendar-sync.mjs');
const { reduceSubresourceState, emptySubresourceState } = await import('../scripts/_calendar-subresources.mjs');

function makeDashboard({ get, modules = [] }) {
  return Object.assign(Object.create(SyncDashboard.prototype), {
    _syncManager: { api: { get, dropLastErrorLogEntry() {} }, _modules: modules },
  });
}

// `api` is a getter on the dashboard; shadow it with the stub.
function withApi(dash, api) {
  Object.defineProperty(dash, 'api', { value: api });
  return dash;
}

test('shows Chronicle’s date and calendar name, with no Foundry date', async () => {
  syncCalendar = true;
  const api = { get: async () => ({ name: 'Harptos', current_year: 1492, current_month: 3, current_day: 15, current_hour: 9, current_minute: 5 }), dropLastErrorLogEntry() {} };
  const dash = withApi(makeDashboard({ get: api.get }), api);
  const data = await dash._buildCalendarData();
  assert.equal(data.available, true);
  assert.deepEqual(data.chronicleDate, { year: 1492, month: 3, day: 15, hour: 9, minute: 5, calendarName: 'Harptos' });
  assert.equal('localDate' in data, false);
  assert.equal('module' in data, false);
});

test('projects the world state CalendarSync folded from the stream', async () => {
  syncCalendar = true;
  const cs = Object.assign(Object.create(CalendarSync.prototype), {
    _subresourceState: reduceSubresourceState(emptySubresourceState(), 'calendar.season.changed', { name: 'Spring' }),
  });
  const api = { get: async () => ({ current_year: 1, current_month: 1, current_day: 1 }), dropLastErrorLogEntry() {} };
  const dash = withApi(makeDashboard({ get: api.get, modules: [cs] }), api);
  const data = await dash._buildCalendarData();
  assert.equal(data.worldState.has, true);
  assert.equal(data.worldState.seasonName, 'Spring');
});

test('calendar sync off → unavailable, no request', async () => {
  syncCalendar = false;
  let called = 0;
  const api = { get: async () => { called += 1; return {}; } };
  const dash = withApi(makeDashboard({ get: api.get }), api);
  const data = await dash._buildCalendarData();
  assert.equal(data.available, false);
  assert.equal(data.enabled, false);
  assert.equal(called, 0);
});

test('the rebuild 503 reads as rebuilding, a 404 as no calendar, anything else as unreachable', async () => {
  syncCalendar = true;
  const cases = [
    [Object.assign(new Error('Chronicle API error 503: {"error":"calendar_rebuilding"}'), { status: 503, code: 'calendar_rebuilding' }), 'calendarRebuilding'],
    [Object.assign(new Error('Chronicle API error 404: {"error":"calendar_not_configured"}'), { status: 404 }), 'noCampaignCalendar'],
    [Object.assign(new Error('Chronicle API error 500: boom'), { status: 500 }), 'calendarUnreachable'],
  ];
  for (const [err, flag] of cases) {
    const api = { get: async () => { throw err; }, dropLastErrorLogEntry() {} };
    const data = await withApi(makeDashboard({ get: api.get }), api)._buildCalendarData();
    assert.equal(data.available, false);
    assert.equal(data[flag], true, flag);
  }
});
