// test-calendar-sync-hotfix.mjs — FM-CAL-SYNC-HOTFIX: off-DOM tests for the
// three calendar-sync fixes (off-by-one, back-catalog pagination, structure
// mismatch guard) plus the _calendariaNoteToChronicleEvent wiring.
//
// Run: node --test tools/test-calendar-sync-hotfix.mjs
//
// The date-normalization behavior is verified against Calendaria release-1.1.3
// source: raw note* hooks carry 0-indexed month/dayOfMonth + absolute year;
// CALENDARIA.api.getNote returns toPublic (1-indexed) dates.

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

const {
  chronicleDateFromCalendariaStartDate,
  calendarEventFetchCoordinates,
  compareCalendarStructures,
  CalendarSync,
} = await import('../scripts/calendar-sync.mjs');

// ── Item 1: date normalization (the off-by-one core) ─────────────────────────

test('raw hook startDate (0-indexed month + dayOfMonth) is corrected +1', () => {
  // March 15: Calendaria raw stores month 2 / dayOfMonth 14.
  assert.deepEqual(
    chronicleDateFromCalendariaStartDate({ year: 1492, month: 2, dayOfMonth: 14 }),
    { year: 1492, month: 3, day: 15 },
  );
});

test('the first-of-month / January zero case maps to 1/1, not an invalid 0/0', () => {
  assert.deepEqual(
    chronicleDateFromCalendariaStartDate({ year: 1492, month: 0, dayOfMonth: 0 }),
    { year: 1492, month: 1, day: 1 },
  );
});

test('a public (toPublic / getNote) startDate with `day` is NOT double-corrected', () => {
  // Already 1-indexed (dayOfMonth deleted, day set). Pass through unchanged.
  assert.deepEqual(
    chronicleDateFromCalendariaStartDate({ year: 1492, month: 3, day: 15 }),
    { year: 1492, month: 3, day: 15 },
  );
});

test('the year is absolute and never adjusted (no yearZero math)', () => {
  const out = chronicleDateFromCalendariaStartDate({ year: 20250, month: 5, dayOfMonth: 9 });
  assert.equal(out.year, 20250);
  assert.deepEqual(out, { year: 20250, month: 6, day: 10 });
});

test('missing/invalid startDate returns null', () => {
  assert.equal(chronicleDateFromCalendariaStartDate(null), null);
  assert.equal(chronicleDateFromCalendariaStartDate({}), null); // no year
});

// ── Item 1: _calendariaNoteToChronicleEvent wiring (raw vs getNote) ───────────

function makeCalendarSync(overrides) {
  return Object.assign(Object.create(CalendarSync.prototype), { _hasModernCalendariaApi: false }, overrides);
}

test('_calendariaNoteToChronicleEvent: raw hook payload (no modern API) is +1 corrected', () => {
  const cs = makeCalendarSync({ _hasModernCalendariaApi: false });
  const out = cs._calendariaNoteToChronicleEvent({
    name: 'Harvest Moon',
    flagData: { startDate: { year: 1492, month: 2, dayOfMonth: 14 } }, // raw March 15
  });
  assert.equal(out.year, 1492);
  assert.equal(out.month, 3);
  assert.equal(out.day, 15);
  assert.equal(out.name, 'Harvest Moon');
});

test('_calendariaNoteToChronicleEvent: getNote (public) date wins and is NOT double-corrected', () => {
  // getNote returns toPublic (1-indexed) data — it must take precedence over the
  // raw hook payload and receive no +1.
  globalThis.CALENDARIA = {
    api: { getNote: () => ({ name: 'Council', flagData: { startDate: { year: 1492, month: 3, day: 15 } } }) },
  };
  const cs = makeCalendarSync({ _hasModernCalendariaApi: true });
  const out = cs._calendariaNoteToChronicleEvent({
    id: 'note-1',
    name: 'Council',
    flagData: { startDate: { year: 1492, month: 1, dayOfMonth: 0 } }, // stale raw payload — should be ignored
  });
  assert.equal(out.month, 3); // from getNote (public), not raw month 1 → +1 = 2
  assert.equal(out.day, 15);
  assert.equal(out.year, 1492);
  delete globalThis.CALENDARIA;
});

test('_calendariaNoteToChronicleEvent: getNote failure falls back to the raw payload with +1', () => {
  globalThis.CALENDARIA = { api: { getNote: () => { throw new Error('note gone'); } } };
  const cs = makeCalendarSync({ _hasModernCalendariaApi: true });
  const out = cs._calendariaNoteToChronicleEvent({
    id: 'note-2',
    name: 'Skirmish',
    flagData: { startDate: { year: 1492, month: 2, dayOfMonth: 14 } },
  });
  assert.equal(out.month, 3);
  assert.equal(out.day, 15);
  delete globalThis.CALENDARIA;
});

// ── Item 2: back-catalog fetch coordinates ───────────────────────────────────

test('fetch coordinates enumerate every month across current year ±1', () => {
  const cal = { current_year: 1492, months: new Array(12).fill({ days: 30 }) };
  const coords = calendarEventFetchCoordinates(cal, 1);
  assert.equal(coords.length, 36); // 3 years × 12 months
  assert.deepEqual(coords[0], { year: 1491, month: 1 });
  assert.deepEqual(coords[coords.length - 1], { year: 1493, month: 12 });
});

test('a 15-month calendar (Calendar of Therin) yields 45 coordinates over ±1 year', () => {
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

// ── Item 2: the back-catalog must NOT echo (holds _syncing during create) ────

test('back-catalog sync holds _syncing while creating local notes (no echo re-push)', async () => {
  const syncingAtCreate = [];
  const cs = makeCalendarSync({
    _hasModernCalendariaApi: true,
    _syncing: false,
    _chronicleCalendar: { current_year: 1492, months: new Array(12).fill({ days: 30 }) },
    _api: { get: async () => [{ id: 'e1' }] }, // each month-window returns the same event
    _getLocalEventId: () => null, // nothing mapped yet
    _createLocalEvent(event) {
      // _createLocalEvent → CALENDARIA.api.createNote fires the noteCreated hook
      // synchronously; _syncing MUST be true here to suppress the echo re-push.
      syncingAtCreate.push(this._syncing);
      return Promise.resolve();
    },
  });
  await cs._syncChronicleEventsToCalendariaNotes();
  assert.ok(syncingAtCreate.length > 0, 'at least one event was created');
  assert.ok(syncingAtCreate.every((v) => v === true), '_syncing must be held true during every create');
  assert.equal(cs._syncing, false, '_syncing is reset after the loop');
});

// ── Item 3: structure comparison (B-R2) ──────────────────────────────────────

const gregorian = {
  months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map((d) => ({ days: d })),
  weekdays: new Array(7).fill({}),
};

test('identical structures match', () => {
  const foundry = { name: 'Gregorian', monthDays: gregorian.months.map((m) => m.days), weekdayCount: 7 };
  const r = compareCalendarStructures(gregorian, foundry);
  assert.equal(r.match, true);
  assert.equal(r.detail, '');
});

test('the operator’s real case: Gregorian 12mo/7wd vs Therin 15mo/6wd → mismatch', () => {
  const therin = { name: 'Calendar of Therin', monthDays: new Array(15).fill(24), weekdayCount: 6 };
  const r = compareCalendarStructures(gregorian, therin);
  assert.equal(r.match, false);
  assert.match(r.detail, /month count \(Chronicle 12 vs Foundry 15\)/);
  assert.match(r.detail, /weekday count \(Chronicle 7 vs Foundry 6\)/);
});

test('same month count but a different per-month day count is a mismatch', () => {
  const foundry = {
    name: 'Almost',
    monthDays: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // Feb 29 not 28
    weekdayCount: 7,
  };
  const r = compareCalendarStructures(gregorian, foundry);
  assert.equal(r.match, false);
  assert.match(r.detail, /month 2 day count \(Chronicle 28 vs Foundry 29\)/);
});

test('weekday count alone differing is a mismatch', () => {
  const foundry = { name: 'SixDay', monthDays: gregorian.months.map((m) => m.days), weekdayCount: 6 };
  const r = compareCalendarStructures(gregorian, foundry);
  assert.equal(r.match, false);
  assert.match(r.detail, /weekday count/);
});
