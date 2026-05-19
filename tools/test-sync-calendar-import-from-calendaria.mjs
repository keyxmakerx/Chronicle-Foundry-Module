#!/usr/bin/env node
/**
 * Unit tests for the Calendaria → Chronicle calendar-import transform.
 *
 * Fixtures: the three operator calendars under
 * `cordinator/references/calendars/`. We load them at runtime from
 * a path that's set via the `CHRONICLE_FIXTURE_DIR` env var, falling
 * back to a relative `../../Cordinator/references/calendars/` for the
 * agent environment. If the fixtures aren't reachable, the tests skip
 * the fixture suite with a clear console warning — they don't fail CI
 * for an environmental issue.
 *
 * Run: `node --test tools/test-sync-calendar-import-from-calendaria.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  transformCalendariaCalendar,
  buildCalendarPreflightSummary,
  IMPORT_WIRE_VERSION,
} from '../scripts/sync-calendar-import-from-calendaria.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixtureDir() {
  if (process.env.CHRONICLE_FIXTURE_DIR) return process.env.CHRONICLE_FIXTURE_DIR;
  return resolve(__dirname, '..', '..', 'Cordinator', 'references', 'calendars');
}

function loadFixture(name) {
  const path = join(fixtureDir(), name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const THERIN = loadFixture('calendar-of-therin.json');
const TYR    = loadFixture('athasian-tyr.json');
const FL     = loadFixture('forbidden-lands.json');

// ---------------------------------------------------------------------
// Wire version pin
// ---------------------------------------------------------------------

test('IMPORT_WIRE_VERSION is 1 (matches the Chronicle decision doc)', () => {
  assert.equal(IMPORT_WIRE_VERSION, 1);
});

// ---------------------------------------------------------------------
// Defensive shape handling (always runs)
// ---------------------------------------------------------------------

test('throws on null / non-object input', () => {
  assert.throws(() => transformCalendariaCalendar(null),      /not a Calendaria calendar/);
  assert.throws(() => transformCalendariaCalendar(undefined), /not a Calendaria calendar/);
  assert.throws(() => transformCalendariaCalendar('string'),  /not a Calendaria calendar/);
});

test('empty calendar produces empty arrays + sane defaults', () => {
  const { payload, summary } = transformCalendariaCalendar({});
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.source, 'calendaria');
  assert.equal(payload.name, 'Imported Calendar');
  assert.deepEqual(payload.months,   []);
  assert.deepEqual(payload.weekdays, []);
  assert.deepEqual(payload.seasons,  []);
  assert.deepEqual(payload.moons,    []);
  assert.deepEqual(payload.eras,     []);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(summary.mappedCounts, { months: 0, weekdays: 0, seasons: 0, moons: 0, eras: 0 });
});

test('reads `years.yearZero` and `years.allowNegativeYears`', () => {
  const { payload } = transformCalendariaCalendar({
    name: 'X',
    years: { yearZero: 1165, allowNegativeYears: false },
    currentDate: { year: 1165, month: 0, dayOfMonth: 0 },
  });
  assert.equal(payload.year_zero, 1165);
  assert.equal(payload.allow_negative_years, false);
  assert.equal(payload.current_year, 1165);
  // Wire emits 1-indexed month + day; Calendaria stores 0-indexed.
  assert.equal(payload.current_month, 1);
  assert.equal(payload.current_day, 1);
});

test('current date defaults sensibly when calendar has no currentDate block', () => {
  const { payload } = transformCalendariaCalendar({
    name: 'X',
    years: { yearZero: 42 },
  });
  assert.equal(payload.current_year, 42);
  assert.equal(payload.current_month, 1);
  assert.equal(payload.current_day, 1);
  assert.equal(payload.current_hour, 0);
});

// ---------------------------------------------------------------------
// Therin fixture (the design probe — randomized Umbra is the key)
// ---------------------------------------------------------------------

test('Therin: identifies + names correctly', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.source, 'calendaria');
  assert.equal(payload.source_id, 'custom-calendar-of-therin');
  assert.equal(payload.name, 'Calendar of Therin');
  assert.ok(payload.description.length > 0);
});

test('Therin: 15 months × 24 days = 360-day year', { skip: !THERIN }, () => {
  const { payload, summary } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.months.length, 15);
  for (const m of payload.months) {
    assert.equal(m.days, 24);
  }
  assert.equal(summary.mappedCounts.months, 15);
});

test('Therin: months sorted by ordinal (Greenfirst first)', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.months[0].name, 'Greenfirst');
  assert.equal(payload.months[0].ordinal, 1);
  assert.equal(payload.months[14].ordinal, 15);
});

test('Therin: 6 weekdays, last 2 are rest days', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.weekdays.length, 6);
  // Hallowday + Hushday (ordinals 5 + 6) are flagged isRestDay.
  const rest = payload.weekdays.filter((d) => d.rest_day);
  assert.equal(rest.length, 2);
  assert.ok(rest.some((d) => d.name === 'Hallowday'));
  assert.ok(rest.some((d) => d.name === 'Hushday'));
});

test('Therin: 5 seasons (Sprouting first)', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.seasons.length, 5);
  const sprouting = payload.seasons.find((s) => s.name === 'Sprouting');
  assert.ok(sprouting);
  assert.equal(sprouting.month_start, 1);
  assert.equal(sprouting.month_end, 3);
});

test('Therin: 3 moons; randomized Umbra survives the transform', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.moons.length, 3);
  const umbra = payload.moons.find((m) => m.name === 'Umbra');
  assert.ok(umbra, 'Umbra must round-trip');
  // The whole point of the design probe: randomized phase_mode passes
  // through, and so does the cycle_variance — Chronicle needs both to
  // re-emit a faithful copy back into Calendaria later.
  assert.equal(umbra.phase_mode, 'randomized');
  assert.equal(umbra.cycle_variance, 0.7);
  assert.equal(umbra.cycle_length, 90);
  // Phase table preserved (6 phases for Umbra).
  assert.ok(Array.isArray(umbra.phases));
  assert.equal(umbra.phases.length, 6);
  assert.ok(umbra.phases.find((p) => p.name === 'Hidden'));
});

test('Therin: Lacrimosa + Sanguin\'mor are fixed-mode 24-day moons', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  const lac = payload.moons.find((m) => m.name === 'Lacrimosa');
  const san = payload.moons.find((m) => m.name === "Sanguin'mor");
  assert.ok(lac && san);
  assert.equal(lac.cycle_length, 24);
  assert.equal(san.cycle_length, 24);
  assert.equal(lac.phase_mode, 'fixed');
  assert.equal(san.phase_mode, 'fixed');
  // Reference dates are 1-indexed on the wire — Calendaria stores
  // 0-indexed dayOfMonth. Lacrimosa is at month 1 day 11 → wire emits
  // month 2 day 12.
  assert.deepEqual(lac.reference_date, { year: 0, month: 2, day: 12 });
});

test('Therin: 1 era ("Third Age")', { skip: !THERIN }, () => {
  const { payload } = transformCalendariaCalendar(THERIN);
  assert.equal(payload.eras.length, 1);
  assert.equal(payload.eras[0].name, 'Third Age');
  assert.equal(payload.eras[0].abbreviation, '3A');
  assert.equal(payload.eras[0].start_year, 1);
});

test('Therin: no cycles/festivals/weather → empty skipped list', { skip: !THERIN }, () => {
  const { summary } = transformCalendariaCalendar(THERIN);
  assert.deepEqual(summary.skipped, []);
});

// ---------------------------------------------------------------------
// Tyr fixture (long-cycle convergence + cycles + festivals skipped)
// ---------------------------------------------------------------------

test('Tyr: 15 months + 15 weekdays', { skip: !TYR }, () => {
  const { payload } = transformCalendariaCalendar(TYR);
  assert.equal(payload.months.length, 15);
  assert.equal(payload.weekdays.length, 15);
});

test('Tyr: 2 moons — Ral (33-day) + Guthay (125-day)', { skip: !TYR }, () => {
  const { payload } = transformCalendariaCalendar(TYR);
  assert.equal(payload.moons.length, 2);
  const ral    = payload.moons.find((m) => m.name === 'Ral');
  const guthay = payload.moons.find((m) => m.name === 'Guthay');
  assert.ok(ral && guthay);
  assert.equal(ral.cycle_length, 33);
  assert.equal(guthay.cycle_length, 125);
});

test('Tyr: cycles + festivals are skipped (LOSSY)', { skip: !TYR }, () => {
  const { payload, summary } = transformCalendariaCalendar(TYR);
  // The transform does NOT add cycles or festivals to the payload.
  assert.equal(payload.cycles, undefined);
  assert.equal(payload.festivals, undefined);
  // And the summary tells the operator what was lost.
  assert.ok(summary.skipped.some((s) => s.startsWith('cycles')));
  assert.ok(summary.skipped.some((s) => s.startsWith('festivals')));
});

// ---------------------------------------------------------------------
// Forbidden Lands fixture (single-moon baseline + festivals skipped)
// ---------------------------------------------------------------------

test('Forbidden Lands: 8 months + 7 weekdays + 1 moon', { skip: !FL }, () => {
  const { payload } = transformCalendariaCalendar(FL);
  assert.equal(payload.months.length, 8);
  assert.equal(payload.weekdays.length, 7);
  assert.equal(payload.moons.length, 1);
  assert.equal(payload.moons[0].cycle_length, 30);
});

test('Forbidden Lands: yearZero 1165 passes through correctly', { skip: !FL }, () => {
  const { payload } = transformCalendariaCalendar(FL);
  assert.equal(payload.year_zero, 1165);
});

test('Forbidden Lands: festivals (8) are skipped, surfaced in summary', { skip: !FL }, () => {
  const { payload, summary } = transformCalendariaCalendar(FL);
  assert.equal(payload.festivals, undefined);
  const festLine = summary.skipped.find((s) => s.startsWith('festivals'));
  assert.ok(festLine, 'festivals skip line must appear');
  assert.equal(festLine, 'festivals (8)');
});

// ---------------------------------------------------------------------
// buildCalendarPreflightSummary — used by the import button row
// ---------------------------------------------------------------------

test('preflight: Therin shows 360 daysPerYear + 3 moons + no skips', { skip: !THERIN }, () => {
  const s = buildCalendarPreflightSummary(THERIN);
  assert.equal(s.id, 'custom-calendar-of-therin');
  assert.equal(s.name, 'Calendar of Therin');
  assert.equal(s.daysPerYear, 360);
  assert.equal(s.monthCount, 15);
  assert.equal(s.weekdayCount, 6);
  assert.equal(s.moonCount, 3);
  assert.equal(s.skipNotice, ''); // No cycles/festivals/weather to skip.
});

test('preflight: Tyr surfaces skip notice for cycles + festivals', { skip: !TYR }, () => {
  const s = buildCalendarPreflightSummary(TYR);
  assert.ok(s.skipNotice.startsWith('Skips: '));
  assert.ok(s.skipNotice.includes('cycles'));
  assert.ok(s.skipNotice.includes('festivals'));
});

test('preflight: empty input returns sane zeros, no skipNotice', () => {
  const s = buildCalendarPreflightSummary(null);
  assert.deepEqual(s, {
    id: '', name: '', daysPerYear: 0, monthCount: 0, weekdayCount: 0, moonCount: 0, skipNotice: '',
  });
});

// ---------------------------------------------------------------------
// Round-trip stability check — the same Calendaria input always
// produces the same Chronicle payload (purity).
// ---------------------------------------------------------------------

test('round-trip stability: same input → same output (no mutable state)', { skip: !THERIN }, () => {
  const a = transformCalendariaCalendar(THERIN);
  const b = transformCalendariaCalendar(THERIN);
  assert.deepEqual(a, b);
});
