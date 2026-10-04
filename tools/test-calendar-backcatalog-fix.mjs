// test-calendar-backcatalog-fix.mjs — off-DOM tests for CalendarSync's pull of
// Chronicle's calendar events and date (scripts/calendar-sync.mjs).
//
// Run: node --test tools/test-calendar-backcatalog-fix.mjs
//
// Pins: the events fetch unwraps Chronicle's { data, total } envelope and
// dedupes by id across month windows; the fetch coordinates are bounded to the
// current year ±span; the cached date follows the initial pull and the
// `calendar.date.advanced` broadcast.

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub the Foundry globals calendar-sync.mjs touches at module-load time.
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => null, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const { calendarEventFetchCoordinates, CalendarSync } = await import('../scripts/calendar-sync.mjs');

// Build a CalendarSync WITHOUT running the constructor.
function makeCalendarSync(overrides) {
  return Object.assign(Object.create(CalendarSync.prototype), overrides);
}

// ── fetch coordinates ────────────────────────────────────────────────────────

test('fetch coordinates enumerate every month across current year ±1', () => {
  const cal = { current_year: 1492, months: new Array(12).fill({ days: 30 }) };
  const coords = calendarEventFetchCoordinates(cal, 1);
  assert.equal(coords.length, 36); // 3 years × 12 months
  assert.deepEqual(coords[0], { year: 1491, month: 1 });
  assert.deepEqual(coords[coords.length - 1], { year: 1493, month: 12 });
});

test('a 15-month calendar yields 45 coordinates over ±1 year', () => {
  const cal = { current_year: 500, months: new Array(15).fill({ days: 24 }) };
  assert.equal(calendarEventFetchCoordinates(cal, 1).length, 45);
});

test('yearSpan 0 fetches only the current year', () => {
  const cal = { current_year: 1492, months: new Array(12).fill({ days: 30 }) };
  const coords = calendarEventFetchCoordinates(cal, 0);
  assert.equal(coords.length, 12);
  assert.ok(coords.every((c) => c.year === 1492));
});

test('no calendar / no months yields no coordinates (caller falls back to a bare fetch)', () => {
  assert.deepEqual(calendarEventFetchCoordinates(null), []);
  assert.deepEqual(calendarEventFetchCoordinates({ current_year: 1492, months: [] }), []);
  assert.deepEqual(calendarEventFetchCoordinates({ current_year: 1492 }), []);
});

// ── events fetch ─────────────────────────────────────────────────────────────

function makeFetcher(getImpl) {
  const paths = [];
  const cs = makeCalendarSync({
    // 1 month × (current year ±1) = 3 fetch windows.
    _chronicleCalendar: { current_year: 1492, months: [{ days: 30 }] },
    _api: { get: async (path) => { paths.push(path); return getImpl(path); } },
  });
  return { cs, paths };
}

test('{ data, total } envelope with 2 distinct events across 2 windows → 2 events', async () => {
  let call = 0;
  const { cs, paths } = makeFetcher(async () => {
    call += 1;
    if (call === 1) return { data: [{ id: 'a' }], total: 1 };
    if (call === 2) return { data: [{ id: 'b' }], total: 1 };
    return { data: [], total: 0 };
  });
  const events = await cs.fetchEvents();
  assert.deepEqual(events.map((e) => e.id).sort(), ['a', 'b']);
  assert.deepEqual(paths, [
    '/calendar/events?year=1491&month=1',
    '/calendar/events?year=1492&month=1',
    '/calendar/events?year=1493&month=1',
  ]);
});

test('a recurring event surfacing in every window is returned ONCE (dedupe by id)', async () => {
  const { cs } = makeFetcher(async () => ({ data: [{ id: 'recur' }], total: 1 }));
  assert.equal((await cs.fetchEvents()).length, 1);
});

test('a bare-array response is still tolerated (back-compat)', async () => {
  const { cs } = makeFetcher(async () => [{ id: 'x' }]);
  assert.equal((await cs.fetchEvents()).length, 1);
});

test('a non-array, non-envelope body skips the window without throwing', async () => {
  for (const body of [null, {}, { unexpected: true }, { data: 'nope' }, 42]) {
    const { cs } = makeFetcher(async () => body);
    assert.equal((await cs.fetchEvents()).length, 0, `body ${JSON.stringify(body)} must yield nothing`);
  }
});

test('a failing window is skipped, the rest still fetch', async () => {
  let call = 0;
  const { cs } = makeFetcher(async () => {
    call += 1;
    if (call === 1) throw new Error('502');
    return { data: [{ id: `e${call}` }], total: 1 };
  });
  assert.deepEqual((await cs.fetchEvents()).map((e) => e.id), ['e2', 'e3']);
});

test('no cached structure falls back to one bare fetch', async () => {
  const paths = [];
  const cs = makeCalendarSync({
    _chronicleCalendar: null,
    _api: { get: async (path) => { paths.push(path); return []; } },
  });
  await cs.fetchEvents();
  assert.deepEqual(paths, ['/calendar/events']);
});

// ── cached date ──────────────────────────────────────────────────────────────

test('chronicleDate reads the cached calendar and follows calendar.date.advanced', () => {
  const cs = makeCalendarSync({
    _chronicleCalendar: { current_year: 1492, current_month: 3, current_day: 15, current_hour: 9, current_minute: 30 },
  });
  assert.deepEqual(cs.chronicleDate, { year: 1492, month: 3, day: 15, hour: 9, minute: 30 });
  cs._onChronicleDateAdvanced({ year: 1492, month: 3, day: 16, hour: 0, minute: 0 });
  assert.deepEqual(cs.chronicleDate, { year: 1492, month: 3, day: 16, hour: 0, minute: 0 });
});

test('chronicleDate is null before any calendar was pulled; an advance then is ignored', () => {
  const cs = makeCalendarSync({ _chronicleCalendar: null });
  assert.equal(cs.chronicleDate, null);
  cs._onChronicleDateAdvanced({ year: 1, month: 1, day: 1 });
  assert.equal(cs.chronicleDate, null);
  cs._onChronicleDateAdvanced(null);
});
