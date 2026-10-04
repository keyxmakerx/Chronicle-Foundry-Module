#!/usr/bin/env node
/**
 * The built-in calendar's pure logic (`scripts/_calendar-view-model.mjs`):
 * stepping, labels, the month grid, and above all the player snapshot, which
 * must carry nothing a player may not see.
 *
 * Run: `node --test tools/test-calendar-view-model.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as VM from '../scripts/_calendar-view-model.mjs';

const cal = {
  mode: 'fantasy', hours_per_day: 24, minutes_per_hour: 60,
  months: [
    { name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, is_intercalary: true },
    { name: 'Alturiak', days: 30 }, { name: 'Ches', days: 30, leap_year_days: 1 },
  ],
  weekdays: Array.from({ length: 10 }, (_, i) => ({ name: `D${i + 1}` })),
  leap_year_every: 4, leap_year_offset: 0,
};

test('stepDate carries hours, days and weeks across months and years', () => {
  const cases = [
    [{ year: 1492, month: 1, day: 30, hour: 23, minute: 5 }, 'hour', 1, { year: 1492, month: 2, day: 1, hour: 0, minute: 5 }],
    [{ year: 1492, month: 1, day: 1, hour: 0, minute: 0 }, 'hour', -1, { year: 1491, month: 4, day: 30, hour: 23, minute: 0 }],
    [{ year: 1492, month: 4, day: 30, hour: 8, minute: 0 }, 'day', 1, { year: 1492, month: 4, day: 31, hour: 8, minute: 0 }],
    [{ year: 1493, month: 4, day: 30, hour: 8, minute: 0 }, 'day', 1, { year: 1494, month: 1, day: 1, hour: 8, minute: 0 }],
    [{ year: 1492, month: 1, day: 1, hour: 0, minute: 0 }, 'week', 1, { year: 1492, month: 1, day: 11, hour: 0, minute: 0 }],
    [{ year: 1492, month: 1, day: 1, hour: 0, minute: 0 }, 'hour', 48, { year: 1492, month: 1, day: 3, hour: 0, minute: 0 }],
  ];
  for (const [from, unit, n, want] of cases) {
    assert.deepEqual(VM.stepDate(cal, from, unit, n), want, `${JSON.stringify(from)} ${unit} ${n}`);
  }
  const short = { ...cal, hours_per_day: 10 };
  assert.deepEqual(VM.stepDate(short, { year: 1, month: 1, day: 1, hour: 9, minute: 0 }, 'hour', 1),
    { year: 1, month: 1, day: 2, hour: 0, minute: 0 }, 'uses the calendar\'s own day length');
  const d = { year: 1, month: 1, day: 1, hour: 0, minute: 0 };
  assert.equal(VM.stepDate(cal, d, 'fortnight', 1), d, 'unknown unit leaves the date alone');
});

test('clampDate refuses dates the calendar cannot hold', () => {
  assert.deepEqual(VM.clampDate(cal, { year: 1492, month: 4, day: 31, hour: 30, minute: -2 }),
    { year: 1492, month: 4, day: 31, hour: 23, minute: 0 });
  assert.equal(VM.clampDate(cal, { year: 1493, month: 4, day: 31 }), null, 'no leap day outside a leap year');
  assert.equal(VM.clampDate(cal, { year: 1492, month: 5, day: 1 }), null);
  assert.equal(VM.clampDate(cal, { year: 'x', month: 1, day: 1 }), null);
});

test('labels', () => {
  const d = { year: 1492, month: 3, day: 7, hour: 9, minute: 5 };
  assert.equal(VM.formatDate(cal, d), '7 Alturiak 1492');
  assert.equal(VM.formatTime(cal, d), '09:05');
  assert.equal(VM.formatTemperature(20), '20°C');
  assert.equal(VM.formatTemperature(20, 'F'), '68°F');
  assert.equal(VM.formatTemperature(null), '');
  assert.equal(VM.weatherIconClass('rain'), 'fa-cloud-rain');
  assert.equal(VM.weatherIconClass('<x>'), 'fa-cloud-sun');
  assert.equal(VM.safeColor('#a1b2c3'), '#a1b2c3');
  assert.equal(VM.safeColor('red;background:url(x)'), null);
});

test('monthGrid lays days under their weekdays; a festival month outside the week is one row', () => {
  const g = VM.monthGrid(cal, 1492, 1);
  assert.equal(g.headers.length, 10);
  assert.equal(g.rows.flat().filter(Boolean).length, 30);
  for (const row of g.rows) assert.equal(row.length, 10);
  const restart = { ...cal, month_starts_new_week: true };
  const f = VM.monthGrid(restart, 1492, 2);
  assert.equal(f.festival, true);
  assert.deepEqual(f.rows, [[1]]);
  const m = VM.monthGrid(restart, 1492, 3);
  assert.equal(m.rows[0][0], 1, 'a restarting week puts day 1 in the first column');
});

test('skyPhase follows the calendar\'s day length', () => {
  assert.equal(VM.skyPhase(cal, 2), 'night');
  assert.equal(VM.skyPhase(cal, 6), 'dawn');
  assert.equal(VM.skyPhase(cal, 12), 'day');
  assert.equal(VM.skyPhase(cal, 19), 'dusk');
  assert.equal(VM.skyPhase({ hours_per_day: 10 }, 5), 'day');
});

const isPublic = (e) => e.visibility === undefined || e.visibility === 'everyone';

test('player snapshot: hidden calendar shows nothing', () => {
  assert.deepEqual(VM.buildPlayerSnapshot({ calendar: null, dateInfo: null, events: [], isPublic }),
    { v: VM.SNAPSHOT_VERSION, hidden: true });
  assert.equal(VM.isUsableSnapshot({ v: VM.SNAPSHOT_VERSION, hidden: true }), false);
});

test('player snapshot copies only named fields and only public events', () => {
  const s = VM.buildPlayerSnapshot({
    calendar: { ...cal, current_year: 1492, eras: [{ name: 'secret' }], moons: [{ name: 'Hidden' }], secret_field: 1 },
    dateInfo: {
      year: 1492, month: 3, day: 7, hour: 9, minute: 5, audience: 'players',
      current_season: { id: 1, name: 'Spring', color: '#88cc88' },
      current_weather: { preset_label: 'Rain', icon: 'rain', color: 'javascript:x', temperature_celsius: 11, zone_name: 'Underdark' },
      current_moon_phases: [{ moon_id: 4, moon_name: 'Selûne', phase_name: 'Full', phase_icon: 'moon', phase_position: 0.5 }],
    },
    events: [
      { id: 'a', name: 'Fair', year: 1492, month: 3, day: 9, visibility: 'everyone', description: 'x', entity_id: 'e1' },
      { id: 'b', name: 'Ambush', year: 1492, month: 3, day: 9, visibility: 'gm-only' },
    ],
    eventsConfirmed: true,
    isPublic,
  });
  assert.ok(VM.isUsableSnapshot(s));
  assert.deepEqual(Object.keys(s.calendar).sort(), ['hours_per_day', 'leap_year_every', 'leap_year_offset', 'minutes_per_hour', 'mode', 'month_starts_new_week', 'months', 'tracks_real_time', 'weekdays']);
  assert.deepEqual(s.events.map((e) => e.id), ['a']);
  assert.deepEqual(Object.keys(s.events[0]).sort(), ['all_day', 'color', 'day', 'id', 'month', 'name', 'start_hour', 'start_minute', 'year']);
  assert.equal(s.weather.color, null, 'unsafe colours are dropped');
  assert.equal('zone_name' in s.weather, false);
  assert.deepEqual(s.moons, [{ name: 'Selûne', phase_name: 'Full', phase_icon: 'moon' }]);
  assert.deepEqual(s.date, { year: 1492, month: 3, day: 7, hour: 9, minute: 5 });
});

test('player snapshot without an isPublic check keeps no events', () => {
  const s = VM.buildPlayerSnapshot({ calendar: cal, dateInfo: { year: 1, month: 1, day: 1 }, events: [{ id: 'a', visibility: 'everyone' }] });
  assert.deepEqual(s.events, []);
});

test('player snapshot keeps at most SNAPSHOT_EVENT_LIMIT events', () => {
  const many = Array.from({ length: VM.SNAPSHOT_EVENT_LIMIT + 5 }, (_, i) => ({ id: i, name: 'e', year: 1, month: 1, day: 1 }));
  const s = VM.buildPlayerSnapshot({ calendar: cal, dateInfo: { year: 1, month: 1, day: 1 }, events: many, eventsConfirmed: true, isPublic });
  assert.equal(s.events.length, VM.SNAPSHOT_EVENT_LIMIT);
});

test('eventsOn picks one day, all-day first then by start time', () => {
  const evs = [
    { id: 1, year: 1, month: 1, day: 2, start_hour: 9 },
    { id: 2, year: 1, month: 1, day: 2, all_day: true },
    { id: 3, year: 1, month: 1, day: 2, start_hour: 7, start_minute: 30 },
    { id: 4, year: 1, month: 1, day: 3 },
  ];
  assert.deepEqual(VM.eventsOn(evs, 1, 1, 2).map((e) => e.id), [2, 3, 1]);
});

test('an older Chronicle that ignored the players audience gets no moons, era or events', () => {
  const s = VM.buildPlayerSnapshot({
    calendar: cal,
    dateInfo: { year: 1, month: 1, day: 1, current_era: { name: 'Secret' }, current_moon_phases: [{ moon_name: 'Hidden' }], current_season: { name: 'Spring' } },
    events: [{ id: 'a', name: 'x', visibility: 'everyone' }],
    eventsConfirmed: false,
    isPublic,
  });
  assert.equal(s.era, null);
  assert.deepEqual(s.moons, []);
  assert.deepEqual(s.events, []);
  assert.equal(s.season.name, 'Spring', 'season and weather are the same for everyone');
});

test('a calendar not open to every player gives a hidden snapshot', () => {
  const dateInfo = { year: 1, month: 1, day: 1, audience: 'players' };
  const cases = [
    [{ ...cal, visibility: 'dm_only' }, true],
    [{ ...cal, visibility: 'everyone', visibility_rules: '{"allowed_users":["u1"]}' }, true],
    [{ ...cal, visibility: 'everyone', visibility_rules: '{"denied_users":["u1"]}' }, true],
    [{ ...cal, visibility: 'everyone', visibility_rules: 'not json' }, true],
    [{ ...cal, visibility: 'everyone', visibility_rules: '{"allowed_users":[]}' }, false],
    [{ ...cal, visibility: 'everyone' }, false],
    [cal, false],
  ];
  for (const [c, hidden] of cases) {
    assert.equal(VM.buildPlayerSnapshot({ calendar: c, dateInfo, isPublic }).hidden, hidden, JSON.stringify([c.visibility, c.visibility_rules]));
  }
});
