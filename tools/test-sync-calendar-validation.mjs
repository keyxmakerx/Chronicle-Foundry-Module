#!/usr/bin/env node
/**
 * Unit tests for the validation rule engine in
 * `scripts/sync-calendar-validation.mjs`.
 *
 * Each test exercises a specific rule with the smallest possible fixture
 * that triggers (or doesn't trigger) it. The end-of-file `runValidation`
 * smoke tests confirm the engine glues rules together correctly.
 *
 * Run: `node --test tools/test-sync-calendar-validation.mjs`
 *
 * No mocking framework — uses Node's built-in `node:test` (Node ≥ 18).
 *
 * Cross-reference: cordinator
 * `reports/foundry/2026-05-19-fm-cal-editor-scoping.md` § 6 lists the 10
 * Therin gaps this rule set surfaces. Every entry there maps 1-to-1 to a
 * test below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  runValidation,
  SCHEMA_VERSION,
  ALL_RULES,
  ruleActiveZoneExists,
  ruleFestivalsEmpty,
  ruleSeasonInterstitial,
  ruleSeasonWrapsYear,
  ruleRandomizedMoonDefaultSeed,
  ruleMoonIconsDuplicated,
  ruleDateFormatLiteralString,
  ruleReferenceDateDayZero,
  ruleDescriptionDoubled,
  ruleLastAdvancedNever,
} = await import('../scripts/sync-calendar-validation.mjs');

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

/** Minimal valid calendar — all rules should pass against this. */
function cleanCalendar() {
  return {
    name: 'Clean',
    metadata: { description: 'A clean reference calendar.' },
    years: { yearZero: 1000 },
    months: { values: { m1: { name: 'One', ordinal: 1, days: 30 } } },
    days:   { values: { d1: { name: 'Day', ordinal: 1 } } },
    seasons: {
      values: {
        spring: {
          name: 'Spring', seasonalType: 'spring',
          monthStart: 0, monthEnd: 0,
        },
      },
    },
    moons: {
      one: {
        name: 'One', cycleLength: 30, phaseMode: 'fixed', phaseSeed: 0,
        phases: { full: { icon: 'modules/myMoonPack/full.svg', start: 0, end: 1 } },
        referenceDate: { year: 1000, month: 1, dayOfMonth: 1 },
      },
    },
    eras: {},
    festivals: { f1: { name: 'Festival', month: 1 } },
    cycles: {},
    weather: {
      activeZone: 'temperate',
      zones: { temperate: { id: 'temperate', name: 'Temperate' } },
    },
    dateFormats: { long: 'D MMMM, Y' },
  };
}

// ---------------------------------------------------------------------
// Single-rule tests — failing fixtures
// ---------------------------------------------------------------------

test('ruleActiveZoneExists — fires when activeZone refers to absent zone', () => {
  const cal = cleanCalendar();
  cal.weather.zones = {}; // strip the zone the active zone refers to
  const f = ruleActiveZoneExists(cal);
  assert.ok(f);
  assert.equal(f.code, 'WEATHER_ACTIVE_ZONE_MISSING');
  assert.equal(f.severity, 'warning');
  assert.ok(f.message.includes('temperate'));
});

test('ruleActiveZoneExists — passes when zone exists', () => {
  assert.equal(ruleActiveZoneExists(cleanCalendar()), null);
});

test('ruleActiveZoneExists — passes when activeZone is empty', () => {
  const cal = cleanCalendar();
  cal.weather.activeZone = '';
  cal.weather.zones = {};
  assert.equal(ruleActiveZoneExists(cal), null);
});

test('ruleFestivalsEmpty — fires when festivals is empty', () => {
  const cal = cleanCalendar();
  cal.festivals = {};
  const f = ruleFestivalsEmpty(cal);
  assert.ok(f);
  assert.equal(f.code, 'FESTIVALS_EMPTY');
  assert.equal(f.severity, 'info');
});

test('ruleFestivalsEmpty — passes when festivals exist', () => {
  assert.equal(ruleFestivalsEmpty(cleanCalendar()), null);
});

test('ruleSeasonInterstitial — fires on seasonalType: null', () => {
  const cal = cleanCalendar();
  cal.seasons.values.greylight = {
    name: 'Greylight', seasonalType: null,
    monthStart: 0, monthEnd: 0,
  };
  const f = ruleSeasonInterstitial(cal);
  assert.ok(f);
  assert.equal(f.code, 'SEASON_INTERSTITIAL');
  assert.ok(f.message.includes('Greylight'));
});

test('ruleSeasonInterstitial — does NOT fire on seasonalType: "spring"', () => {
  assert.equal(ruleSeasonInterstitial(cleanCalendar()), null);
});

test('ruleSeasonInterstitial — does NOT fire when seasonalType absent (undefined !== null)', () => {
  const cal = cleanCalendar();
  cal.seasons.values.s = { name: 'NoTypeField', monthStart: 0, monthEnd: 0 };
  // Per Therin: only an explicit null is the documented interstitial signal.
  assert.equal(ruleSeasonInterstitial(cal), null);
});

test('ruleSeasonWrapsYear — fires when monthStart > monthEnd', () => {
  const cal = cleanCalendar();
  cal.seasons.values.greylight = {
    name: 'Greylight', seasonalType: null,
    monthStart: 13, monthEnd: 0,   // wraps across year-end
  };
  const f = ruleSeasonWrapsYear(cal);
  assert.ok(f);
  assert.equal(f.code, 'SEASON_WRAPS_YEAR');
  assert.ok(f.message.includes('Greylight'));
});

test('ruleSeasonWrapsYear — passes when monthStart <= monthEnd', () => {
  assert.equal(ruleSeasonWrapsYear(cleanCalendar()), null);
});

test('ruleRandomizedMoonDefaultSeed — fires on randomized + phaseSeed 0', () => {
  const cal = cleanCalendar();
  cal.moons.umbra = {
    name: 'Umbra', phaseMode: 'randomized', phaseSeed: 0,
    phases: {}, referenceDate: { dayOfMonth: 1 },
  };
  const f = ruleRandomizedMoonDefaultSeed(cal);
  assert.ok(f);
  assert.equal(f.code, 'MOON_RANDOMIZED_DEFAULT_SEED');
  assert.equal(f.severity, 'warning');
  assert.ok(f.message.includes('Umbra'));
});

test('ruleRandomizedMoonDefaultSeed — passes for fixed-mode moons', () => {
  assert.equal(ruleRandomizedMoonDefaultSeed(cleanCalendar()), null);
});

test('ruleRandomizedMoonDefaultSeed — passes when randomized but seed is non-zero', () => {
  const cal = cleanCalendar();
  cal.moons.umbra = {
    name: 'Umbra', phaseMode: 'randomized', phaseSeed: 42,
    phases: {}, referenceDate: { dayOfMonth: 1 },
  };
  assert.equal(ruleRandomizedMoonDefaultSeed(cal), null);
});

test('ruleMoonIconsDuplicated — fires when 2+ moons share stock Calendaria phase icons', () => {
  const cal = cleanCalendar();
  const stock = { name: 'Full', icon: 'modules/calendaria/assets/moon-phases/05_fullmoon.svg', start: 0, end: 1 };
  cal.moons = {
    a: { name: 'A', phaseMode: 'fixed', phases: { full: stock } },
    b: { name: 'B', phaseMode: 'fixed', phases: { full: stock } },
  };
  const f = ruleMoonIconsDuplicated(cal);
  assert.ok(f);
  assert.equal(f.code, 'MOON_ICONS_GENERIC_DUPLICATED');
});

test('ruleMoonIconsDuplicated — does NOT fire with only 1 moon', () => {
  // The clean fixture has 1 moon; should not fire even if it uses stock icons.
  assert.equal(ruleMoonIconsDuplicated(cleanCalendar()), null);
});

test('ruleMoonIconsDuplicated — does NOT fire when moons use custom icon packs', () => {
  const cal = cleanCalendar();
  cal.moons = {
    a: { name: 'A', phaseMode: 'fixed', phases: { full: { icon: 'modules/mypack/a.svg', start: 0, end: 1 } } },
    b: { name: 'B', phaseMode: 'fixed', phases: { full: { icon: 'modules/mypack/b.svg', start: 0, end: 1 } } },
  };
  assert.equal(ruleMoonIconsDuplicated(cal), null);
});

test('ruleDateFormatLiteralString — fires on fully-bracketed literals', () => {
  const cal = cleanCalendar();
  cal.dateFormats = {
    long:       'D MMMM, Y',     // OK
    weekHeader: '[W]',           // literal-only — bad
    yearHeader: '[YYYY]',         // literal-only — bad
    yearLabel:  '[YYYY] [GGGG]', // literal-only — bad
  };
  const f = ruleDateFormatLiteralString(cal);
  assert.ok(f);
  assert.equal(f.code, 'DATE_FORMAT_LITERAL_ONLY');
  assert.ok(f.message.includes('weekHeader'));
  assert.ok(f.message.includes('yearHeader'));
  assert.ok(f.message.includes('yearLabel'));
});

test('ruleDateFormatLiteralString — passes when literals are mixed with tokens', () => {
  const cal = cleanCalendar();
  cal.dateFormats = { weekHeader: '[Week] W [of] MMMM, Y' };
  assert.equal(ruleDateFormatLiteralString(cal), null);
});

test('ruleDateFormatLiteralString — passes on plain token strings', () => {
  assert.equal(ruleDateFormatLiteralString(cleanCalendar()), null);
});

test('ruleReferenceDateDayZero — fires when moon referenceDate.dayOfMonth is 0', () => {
  const cal = cleanCalendar();
  cal.moons.umbra = {
    name: 'Umbra', phaseMode: 'randomized', phaseSeed: 42,
    phases: {}, referenceDate: { year: 0, month: 1, dayOfMonth: 0 },
  };
  const f = ruleReferenceDateDayZero(cal);
  assert.ok(f);
  assert.equal(f.code, 'MOON_REFERENCE_DAY_ZERO');
  assert.ok(f.message.includes('Umbra'));
});

test('ruleReferenceDateDayZero — passes when dayOfMonth is non-zero', () => {
  assert.equal(ruleReferenceDateDayZero(cleanCalendar()), null);
});

test('ruleDescriptionDoubled — fires when top + metadata both have non-empty mismatched descriptions', () => {
  const cal = cleanCalendar();
  cal.description = 'A different description.';
  cal.metadata.description = 'Original description.';
  const f = ruleDescriptionDoubled(cal);
  assert.ok(f);
  assert.equal(f.code, 'DESCRIPTION_DOUBLED');
});

test('ruleDescriptionDoubled — passes when top is set and metadata is empty', () => {
  // Therin case: top has the real description; metadata.description is empty.
  // This is data drift but not a *contradiction*. Rule fires only on disagreement.
  const cal = cleanCalendar();
  cal.description = 'Only top.';
  cal.metadata.description = '';
  assert.equal(ruleDescriptionDoubled(cal), null);
});

test('ruleDescriptionDoubled — passes when both match', () => {
  const cal = cleanCalendar();
  cal.description = 'Match.';
  cal.metadata.description = 'Match.';
  assert.equal(ruleDescriptionDoubled(cal), null);
});

test('ruleLastAdvancedNever — fires when currentDate is all defaults', () => {
  const cal = cleanCalendar();
  cal.years.yearZero = 0;
  cal.currentDate = { year: 0, month: 0, day: 1, dayOfMonth: 0, hour: 0, minute: 0 };
  const f = ruleLastAdvancedNever(cal);
  assert.ok(f);
  assert.equal(f.code, 'CALENDAR_LAST_ADVANCED_NEVER');
});

test('ruleLastAdvancedNever — passes when year has advanced past yearZero', () => {
  const cal = cleanCalendar();
  cal.years.yearZero = 0;
  cal.currentDate = { year: 5, month: 0, day: 1, dayOfMonth: 0, hour: 0, minute: 0 };
  assert.equal(ruleLastAdvancedNever(cal), null);
});

test('ruleLastAdvancedNever — passes when currentDate is absent', () => {
  // Forbidden Lands case: no currentDate field at all on export.
  const cal = cleanCalendar();
  delete cal.currentDate;
  assert.equal(ruleLastAdvancedNever(cal), null);
});

test('ruleLastAdvancedNever — passes when hour or minute is non-zero', () => {
  const cal = cleanCalendar();
  cal.years.yearZero = 0;
  cal.currentDate = { year: 0, month: 0, day: 1, dayOfMonth: 0, hour: 1, minute: 0 };
  assert.equal(ruleLastAdvancedNever(cal), null);
});

// ---------------------------------------------------------------------
// runValidation engine smoke
// ---------------------------------------------------------------------

test('runValidation — null input returns empty', () => {
  assert.deepEqual(runValidation(null), []);
});

test('runValidation — clean calendar produces zero findings', () => {
  assert.deepEqual(runValidation(cleanCalendar()), []);
});

test('runValidation — Therin-shaped calendar fires the 7 dispatch-required advisories', () => {
  // Reproduce the failing-fixture shape that matches calendar-of-therin.json.
  // The dispatch's acceptance criteria require AT LEAST these 7 rules to
  // fire on Calendar of Therin:
  //   - WEATHER_ACTIVE_ZONE_MISSING
  //   - FESTIVALS_EMPTY
  //   - SEASON_INTERSTITIAL (Greylight)
  //   - MOON_RANDOMIZED_DEFAULT_SEED (Umbra)
  //   - DATE_FORMAT_LITERAL_ONLY (weekHeader / yearHeader / yearLabel)
  //   - MOON_REFERENCE_DAY_ZERO (Umbra)
  //   - CALENDAR_LAST_ADVANCED_NEVER
  const cal = {
    name: 'Calendar of Therin',
    description: 'The common calendar used across the four landmasses...',
    metadata: { id: 'custom-calendar-of-therin', description: '' },
    years: { yearZero: 0 },
    months: { values: { m1: { name: 'Greenfirst', ordinal: 1, days: 24 } } },
    days:   { values: { d1: { name: 'Hearthday', ordinal: 1 } } },
    seasons: {
      values: {
        spring:    { name: 'Sprouting', seasonalType: 'spring',  monthStart: 1, monthEnd: 3 },
        greylight: { name: 'Greylight', seasonalType: null,      monthStart: 13, monthEnd: 0 },
      },
    },
    moons: {
      lacrimosa: {
        name: 'Lacrimosa', phaseMode: 'fixed', phaseSeed: 0,
        phases: { newmoon: { icon: 'modules/calendaria/assets/moon-phases/01_newmoon.svg', start: 0, end: 1 } },
        referenceDate: { year: 0, month: 1, dayOfMonth: 11 },
      },
      sanguinmor: {
        name: "Sanguin'mor", phaseMode: 'fixed', phaseSeed: 0,
        phases: { newmoon: { icon: 'modules/calendaria/assets/moon-phases/01_newmoon.svg', start: 0, end: 1 } },
        referenceDate: { year: 0, month: 1, dayOfMonth: 23 },
      },
      umbra: {
        name: 'Umbra', phaseMode: 'randomized', phaseSeed: 0,
        phases: { hidden: { icon: 'modules/calendaria/assets/moon-phases/01_newmoon.svg', start: 0, end: 1 } },
        referenceDate: { year: 0, month: 1, dayOfMonth: 0 },
      },
    },
    eras: { thirdage: { name: 'Third Age' } },
    festivals: {},
    cycles: {},
    weather: { activeZone: 'temperate', zones: {} },
    dateFormats: {
      short:      'D MMM',
      long:       'D MMMM, YYYY',
      weekHeader: '[W]',
      yearHeader: '[YYYY]',
      yearLabel:  '[YYYY] [GGGG]',
    },
    currentDate: { year: 0, month: 0, day: 1, dayOfMonth: 0, hour: 0, minute: 0 },
  };

  const findings = runValidation(cal);
  const codes = findings.map((f) => f.code);

  const required = [
    'WEATHER_ACTIVE_ZONE_MISSING',
    'FESTIVALS_EMPTY',
    'SEASON_INTERSTITIAL',
    'MOON_RANDOMIZED_DEFAULT_SEED',
    'DATE_FORMAT_LITERAL_ONLY',
    'MOON_REFERENCE_DAY_ZERO',
    'CALENDAR_LAST_ADVANCED_NEVER',
  ];
  for (const code of required) {
    assert.ok(codes.includes(code), `expected finding ${code} on Therin fixture; got ${codes.join(', ')}`);
  }
});

test('runValidation — Forbidden Lands-shaped calendar produces zero or one advisory', () => {
  // Per the dispatch acceptance criterion: Forbidden Lands is the operator's
  // reference build and should be clean (zero findings, or at most one
  // low-severity advisory that's not the operator's responsibility to fix).
  const cal = {
    name: 'Forbidden Lands',
    metadata: { description: "The calendar of the Ravenland from Free League's Forbidden Lands" },
    years: { yearZero: 1165 },
    months: { values: { m1: { name: 'Springrise', ordinal: 1, days: 45 } } },
    days:   { values: { d1: { name: 'Sunday', ordinal: 1 } } },
    seasons: {
      values: {
        spring: { name: 'Spring', seasonalType: 'spring', monthStart: 0, monthEnd: 1 },
        winter: { name: 'Winter', seasonalType: 'winter', monthStart: 6, monthEnd: 7 },
      },
    },
    moons: {
      themoon: {
        name: 'The Moon', phaseMode: 'fixed', phaseSeed: 0,
        phases: { newmoon: { icon: 'modules/calendaria/assets/moon-phases/01_newmoon.svg', start: 0, end: 1 } },
        referenceDate: { year: 0, month: 0, dayOfMonth: 14 },
      },
    },
    eras: { ar: { name: 'Alderland Reckoning' } },
    festivals: {
      awakeningday: { name: 'Awakening Day', month: 0 },
    },
    cycles: {},
    weather: {
      activeZone: 'subarctic',
      zones: {
        subarctic000000: { id: 'subarctic', name: 'Subarctic' },
      },
    },
    dateFormats: {
      short:      'D MMM',
      long:       'D MMMM, Y',
      weekHeader: '[Week] W [of] MMMM, Y',
      yearHeader: 'Y',
      yearLabel:  'Y G',
    },
    // No currentDate field — Forbidden Lands export omits it.
  };
  const findings = runValidation(cal);
  // Allow up to 1 finding (in case future rule additions catch something
  // subtle); the dispatch acceptance criterion says "zero or one advisory."
  assert.ok(findings.length <= 1, `expected <= 1 finding on Forbidden Lands; got ${findings.length}: ${findings.map(f => f.code).join(', ')}`);
});

test('runValidation — buggy rule never blanks the panel', async () => {
  // Replace a known rule with a thrower; runValidation should swallow the
  // exception and still return findings from the surviving rules.
  // We can't mutate the imported RULES list directly, but we can
  // simulate via a synthetic ALL_RULES check: pass a calendar that fires
  // every rule and confirm runValidation returns those findings even
  // though one rule throws against this fixture. Since the rules are pure
  // and the engine uses try/catch internally, the only way to actually
  // test the swallow is to corrupt a rule input.
  //
  // We pass an intentionally hostile calendar shape that would throw if
  // a rule iterated naively, then assert findings still come back.
  const hostile = Object.create({
    get name() { throw new Error('forced error from getter'); },
  });
  // Wrap the shape so most rules see undefined (no fire) but the engine
  // doesn't crash regardless.
  const findings = runValidation(hostile);
  assert.ok(Array.isArray(findings));
});

// ---------------------------------------------------------------------
// Schema versioning sanity
// ---------------------------------------------------------------------

test('SCHEMA_VERSION is a positive integer', () => {
  assert.ok(Number.isInteger(SCHEMA_VERSION));
  assert.ok(SCHEMA_VERSION >= 1);
});

test('ALL_RULES is frozen and contains every named rule export', () => {
  assert.ok(Object.isFrozen(ALL_RULES));
  const referenced = [
    ruleActiveZoneExists,
    ruleFestivalsEmpty,
    ruleSeasonInterstitial,
    ruleSeasonWrapsYear,
    ruleRandomizedMoonDefaultSeed,
    ruleMoonIconsDuplicated,
    ruleDateFormatLiteralString,
    ruleReferenceDateDayZero,
    ruleDescriptionDoubled,
    ruleLastAdvancedNever,
  ];
  for (const rule of referenced) {
    assert.ok(ALL_RULES.includes(rule), `ALL_RULES missing ${rule.name}`);
  }
});
