// test-calendar-backcatalog-fix.mjs — FM-CAL-BACKCATALOG-FIX regression tests.
//
// Run: node --test tools/test-calendar-backcatalog-fix.mjs
//
// Pins the three post-merge-review fixes to PR #76:
//   1. BLOCKER — back-catalog unwraps Chronicle's { data, total } envelope
//      (the #76 stub used a bare array and masked a total no-op).
//   2. HIGH — the Calendaria dateTimeChange push reads the RAW 0-indexed
//      components nested under `.current` and corrects them +1, ignoring the
//      day-of-YEAR `day` sibling that rides in game.time.components.
//   3. MEDIUM — the echo-suppression guard is a reentrant depth counter, so a
//      WS event resolving mid-back-catalog does not unmask the loop.
// Plus the two RC-9 ride-alongs on compareCalendarStructures.
//
// Payload shape verified against Calendaria release-1.1.3 source (commit
// ee04e441…): time-tracker.mjs #fireDateTimeChangeHook nests raw components
// under hookData.current; api.mjs toPublic is the (un-applied here) 0→1 +1.

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

const { compareCalendarStructures, CalendarSync } = await import('../scripts/calendar-sync.mjs');

// Build a CalendarSync WITHOUT running the constructor; seed _syncDepth: 0 to
// mirror the reentrant-guard init.
function makeCalendarSync(overrides) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    { _hasModernCalendariaApi: true, _syncDepth: 0 },
    overrides,
  );
}

// ── Item 1: BLOCKER — envelope unwrap ────────────────────────────────────────

function makeBackcatalog(getImpl, overrides) {
  const created = [];
  const cs = makeCalendarSync(Object.assign({
    // 1 month × (current year ±1) = 3 fetch windows.
    _chronicleCalendar: { current_year: 1492, months: [{ days: 30 }] },
    _api: { get: getImpl },
    _getLocalEventId: () => null,
    _createLocalEvent(e) { created.push(e); return Promise.resolve(); },
  }, overrides));
  return { cs, created };
}

test('BLOCKER: { data, total } envelope with 2 distinct events across 2 windows → 2 notes', async () => {
  let call = 0;
  const { cs, created } = makeBackcatalog(async () => {
    call += 1;
    if (call === 1) return { data: [{ id: 'a' }], total: 1 };
    if (call === 2) return { data: [{ id: 'b' }], total: 1 };
    return { data: [], total: 0 };
  });
  await cs._syncChronicleEventsToCalendariaNotes();
  assert.deepEqual(created.map((e) => e.id).sort(), ['a', 'b']);
});

test('BLOCKER: a recurring event surfacing in every window is created ONCE (dedupe by id)', async () => {
  const { cs, created } = makeBackcatalog(async () => ({ data: [{ id: 'recur' }], total: 1 }));
  await cs._syncChronicleEventsToCalendariaNotes();
  assert.equal(created.length, 1);
});

test('BLOCKER: a bare-array response is still tolerated (back-compat)', async () => {
  const { cs, created } = makeBackcatalog(async () => [{ id: 'x' }]);
  await cs._syncChronicleEventsToCalendariaNotes();
  assert.equal(created.length, 1);
});

test('BLOCKER: a non-array, non-envelope body skips the window without throwing', async () => {
  for (const body of [null, {}, { unexpected: true }, { data: 'nope' }, 42]) {
    const { cs, created } = makeBackcatalog(async () => body);
    await cs._syncChronicleEventsToCalendariaNotes();
    assert.equal(created.length, 0, `body ${JSON.stringify(body)} must create nothing`);
  }
});

// ── Item 2: HIGH — dateTimeChange push (nested .current, raw 0-indexed) ───────

function makeDatePush(overrides) {
  const puts = [];
  const cs = makeCalendarSync(Object.assign({
    _calendarSyncDisabled: false,
    _isActiveCalendarExcluded: () => false,
    _api: { put: async (path, body) => { puts.push({ path, body }); return { id: 'ok' }; } },
  }, overrides));
  return { cs, puts };
}

test('HIGH: nested .current raw payload → 1-indexed wire date; day-of-YEAR `day` sibling ignored', async () => {
  const { cs, puts } = makeDatePush();
  // March 15 1492: raw month 2 / dayOfMonth 14, with a day-of-year `day` (=73)
  // that MUST NOT be used as the day-of-month.
  await cs._onCalendariaDateTimeChange({
    current: { year: 1492, month: 2, dayOfMonth: 14, day: 73, hour: 9, minute: 30, second: 5 },
    previous: {}, diff: 1,
  });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/calendar/date');
  assert.deepEqual(puts[0].body, { year: 1492, month: 3, day: 15, hour: 9, minute: 30 });
});

test('HIGH: the January-1 zero case → 1/1, never an invalid 0/0', async () => {
  const { cs, puts } = makeDatePush();
  await cs._onCalendariaDateTimeChange({ current: { year: 1492, month: 0, dayOfMonth: 0, day: 0, hour: 0, minute: 0 } });
  assert.deepEqual(puts[0].body, { year: 1492, month: 1, day: 1, hour: 0, minute: 0 });
});

test('HIGH: flat payload (no .current) still works via the data.current ?? data fallback', async () => {
  const { cs, puts } = makeDatePush();
  await cs._onCalendariaDateTimeChange({ year: 1492, month: 5, dayOfMonth: 9, hour: 13, minute: 45 });
  assert.deepEqual(puts[0].body, { year: 1492, month: 6, day: 10, hour: 13, minute: 45 });
});

test('HIGH: a genuinely public payload (has `day`, no `dayOfMonth`) passes through un-incremented', async () => {
  const { cs, puts } = makeDatePush();
  await cs._onCalendariaDateTimeChange({ current: { year: 1492, month: 3, day: 15, hour: 1, minute: 2 } });
  assert.deepEqual(puts[0].body, { year: 1492, month: 3, day: 15, hour: 1, minute: 2 });
});

test('HIGH: missing hour/minute default to 0', async () => {
  const { cs, puts } = makeDatePush();
  await cs._onCalendariaDateTimeChange({ current: { year: 1492, month: 2, dayOfMonth: 14 } });
  assert.deepEqual(puts[0].body, { year: 1492, month: 3, day: 15, hour: 0, minute: 0 });
});

test('HIGH: a payload with no usable date (year undefined) does NOT push', async () => {
  const { cs, puts } = makeDatePush();
  await cs._onCalendariaDateTimeChange({ current: { month: 2, dayOfMonth: 14 } });
  assert.equal(puts.length, 0);
});

test('HIGH: guarded off — _syncing (depth>0), non-GM, and paused all suppress the push', async () => {
  const payload = { current: { year: 1492, month: 2, dayOfMonth: 14 } };

  const a = makeDatePush({ _syncDepth: 1 });
  await a.cs._onCalendariaDateTimeChange(payload);
  assert.equal(a.puts.length, 0, 'in-flight sync suppresses the push');

  game.user.isGM = false;
  const b = makeDatePush();
  await b.cs._onCalendariaDateTimeChange(payload);
  assert.equal(b.puts.length, 0, 'non-GM does not push');
  game.user.isGM = true;

  const c = makeDatePush({ _calendarSyncDisabled: true });
  await c.cs._onCalendariaDateTimeChange(payload);
  assert.equal(c.puts.length, 0, 'structure-mismatch pause suppresses the push');
});

// ── Item 3: MEDIUM — reentrant depth-counter guard ───────────────────────────

test('MEDIUM: _syncDepth nests — the guard stays active until the OUTERMOST scope exits', () => {
  const cs = makeCalendarSync({ _syncDepth: 0 });
  assert.equal(cs._syncing, false);
  cs._syncDepth += 1;                       // outer scope (e.g. back-catalog loop)
  assert.equal(cs._syncing, true);
  cs._syncDepth += 1;                       // inner scope (e.g. WS handler)
  cs._syncDepth -= 1;                       // inner exits — must NOT unmask
  assert.equal(cs._syncing, true, 'still held after the inner scope exits');
  cs._syncDepth -= 1;                       // outer exits
  assert.equal(cs._syncing, false);
});

test('MEDIUM: a WS _onChronicleEventCreated resolving mid-back-catalog does not unmask the loop', async () => {
  const syncingSeen = [];
  let injected = false;
  const cs = makeCalendarSync({
    _chronicleCalendar: { current_year: 1492, months: [{ days: 30 }] },
    _api: { get: async () => ({ data: [{ id: 'e1' }, { id: 'e2' }], total: 2 }) },
    _getLocalEventId: () => null,
    async _createLocalEvent() {
      syncingSeen.push(this._syncing);
      if (!injected) {
        injected = true;
        // A Chronicle WS event lands mid-loop: run the REAL handler, whose
        // finally does _syncDepth-- . With the old boolean this cleared the
        // guard for the remaining creates → duplicate re-POST.
        await CalendarSync.prototype._onChronicleEventCreated.call(this, { id: 'ws-1' });
      }
    },
  });
  await cs._syncChronicleEventsToCalendariaNotes();
  assert.ok(syncingSeen.length >= 2, 'multiple creates happened');
  assert.ok(syncingSeen.every((v) => v === true), 'guard stays held across the interleaved WS event');
  assert.equal(cs._syncing, false, 'guard fully released after the loop');
});

// ── Ride-alongs: compareCalendarStructures (RC-9) ────────────────────────────

const twelveMonths = new Array(12).fill({ days: 30 });
const twelveMonthDays = new Array(12).fill(30);

test('ride-along: an unreadable Foundry weekday list (count 0) does not pause when months match', () => {
  const chronicle = { months: twelveMonths, weekdays: new Array(7).fill({}) };
  const foundry = { name: 'X', monthDays: twelveMonthDays, weekdayCount: 0 };
  assert.equal(compareCalendarStructures(chronicle, foundry).match, true);
});

test('ride-along: an unreadable Chronicle weekday list (0) also does not pause when months match', () => {
  const chronicle = { months: twelveMonths, weekdays: [] };
  const foundry = { name: 'X', monthDays: twelveMonthDays, weekdayCount: 7 };
  assert.equal(compareCalendarStructures(chronicle, foundry).match, true);
});

test('ride-along: a REAL weekday difference (both > 0) still pauses', () => {
  const chronicle = { months: twelveMonths, weekdays: new Array(7).fill({}) };
  const foundry = { name: 'X', monthDays: twelveMonthDays, weekdayCount: 6 };
  const r = compareCalendarStructures(chronicle, foundry);
  assert.equal(r.match, false);
  assert.match(r.detail, /weekday count/);
});

test('ride-along: a month mismatch still pauses even when weekdays are unreadable (fail-closed on months)', () => {
  const chronicle = { months: twelveMonths, weekdays: new Array(7).fill({}) };
  const foundry = { name: 'X', monthDays: new Array(15).fill(24), weekdayCount: 0 };
  const r = compareCalendarStructures(chronicle, foundry);
  assert.equal(r.match, false);
  assert.match(r.detail, /month count/);
});
