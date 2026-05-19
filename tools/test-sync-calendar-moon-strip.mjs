#!/usr/bin/env node
/**
 * Unit tests for the moon-strip pure module.
 *
 * Fixtures: the three operator calendars under
 * `cordinator/references/calendars/` (Therin, Tyr, Forbidden Lands). We
 * inline a sub-tree per fixture rather than reading the file so the
 * tests are hermetic — Foundry module CI doesn't pull cordinator.
 *
 * The `getPosition` stub mimics Calendaria's `getMoonPhasePosition`:
 * `position = ((dayDelta + referencePhase * cycleLength) % cycleLength) /
 * cycleLength`, where `dayDelta` is days since `moon.referenceDate`.
 * Real Calendaria adds variance for randomized moons; we don't simulate
 * that — we set Therin's Umbra to always return 0.42 (the "Hidden" tail)
 * and assert the pass-through.
 *
 * Run: `node --test tools/test-sync-calendar-moon-strip.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMoonStripData,
  dayFromStripClick,
  findConvergenceDays,
} from '../scripts/sync-calendar-moon-strip.mjs';

// ---------------------------------------------------------------------
// Fixtures (sub-tree of the operator calendars)
// ---------------------------------------------------------------------

const THERIN_MOONS = [
  {
    id: 'lacrimosa',
    name: 'Lacrimosa',
    cycleLength: 24,
    color: '#cfd8e6',
    phaseMode: 'fixed',
    phases: {
      a: { name: 'New',      start: 0,     end: 0.125 },
      b: { name: 'Crescent', start: 0.125, end: 0.25  },
      c: { name: 'Quarter',  start: 0.25,  end: 0.375 },
      d: { name: 'Gibbous',  start: 0.375, end: 0.5   },
      e: { name: 'Full',     start: 0.5,   end: 0.625 },
      f: { name: 'Gibbous',  start: 0.625, end: 0.75  },
      g: { name: 'Quarter',  start: 0.75,  end: 0.875 },
      h: { name: 'Crescent', start: 0.875, end: 1     },
    },
  },
  {
    id: 'sanguinmor',
    name: "Sanguin'mor",
    cycleLength: 24,
    color: '#7a1f1f',
    phaseMode: 'fixed',
    phases: {
      a: { name: 'New',  start: 0,   end: 0.125 },
      e: { name: 'Full', start: 0.5, end: 0.625 },
    },
  },
  {
    id: 'umbra',
    name: 'Umbra',
    cycleLength: 90,
    color: '#3a2a4a',
    phaseMode: 'randomized',
    cycleVariance: 0.7,
    phases: {
      hidden: { name: 'Hidden', start: 0,   end: 0.4 },
      open:   { name: 'Open',   start: 0.7, end: 0.8 },
    },
  },
];

const TYR_MOONS = [
  {
    name: 'Ral',
    cycleLength: 33,
    color: '#228B22',
    phaseMode: 'fixed',
    phases: {
      a: { name: 'New',  start: 0,   end: 0.125 },
      e: { name: 'Full', start: 0.5, end: 0.625 },
    },
  },
  {
    name: 'Guthay',
    cycleLength: 125,
    color: '#DAA520',
    phaseMode: 'fixed',
    phases: {
      a: { name: 'New',  start: 0,   end: 0.125 },
      e: { name: 'Full', start: 0.5, end: 0.625 },
    },
  },
];

const FL_MOON = [{
  name: 'The Moon',
  cycleLength: 30,
  color: '#E8E8E8',
  phaseMode: 'fixed',
  phases: {
    a: { name: 'New',  start: 0,   end: 0.125 },
    e: { name: 'Full', start: 0.5, end: 0.625 },
  },
}];

// ---------------------------------------------------------------------
// Stub generator: deterministic linear advance per moon
// ---------------------------------------------------------------------

/**
 * Returns a `getPosition(idx, date)` that advances each moon linearly
 * around its cycle: day 1 → 0/cycleLength, day 2 → 1/cycleLength, …
 * Therin's Umbra (index 2) is hardcoded to return 0.42 ("Hidden" tail)
 * on every day to stand in for randomized noise.
 */
function makeLinearGetPosition(moons, { umbraIndexFlatlines = null } = {}) {
  return (idx, date) => {
    if (idx === umbraIndexFlatlines) return 0.42;
    const m = moons[idx];
    if (!m) return 0;
    const day0 = (Number(date?.dayOfMonth) || 1) - 1;
    return (day0 % m.cycleLength) / m.cycleLength;
  };
}

// ---------------------------------------------------------------------
// buildMoonStripData — shape
// ---------------------------------------------------------------------

test('builds one row per moon with per-day position arrays', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1,
    monthOrdinal: 1,
    daysInMonth: 24,
    getPosition: makeLinearGetPosition(THERIN_MOONS, { umbraIndexFlatlines: 2 }),
  });
  assert.equal(out.moons.length, 3);
  for (const row of out.moons) {
    assert.equal(row.days.length, 24);
  }
});

test('row carries name, color, cycleLength, isRandomized', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1,
    monthOrdinal: 1,
    daysInMonth: 24,
    getPosition: makeLinearGetPosition(THERIN_MOONS, { umbraIndexFlatlines: 2 }),
  });
  assert.equal(out.moons[0].name, 'Lacrimosa');
  assert.equal(out.moons[0].color, '#cfd8e6');
  assert.equal(out.moons[0].cycleLength, 24);
  assert.equal(out.moons[0].isRandomized, false);

  assert.equal(out.moons[2].name, 'Umbra');
  assert.equal(out.moons[2].isRandomized, true);
});

// ---------------------------------------------------------------------
// buildMoonStripData — per-day correctness
// ---------------------------------------------------------------------

test('Therin Lacrimosa: full moon lands at day 13 (position ≥ 0.5)', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1,
    monthOrdinal: 1,
    daysInMonth: 24,
    getPosition: makeLinearGetPosition(THERIN_MOONS, { umbraIndexFlatlines: 2 }),
  });
  // Day 13 → position (12/24) = 0.5 → "Full" band [0.5, 0.625).
  const lac = out.moons[0];
  const day13 = lac.days.find((d) => d.day === 13);
  assert.ok(day13);
  assert.equal(day13.position, 0.5);
  assert.equal(day13.isFull, true);
  assert.equal(day13.phaseName, 'Full');
});

test('Therin Umbra: randomized moon passes positions through unchanged', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1,
    monthOrdinal: 1,
    daysInMonth: 24,
    getPosition: makeLinearGetPosition(THERIN_MOONS, { umbraIndexFlatlines: 2 }),
  });
  // Stub returns 0.42 on every day for Umbra; we just confirm it landed.
  const umbra = out.moons[2];
  for (const d of umbra.days) {
    assert.equal(d.position, 0.42);
    assert.equal(d.isFull, false);
    assert.equal(d.isNew, false);
    // 0.42 falls between Hidden (end 0.4) and Open (start 0.7) in our
    // sparse fixture — the position has no covering phase, so name is ''.
    assert.equal(d.phaseName, '');
  }
});

test('Therin Umbra: position 0.42 falls outside Hidden(0-0.4) → empty phaseName', () => {
  // Above test asserts 'Hidden' if phaseTable contains that range. Our
  // fixture has Hidden=[0, 0.4]; 0.42 is past Hidden's end. The lookup
  // returns ''. Re-run with a getPosition that gives exactly 0.3 to land
  // squarely in Hidden.
  const flat03 = () => 0.3;
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1, monthOrdinal: 1, daysInMonth: 5,
    getPosition: (idx) => (idx === 2 ? flat03() : 0),
  });
  assert.equal(out.moons[2].days[0].phaseName, 'Hidden');
});

test('Therin Sanguin\'mor: opposed cycle from Lacrimosa via reference-date offset', () => {
  // We swap the linear stub for a "Lacrimosa-leads-by-12" mock that
  // approximates the opposed cycles in the actual data (referenceDate
  // offset 12 days apart for two 24-day moons → opposed).
  const opposedGetPosition = (idx, date) => {
    const dayDelta = (Number(date?.dayOfMonth) || 1) - 1;
    if (idx === 0) return (dayDelta % 24) / 24;
    if (idx === 1) return ((dayDelta + 12) % 24) / 24;
    return 0;
  };
  const out = buildMoonStripData({
    moons: THERIN_MOONS,
    year: 1, monthOrdinal: 1, daysInMonth: 24,
    getPosition: opposedGetPosition,
  });
  // Day 13: Lacrimosa position 12/24=0.5 (full); Sanguin'mor (12+12)%24/24=0 (new).
  const lac13 = out.moons[0].days.find((d) => d.day === 13);
  const san13 = out.moons[1].days.find((d) => d.day === 13);
  assert.equal(lac13.isFull, true);
  assert.equal(san13.isNew, true);
});

// ---------------------------------------------------------------------
// buildMoonStripData — Tyr's long-cycle convergence
// ---------------------------------------------------------------------

test('Tyr: 33-day Ral + 125-day Guthay both render 24 days for a 24-day window', () => {
  const out = buildMoonStripData({
    moons: TYR_MOONS,
    year: 1, monthOrdinal: 1, daysInMonth: 24,
    getPosition: makeLinearGetPosition(TYR_MOONS),
  });
  assert.equal(out.moons.length, 2);
  assert.equal(out.moons[0].days.length, 24);
  assert.equal(out.moons[1].days.length, 24);
  assert.equal(out.moons[0].cycleLength, 33);
  assert.equal(out.moons[1].cycleLength, 125);
});

test('Tyr Guthay: long 125-day cycle yields slow position advance', () => {
  const out = buildMoonStripData({
    moons: TYR_MOONS,
    year: 1, monthOrdinal: 1, daysInMonth: 24,
    getPosition: makeLinearGetPosition(TYR_MOONS),
  });
  // Day 24 → position 23/125 ≈ 0.184 → "Crescent" band.
  const day24 = out.moons[1].days.find((d) => d.day === 24);
  assert.ok(Math.abs(day24.position - 23 / 125) < 1e-9);
  assert.equal(day24.isFull, false);
  assert.equal(day24.isNew, false);
});

// ---------------------------------------------------------------------
// buildMoonStripData — Forbidden Lands single-moon baseline
// ---------------------------------------------------------------------

test('Forbidden Lands: single moon, 30-day strip', () => {
  const out = buildMoonStripData({
    moons: FL_MOON,
    year: 1165, monthOrdinal: 1, daysInMonth: 30,
    getPosition: makeLinearGetPosition(FL_MOON),
  });
  assert.equal(out.moons.length, 1);
  assert.equal(out.moons[0].days.length, 30);
  // Day 16 → 15/30 = 0.5 → full.
  const day16 = out.moons[0].days.find((d) => d.day === 16);
  assert.equal(day16.position, 0.5);
  assert.equal(day16.isFull, true);
});

// ---------------------------------------------------------------------
// buildMoonStripData — defensive shape handling
// ---------------------------------------------------------------------

test('empty moons array returns no rows', () => {
  const out = buildMoonStripData({
    moons: [], year: 1, monthOrdinal: 1, daysInMonth: 30,
    getPosition: () => 0,
  });
  assert.deepEqual(out, { moons: [] });
});

test('non-finite daysInMonth returns no rows', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS, year: 1, monthOrdinal: 1, daysInMonth: 0,
    getPosition: () => 0,
  });
  assert.deepEqual(out, { moons: [] });
});

test('missing getPosition returns no rows', () => {
  const out = buildMoonStripData({
    moons: THERIN_MOONS, year: 1, monthOrdinal: 1, daysInMonth: 30,
  });
  assert.deepEqual(out, { moons: [] });
});

test('getPosition that throws clamps the day to position 0', () => {
  const out = buildMoonStripData({
    moons: FL_MOON, year: 1, monthOrdinal: 1, daysInMonth: 3,
    getPosition: () => { throw new Error('boom'); },
  });
  assert.equal(out.moons[0].days[0].position, 0);
  assert.equal(out.moons[0].days[0].isNew, true);
});

test('getPosition returning out-of-range value clamps to [0,1]', () => {
  const out = buildMoonStripData({
    moons: FL_MOON, year: 1, monthOrdinal: 1, daysInMonth: 3,
    getPosition: (_idx, date) => (date.dayOfMonth === 1 ? -0.5 : 2.0),
  });
  assert.equal(out.moons[0].days[0].position, 0);
  assert.equal(out.moons[0].days[1].position, 1);
});

test('non-finite getPosition return value coerces to 0', () => {
  const out = buildMoonStripData({
    moons: FL_MOON, year: 1, monthOrdinal: 1, daysInMonth: 1,
    getPosition: () => NaN,
  });
  assert.equal(out.moons[0].days[0].position, 0);
});

// ---------------------------------------------------------------------
// dayFromStripClick
// ---------------------------------------------------------------------

test('dayFromStripClick: click at 50% width of 24-day strip → day 13', () => {
  assert.equal(dayFromStripClick(120, 240, 24), 13);
});

test('dayFromStripClick: click at 0 → day 1', () => {
  assert.equal(dayFromStripClick(0, 240, 24), 1);
});

test('dayFromStripClick: click past the right edge clamps to daysInMonth', () => {
  assert.equal(dayFromStripClick(9999, 240, 24), 24);
});

test('dayFromStripClick: negative click clamps to day 1', () => {
  assert.equal(dayFromStripClick(-50, 240, 24), 1);
});

test('dayFromStripClick: zero width strip safely returns day 1', () => {
  assert.equal(dayFromStripClick(50, 0, 24), 1);
});

test('dayFromStripClick: NaN daysInMonth returns day 1', () => {
  assert.equal(dayFromStripClick(50, 240, NaN), 1);
});

// ---------------------------------------------------------------------
// findConvergenceDays
// ---------------------------------------------------------------------

test('findConvergenceDays: Therin opposed Lacrimosa+Sanguin\'mor do not converge', () => {
  const opposedGetPosition = (idx, date) => {
    const dayDelta = (Number(date?.dayOfMonth) || 1) - 1;
    if (idx === 0) return (dayDelta % 24) / 24;
    if (idx === 1) return ((dayDelta + 12) % 24) / 24;
    return 0; // Umbra; we'll mark it randomized so it shouldn't count
  };
  const out = buildMoonStripData({
    moons: THERIN_MOONS, year: 1, monthOrdinal: 1, daysInMonth: 24,
    getPosition: opposedGetPosition,
  });
  // No day where both Lacrimosa and Sanguin'mor are full (opposed phases).
  const cvgs = findConvergenceDays(out);
  assert.deepEqual(cvgs, []);
});

test('findConvergenceDays: Tyr — 33 + 125 cycles, find days both full in 200-day window', () => {
  // Build a 200-day window so the Guthay full band (positions 0.5-0.625
  // ≈ days 63-78) overlaps with at least one Ral full window.
  const out = buildMoonStripData({
    moons: TYR_MOONS, year: 1, monthOrdinal: 1, daysInMonth: 200,
    getPosition: makeLinearGetPosition(TYR_MOONS),
  });
  const cvgs = findConvergenceDays(out);
  // Linear stub positions: pos = ((d-1) % cycleLength) / cycleLength.
  // Ral (cycle 33) full when position in [0.48, 0.65]:
  //   (d-1) % 33 in {17,18,19,20,21} → days 18-22, 51-55, 84-88, 117-121,
  //   150-154, 183-187.
  // Guthay (cycle 125) full when position in [0.48, 0.65]:
  //   (d-1) % 125 in {60..81} → days 61-82, 186-207 (within 200-day window).
  // Overlap in [1..200]: days 186, 187.
  assert.deepEqual(cvgs, [186, 187]);
});

test('findConvergenceDays: with forced overlap, returns the day', () => {
  // Build a tiny scenario where both moons are full on day 5 only.
  const moons = [
    { name: 'A', color: '#fff', cycleLength: 10, phaseMode: 'fixed', phases: { e: { name: 'Full', start: 0.5, end: 0.625 } } },
    { name: 'B', color: '#000', cycleLength: 10, phaseMode: 'fixed', phases: { e: { name: 'Full', start: 0.5, end: 0.625 } } },
  ];
  const out = buildMoonStripData({
    moons, year: 1, monthOrdinal: 1, daysInMonth: 10,
    getPosition: (_idx, date) => (date.dayOfMonth === 5 ? 0.55 : 0.1),
  });
  assert.deepEqual(findConvergenceDays(out), [5]);
});

test('findConvergenceDays: randomized moons are excluded from convergence detection', () => {
  // Two moons both full every day, but one marked randomized.
  const moons = [
    { name: 'A', color: '#fff', cycleLength: 10, phaseMode: 'fixed',      phases: {} },
    { name: 'B', color: '#000', cycleLength: 10, phaseMode: 'randomized', phases: {} },
  ];
  const out = buildMoonStripData({
    moons, year: 1, monthOrdinal: 1, daysInMonth: 5,
    getPosition: () => 0.55,
  });
  // Only one deterministic moon → no convergence detection (need ≥2).
  assert.deepEqual(findConvergenceDays(out), []);
});

test('findConvergenceDays: fewer than 2 moons → empty', () => {
  const out = buildMoonStripData({
    moons: FL_MOON, year: 1, monthOrdinal: 1, daysInMonth: 30,
    getPosition: () => 0.55,
  });
  assert.deepEqual(findConvergenceDays(out), []);
});

test('findConvergenceDays: null input → empty', () => {
  assert.deepEqual(findConvergenceDays(null), []);
  assert.deepEqual(findConvergenceDays(undefined), []);
  assert.deepEqual(findConvergenceDays({ moons: null }), []);
});
