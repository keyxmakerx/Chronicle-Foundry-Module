#!/usr/bin/env node
/**
 * Unit tests for the pure note-form translation module
 * `scripts/sync-calendar-note-form.mjs`.
 *
 * Covers:
 *  - `defaultFormForDate` shape (single-day + multi-day anchors)
 *  - `formFromNote` extraction (full / partial / null inputs, flagData nesting)
 *  - `noteOptionsFromForm` conversion (date+time shape, allDay handling, end omission)
 *  - `validateForm` positives + negatives per field
 *  - `coerceCategories`, `coerceVisibility`, `coerceDisplayStyle` enum pins
 *  - Round-trip: defaultForm → noteOptions → formFromNote (a degraded round-trip;
 *    we lose categories.objects vs ids but pin the shape contract)
 *
 * Run: `node --test tools/test-sync-calendar-note-form.mjs`
 *
 * No mocking — uses Node's built-in `node:test` (Node ≥ 18).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  defaultFormForDate,
  formFromNote,
  noteOptionsFromForm,
  validateForm,
  coerceCategories,
  coerceVisibility,
  coerceDisplayStyle,
  VISIBILITY,
  DISPLAY_STYLE,
} = await import('../scripts/sync-calendar-note-form.mjs');

// ---------------------------------------------------------------------
// defaultFormForDate
// ---------------------------------------------------------------------

test('defaultFormForDate — single-day anchor', () => {
  const f = defaultFormForDate({ year: 1492, month: 3, day: 15 });
  assert.equal(f.name, '');
  assert.equal(f.year, 1492);
  assert.equal(f.month, 3);
  assert.equal(f.day, 15);
  assert.equal(f.endYear, null);
  assert.equal(f.endMonth, null);
  assert.equal(f.endDay, null);
  assert.equal(f.allDay, true);
  assert.equal(f.visibility, VISIBILITY.VISIBLE);
  assert.equal(f.displayStyle, DISPLAY_STYLE.ICON);
  assert.deepEqual(f.categories, []);
});

test('defaultFormForDate — multi-day anchor (drag-select 14 → 18)', () => {
  const f = defaultFormForDate({
    year: 1492, month: 3, day: 14,
    endYear: 1492, endMonth: 3, endDay: 18,
  });
  assert.equal(f.year, 1492);
  assert.equal(f.month, 3);
  assert.equal(f.day, 14);
  assert.equal(f.endYear, 1492);
  assert.equal(f.endMonth, 3);
  assert.equal(f.endDay, 18);
});

test('defaultFormForDate — empty/invalid anchor uses safe defaults', () => {
  const f = defaultFormForDate({});
  assert.equal(f.year, 0);
  assert.equal(f.month, 1);
  assert.equal(f.day, 1);
});

test('defaultFormForDate — null anchor uses safe defaults', () => {
  const f = defaultFormForDate(null);
  assert.equal(f.year, 0);
  assert.equal(f.month, 1);
  assert.equal(f.day, 1);
});

test('defaultFormForDate — partial endDate (missing endDay) treated as single-day', () => {
  // The form treats range as "all three end-* must be set"; partial → no range.
  const f = defaultFormForDate({ year: 1, month: 1, day: 1, endYear: 1, endMonth: 1 });
  assert.equal(f.endYear, null);
  assert.equal(f.endMonth, null);
  assert.equal(f.endDay, null);
});

// ---------------------------------------------------------------------
// formFromNote
// ---------------------------------------------------------------------

test('formFromNote — null returns default form', () => {
  const f = formFromNote(null);
  assert.equal(f.year, 0);
  assert.equal(f.month, 1);
  assert.equal(f.day, 1);
  assert.equal(f.visibility, VISIBILITY.VISIBLE);
});

test('formFromNote — full Calendaria stub at top level', () => {
  const f = formFromNote({
    name: 'Council',
    content: '<p>Body</p>',
    startDate: { year: 1492, month: 5, day: 15, hour: 14, minute: 30 },
    endDate:   { year: 1492, month: 5, day: 16, hour: 16, minute: 0 },
    allDay: false,
    visibility: 'hidden',
    displayStyle: 'banner',
    icon: 'fas fa-handshake',
    color: '#4a90e2',
    categories: ['meeting', 'session'],
  });
  assert.equal(f.name, 'Council');
  assert.equal(f.content, '<p>Body</p>');
  assert.equal(f.year, 1492);
  assert.equal(f.month, 5);
  assert.equal(f.day, 15);
  assert.equal(f.endYear, 1492);
  assert.equal(f.endMonth, 5);
  assert.equal(f.endDay, 16);
  assert.equal(f.hour, 14);
  assert.equal(f.minute, 30);
  assert.equal(f.endHour, 16);
  assert.equal(f.endMinute, 0);
  assert.equal(f.allDay, false);
  assert.equal(f.visibility, VISIBILITY.HIDDEN);
  assert.equal(f.displayStyle, DISPLAY_STYLE.BANNER);
  assert.equal(f.icon, 'fas fa-handshake');
  assert.equal(f.color, '#4a90e2');
  assert.deepEqual(f.categories, ['meeting', 'session']);
});

test('formFromNote — flagData-nested shape (older Calendaria)', () => {
  const f = formFromNote({
    name: 'Mid',
    flagData: {
      startDate: { year: 1, month: 2, day: 3 },
      content: '<p>Body in flagData</p>',
      icon: 'fas fa-star',
    },
  });
  assert.equal(f.name, 'Mid');
  assert.equal(f.content, '<p>Body in flagData</p>');
  assert.equal(f.year, 1);
  assert.equal(f.month, 2);
  assert.equal(f.day, 3);
  assert.equal(f.icon, 'fas fa-star');
});

test('formFromNote — top-level wins over flagData', () => {
  const f = formFromNote({
    name: 'Top',
    flagData: { name: 'Inner' },
  });
  assert.equal(f.name, 'Top');
});

test('formFromNote — unknown visibility falls back to "visible"', () => {
  const f = formFromNote({ name: 'X', startDate: { year: 1, month: 1, day: 1 }, visibility: 'notreal' });
  assert.equal(f.visibility, VISIBILITY.VISIBLE);
});

test('formFromNote — internal dayOfMonth alias supported on startDate', () => {
  // Some hooks expose `dayOfMonth` (0-indexed internal) — formFromNote
  // reads it as a fallback for `day` when day is missing. We don't do
  // index conversion here; that's by design (callers using formFromNote
  // do so against the public stub shape which is 1-indexed).
  const f = formFromNote({ name: 'X', startDate: { year: 1, month: 1, dayOfMonth: 5 } });
  assert.equal(f.day, 5);
});

// ---------------------------------------------------------------------
// noteOptionsFromForm
// ---------------------------------------------------------------------

test('noteOptionsFromForm — single-day, all-day defaults', () => {
  const form = defaultFormForDate({ year: 1492, month: 3, day: 15 });
  form.name = 'Festival';
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.name, 'Festival');
  assert.deepEqual(opts.startDate, { year: 1492, month: 3, day: 15 });
  assert.equal(opts.endDate, undefined);
  assert.equal(opts.allDay, true);
  assert.equal(opts.visibility, VISIBILITY.VISIBLE);
  assert.equal(opts.displayStyle, DISPLAY_STYLE.ICON);
  assert.equal(opts.openSheet, false);
  // Empty optional fields are omitted entirely (Calendaria defaults apply).
  assert.ok(!('icon'       in opts));
  assert.ok(!('color'      in opts));
  assert.ok(!('categories' in opts));
});

test('noteOptionsFromForm — multi-day all-day event', () => {
  const form = defaultFormForDate({ year: 1492, month: 3, day: 14, endYear: 1492, endMonth: 3, endDay: 18 });
  form.name = 'Council Week';
  const opts = noteOptionsFromForm(form);
  assert.deepEqual(opts.startDate, { year: 1492, month: 3, day: 14 });
  assert.deepEqual(opts.endDate,   { year: 1492, month: 3, day: 18 });
  // allDay → no hour/minute on either side.
  assert.ok(!('hour'   in opts.startDate));
  assert.ok(!('minute' in opts.startDate));
  assert.ok(!('hour'   in opts.endDate));
});

test('noteOptionsFromForm — timed event includes hour/minute on start AND end', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name   = 'Audience';
  form.allDay = false;
  form.hour = 9;  form.minute = 30;
  form.endHour = 10; form.endMinute = 45;
  form.endYear = 1; form.endMonth = 1; form.endDay = 1;
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.startDate.hour, 9);
  assert.equal(opts.startDate.minute, 30);
  assert.equal(opts.endDate.hour, 10);
  assert.equal(opts.endDate.minute, 45);
});

test('noteOptionsFromForm — timed event falls back to start time when end time absent', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.allDay = false;
  form.hour = 12; form.minute = 0;
  form.endYear = 1; form.endMonth = 1; form.endDay = 2;
  // endHour / endMinute null → falls back to start values
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.endDate.hour, 12);
  assert.equal(opts.endDate.minute, 0);
});

test('noteOptionsFromForm — clamps hour/minute to valid range', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.allDay = false;
  form.hour = 99;     // clamps to 23
  form.minute = -5;   // clamps to 0
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.startDate.hour, 23);
  assert.equal(opts.startDate.minute, 0);
});

test('noteOptionsFromForm — trims name + categories', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = '   Padded Name   ';
  form.categories = ['  meeting  ', '', 'meeting', 'session'];
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.name, 'Padded Name');
  assert.deepEqual(opts.categories, ['meeting', 'session']);
});

test('noteOptionsFromForm — never sets openSheet:true (no Calendaria sheet stealing focus)', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  const opts = noteOptionsFromForm(form);
  assert.equal(opts.openSheet, false);
});

test('noteOptionsFromForm — non-object input throws', () => {
  assert.throws(() => noteOptionsFromForm(null), TypeError);
  assert.throws(() => noteOptionsFromForm('string'), TypeError);
});

// ---------------------------------------------------------------------
// validateForm
// ---------------------------------------------------------------------

test('validateForm — clean form returns []', () => {
  const form = defaultFormForDate({ year: 1492, month: 3, day: 15 });
  form.name = 'Valid';
  assert.deepEqual(validateForm(form), []);
});

test('validateForm — flags missing name', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  // form.name is '' from defaults
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.NameRequired'));
});

test('validateForm — flags whitespace-only name', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = '    ';
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.NameRequired'));
});

test('validateForm — flags invalid month', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.month = 0;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.MonthInvalid'));
});

test('validateForm — flags invalid day', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.day = 0;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.DayInvalid'));
});

test('validateForm — flags end-before-start (year)', () => {
  const form = defaultFormForDate({ year: 1492, month: 3, day: 15 });
  form.name = 'X';
  form.endYear = 1491; form.endMonth = 3; form.endDay = 15;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.EndBeforeStart'));
});

test('validateForm — flags end-before-start (month)', () => {
  const form = defaultFormForDate({ year: 1, month: 5, day: 15 });
  form.name = 'X';
  form.endYear = 1; form.endMonth = 4; form.endDay = 15;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.EndBeforeStart'));
});

test('validateForm — flags end-before-start (day)', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 5 });
  form.name = 'X';
  form.endYear = 1; form.endMonth = 1; form.endDay = 4;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.EndBeforeStart'));
});

test('validateForm — same-day end passes', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 5 });
  form.name = 'X';
  form.endYear = 1; form.endMonth = 1; form.endDay = 5;
  assert.deepEqual(validateForm(form), []);
});

test('validateForm — flags invalid hour when not all-day', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.allDay = false;
  form.hour = 25;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.HourInvalid'));
});

test('validateForm — flags invalid minute when not all-day', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.allDay = false;
  form.minute = 60;
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.MinuteInvalid'));
});

test('validateForm — hour/minute not checked when all-day', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.allDay = true;
  form.hour = 999; form.minute = -1;
  assert.deepEqual(validateForm(form), []);
});

test('validateForm — flags invalid visibility', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.visibility = 'notreal';
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.VisibilityInvalid'));
});

test('validateForm — flags invalid displayStyle', () => {
  const form = defaultFormForDate({ year: 1, month: 1, day: 1 });
  form.name = 'X';
  form.displayStyle = 'rocket';
  const errs = validateForm(form);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.NoteForm.Errors.DisplayStyleInvalid'));
});

test('validateForm — non-object input is rejected', () => {
  assert.deepEqual(validateForm(null), ['CHRONICLE.SyncCalendar.NoteForm.Errors.NotAnObject']);
  assert.deepEqual(validateForm('string'), ['CHRONICLE.SyncCalendar.NoteForm.Errors.NotAnObject']);
});

// ---------------------------------------------------------------------
// coerceCategories / coerceVisibility / coerceDisplayStyle
// ---------------------------------------------------------------------

test('coerceCategories — array dedups + trims', () => {
  assert.deepEqual(coerceCategories(['a', ' a ', 'b', '']), ['a', 'b']);
});

test('coerceCategories — comma-string dedups + trims', () => {
  assert.deepEqual(coerceCategories(' a , b ,a, '), ['a', 'b']);
});

test('coerceCategories — non-array, non-string returns []', () => {
  assert.deepEqual(coerceCategories(null), []);
  assert.deepEqual(coerceCategories(42), []);
});

test('coerceVisibility — known values pass through', () => {
  for (const v of Object.values(VISIBILITY)) {
    assert.equal(coerceVisibility(v), v);
  }
});

test('coerceVisibility — unknown falls back to visible', () => {
  assert.equal(coerceVisibility('weird'), VISIBILITY.VISIBLE);
  assert.equal(coerceVisibility(null), VISIBILITY.VISIBLE);
});

test('coerceDisplayStyle — known values pass through', () => {
  for (const s of Object.values(DISPLAY_STYLE)) {
    assert.equal(coerceDisplayStyle(s), s);
  }
});

test('coerceDisplayStyle — unknown falls back to icon', () => {
  assert.equal(coerceDisplayStyle('weird'), DISPLAY_STYLE.ICON);
});

// ---------------------------------------------------------------------
// Round-trip smoke
// ---------------------------------------------------------------------

test('round-trip — defaultForm → noteOptions → simulated note → formFromNote preserves keys', () => {
  const original = defaultFormForDate({
    year: 1492, month: 3, day: 14,
    endYear: 1492, endMonth: 3, endDay: 18,
  });
  original.name = 'Roundtrip';
  original.content = '<p>Body</p>';
  original.visibility = VISIBILITY.HIDDEN;
  original.displayStyle = DISPLAY_STYLE.BANNER;
  original.icon = 'fas fa-star';
  original.color = '#abcdef';
  original.categories = ['a', 'b'];

  const opts = noteOptionsFromForm(original);
  // Simulate a Calendaria stub that mirrors the options we sent.
  const simulatedNote = {
    name:         opts.name,
    content:      opts.content,
    startDate:    opts.startDate,
    endDate:      opts.endDate,
    allDay:       opts.allDay,
    visibility:   opts.visibility,
    displayStyle: opts.displayStyle,
    icon:         opts.icon,
    color:        opts.color,
    categories:   opts.categories,
  };
  const restored = formFromNote(simulatedNote);

  assert.equal(restored.name, original.name);
  assert.equal(restored.content, original.content);
  assert.equal(restored.year, original.year);
  assert.equal(restored.month, original.month);
  assert.equal(restored.day, original.day);
  assert.equal(restored.endYear, original.endYear);
  assert.equal(restored.endMonth, original.endMonth);
  assert.equal(restored.endDay, original.endDay);
  assert.equal(restored.allDay, original.allDay);
  assert.equal(restored.visibility, original.visibility);
  assert.equal(restored.displayStyle, original.displayStyle);
  assert.equal(restored.icon, original.icon);
  assert.equal(restored.color, original.color);
  assert.deepEqual(restored.categories, original.categories);
});
