#!/usr/bin/env node
/**
 * test-calendar-subresources.mjs — FM-SYNC-SUBRESOURCES-P1.
 *
 * Pins the PURE half of the sub-resource arc: payload normalization, the
 * GM-facing one-liners, the announce-gating map, and the snapshot reducer the
 * dashboard's world-state panel renders. No Foundry globals needed.
 *
 * The payload shapes asserted here are transcribed from Chronicle main
 * (2026-07-25) — `internal/plugins/calendar/service.go` +
 * `worldstate_service.go`. If Chronicle changes a payload, these tests are the
 * tripwire.
 *
 * Run: node --test tools/test-calendar-subresources.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTED_CALENDAR_TYPES,
  STRUCTURE_SIGNAL_TYPES,
  announceSettingFor,
  emptySubresourceState,
  formatEraLine,
  formatMoonLine,
  formatSeasonLine,
  formatSubresourceLine,
  formatWeatherLine,
  formatWorldstateLine,
  normalizeWeather,
  projectSubresourcePanel,
  reduceSubresourceState,
} from '../scripts/_calendar-subresources.mjs';

// ── normalizeWeather: both wire shapes ───────────────────────────────────────

test('normalizeWeather reads the FLAT WeatherInput shape the WS payload carries', () => {
  // service.go:1333 publishes the merged WeatherInput — flat snake_case.
  const w = normalizeWeather({
    preset_id: 'heavy-snow',
    preset_label: 'Heavy snow',
    temperature_celsius: -8,
    wind_speed_kph: 45,
    wind_speed_tier: 'gale',
    wind_direction: 'north',
    precipitation_type: 'snow',
    precipitation_intensity: 0.9,
    zone_name: 'North Reach',
  });
  assert.equal(w.presetLabel, 'Heavy snow');
  assert.equal(w.temperatureC, -8);
  assert.equal(w.windSpeedKph, 45);
  assert.equal(w.windTier, 'gale');
  assert.equal(w.precipType, 'snow');
  assert.equal(w.zoneName, 'North Reach');
});

test('normalizeWeather also reads the NESTED Weather shape GET /calendar/weather returns', () => {
  // The zone-change refetch path hits GET /calendar/weather, which serializes
  // the Weather model with nested wind/precipitation objects. Both shapes must
  // render identically or the refetch fallback would look like a different bug.
  const w = normalizeWeather({
    preset_label: 'Heavy snow',
    temperature_celsius: -8,
    wind: { speed_kph: 45, speed_tier: 'gale', direction: 'north' },
    precipitation: { type: 'snow', intensity: 0.9 },
    zone_name: 'North Reach',
  });
  assert.equal(w.windSpeedKph, 45);
  assert.equal(w.windTier, 'gale');
  assert.equal(w.windDirection, 'north');
  assert.equal(w.precipType, 'snow');
  assert.equal(w.precipIntensity, 0.9);
});

test('normalizeWeather returns null for null/empty payloads (the zone-ping case)', () => {
  assert.equal(normalizeWeather(null), null);
  assert.equal(normalizeWeather(undefined), null);
  assert.equal(normalizeWeather({}), null);
  // An icon alone is not renderable content.
  assert.equal(normalizeWeather({ icon: 'snowflake' }), null);
});

test('normalizeWeather does not turn a missing temperature into 0°C', () => {
  // Number(null) === 0 — the trap that would print "0°C" for "unknown".
  const w = normalizeWeather({ preset_label: 'Clear', temperature_celsius: null });
  assert.equal(w.temperatureC, null);
  // But a real zero survives.
  assert.equal(normalizeWeather({ temperature_celsius: 0 }).temperatureC, 0);
});

// ── formatWeatherLine ────────────────────────────────────────────────────────

test('formatWeatherLine renders the full reading with its zone', () => {
  const line = formatWeatherLine(normalizeWeather({
    preset_label: 'Heavy snow',
    temperature_celsius: -8,
    wind_speed_tier: 'gale',
    wind_direction: 'north',
    precipitation_type: 'snow',
    zone_name: 'North Reach',
  }));
  assert.match(line, /^Chronicle weather: /);
  assert.match(line, /Heavy snow/);
  assert.match(line, /-8°C/);
  assert.match(line, /gale from north/);
  assert.match(line, /— North Reach$/);
});

test('formatWeatherLine degrades to the fields that are present', () => {
  const line = formatWeatherLine(normalizeWeather({ preset_label: 'Clear' }));
  assert.equal(line, 'Chronicle weather: Clear');
});

test('formatWeatherLine returns null for a null record', () => {
  assert.equal(formatWeatherLine(null), null);
});

// ── worldstate / season / era / moon ─────────────────────────────────────────

test('formatWorldstateLine renders the date + mood tint the payload actually carries', () => {
  // worldstate_service.go:265 — {date:{y,m,d}, moodTint:{color,intensity}}.
  // NOTE: no celestial/meteor detail is present in the payload. The line must
  // not invent one. See the file header + PR body for the Chronicle-side gap.
  const line = formatWorldstateLine({
    date: { year: 1492, month: 3, day: 15 },
    moodTint: { color: '#8844aa', intensity: 0.4 },
  });
  assert.match(line, /1492-03-15/);
  assert.match(line, /mood #8844aa/);
  assert.doesNotMatch(line, /meteor|eclipse/i);
});

test('formatWorldstateLine returns null for an empty payload', () => {
  assert.equal(formatWorldstateLine(null), null);
  assert.equal(formatWorldstateLine({}), null);
});

test('formatSeasonLine handles the documented null payload as a real state', () => {
  // service.go:2544 publishes season.changed with a NULL payload when the date
  // leaves a season without entering another. That is information, not noise.
  assert.equal(formatSeasonLine({ name: 'Deepwinter' }), 'Chronicle season: Deepwinter');
  assert.match(formatSeasonLine(null), /no season currently in effect/);
});

test('formatEraLine renders a named era and nothing otherwise', () => {
  assert.equal(formatEraLine({ name: 'Third Age' }), 'Chronicle era: Third Age');
  assert.equal(formatEraLine(null), null);
  assert.equal(formatEraLine({ name: '  ' }), null);
});

test('formatMoonLine uses the snake_case fields Chronicle publishes', () => {
  const line = formatMoonLine({
    moon_id: 3, moon_name: 'Selûne', phase_name: 'Waxing Gibbous', phase_position: 0.4,
  });
  assert.equal(line, 'Chronicle moon: Selûne is now Waxing Gibbous');
});

test('formatMoonLine survives a partial moon payload', () => {
  assert.equal(formatMoonLine({ moon_name: 'Selûne' }), 'Chronicle moon: Selûne phase changed');
  assert.equal(formatMoonLine(null), null);
});

// ── formatSubresourceLine dispatch ───────────────────────────────────────────

test('formatSubresourceLine dispatches every announcing type and nothing else', () => {
  assert.match(
    formatSubresourceLine('calendar.weather.changed', { preset_label: 'Clear' }),
    /Chronicle weather/,
  );
  assert.match(formatSubresourceLine('calendar.season.changed', { name: 'Spring' }), /season/);
  assert.match(formatSubresourceLine('calendar.era.changed', { name: 'Fourth Age' }), /era/);
  assert.match(
    formatSubresourceLine('calendar.moon.phase_changed', { moon_name: 'Luna', phase_name: 'Full' }),
    /moon/,
  );
  // structure.updated never announces — it drives the badge, not chat.
  assert.equal(formatSubresourceLine('calendar.structure.updated', null), null);
  assert.equal(formatSubresourceLine('entity.updated', {}), null);
});

// ── announce gating ──────────────────────────────────────────────────────────

test('announceSettingFor maps each announcing type to its world setting', () => {
  assert.equal(announceSettingFor('calendar.weather.changed'), 'calendarAnnounceWeather');
  assert.equal(announceSettingFor('calendar.worldstate.changed'), 'calendarAnnounceWorldstate');
  assert.equal(announceSettingFor('calendar.season.changed'), 'calendarAnnounceSeasonEra');
  assert.equal(announceSettingFor('calendar.era.changed'), 'calendarAnnounceSeasonEra');
  assert.equal(announceSettingFor('calendar.moon.phase_changed'), 'calendarAnnounceMoon');
});

test('announceSettingFor returns null for types that must never reach chat', () => {
  for (const t of ['calendar.structure.updated', 'calendar.date.advanced', 'calendar.event.created']) {
    assert.equal(announceSettingFor(t), null, `${t} must not be announceable`);
  }
});

// ── routed-type inventory ────────────────────────────────────────────────────

test('every Chronicle calendar.* type is claimed as routed (no silent drops)', () => {
  // The eleven types Chronicle's publisher adapter can emit
  // (internal/app/routes.go PublishCalendarEvent switch) plus worldstate.
  const chronicleEmits = [
    'calendar.event.created', 'calendar.event.updated', 'calendar.event.deleted',
    'calendar.date.advanced', 'calendar.season.changed', 'calendar.moon.phase_changed',
    'calendar.weather.changed', 'calendar.structure.updated', 'calendar.era.changed',
    'calendar.cycle.changed', 'calendar.festival.changed', 'calendar.worldstate.changed',
  ];
  for (const t of chronicleEmits) {
    assert.ok(ROUTED_CALENDAR_TYPES.includes(t), `${t} is not routed — it would be silently dropped`);
  }
});

test('structure signals are the three that fire together from the same service call', () => {
  assert.deepEqual([...STRUCTURE_SIGNAL_TYPES].sort(), [
    'calendar.cycle.changed', 'calendar.festival.changed', 'calendar.structure.updated',
  ]);
});

// ── reducer ──────────────────────────────────────────────────────────────────

test('reducer folds weather, season, era and multiple moons into one snapshot', () => {
  let s = emptySubresourceState();
  s = reduceSubresourceState(s, 'calendar.weather.changed', { preset_label: 'Fog', temperature_celsius: 4 });
  s = reduceSubresourceState(s, 'calendar.season.changed', { name: 'Autumn', color: '#c60' });
  s = reduceSubresourceState(s, 'calendar.era.changed', { name: 'Fourth Age' });
  s = reduceSubresourceState(s, 'calendar.moon.phase_changed', { moon_id: 1, moon_name: 'Selûne', phase_name: 'Full' });
  s = reduceSubresourceState(s, 'calendar.moon.phase_changed', { moon_id: 2, moon_name: 'Tears', phase_name: 'New' });

  assert.equal(s.weather.presetLabel, 'Fog');
  assert.equal(s.season.name, 'Autumn');
  assert.equal(s.era.name, 'Fourth Age');
  assert.equal(Object.keys(s.moons).length, 2, 'two moons must coexist, not overwrite');
  assert.equal(s.moons['1'].phase, 'Full');
  assert.equal(s.moons['2'].phase, 'New');
});

test('reducer never mutates the previous state object', () => {
  const a = emptySubresourceState();
  const b = reduceSubresourceState(a, 'calendar.moon.phase_changed', { moon_id: 1, moon_name: 'Luna', phase_name: 'Full' });
  assert.deepEqual(a.moons, {}, 'prev.moons must not gain the new moon');
  assert.notEqual(a, b);
});

test('a null weather payload PRESERVES the last reading rather than blanking it', () => {
  // The weather-zone paths (service.go:1490, :1523) publish weather.changed with
  // a null payload. Treating that as "weather unknown" would wipe a good reading
  // off the dashboard on every zone edit.
  let s = reduceSubresourceState(emptySubresourceState(), 'calendar.weather.changed', { preset_label: 'Clear' });
  s = reduceSubresourceState(s, 'calendar.weather.changed', null);
  assert.equal(s.weather.presetLabel, 'Clear');
  assert.match(s.weatherLine, /Clear/);
});

test('a null season payload DOES clear the season — it is a meaningful state', () => {
  let s = reduceSubresourceState(emptySubresourceState(), 'calendar.season.changed', { name: 'Summer' });
  s = reduceSubresourceState(s, 'calendar.season.changed', null);
  assert.equal(s.season, null);
});

// ── panel projection ─────────────────────────────────────────────────────────

test('projectSubresourcePanel reports has:false before anything arrives', () => {
  const p = projectSubresourcePanel(emptySubresourceState());
  assert.equal(p.has, false);
  assert.deepEqual(p.moons, []);
  assert.equal(projectSubresourcePanel(null).has, false);
});

test('projectSubresourcePanel flattens the snapshot with moons sorted by name', () => {
  let s = emptySubresourceState();
  s = reduceSubresourceState(s, 'calendar.moon.phase_changed', { moon_id: 1, moon_name: 'Zephyr', phase_name: 'New' });
  s = reduceSubresourceState(s, 'calendar.moon.phase_changed', { moon_id: 2, moon_name: 'Alba', phase_name: 'Full' });
  s = reduceSubresourceState(s, 'calendar.season.changed', { name: 'Winter' });
  const p = projectSubresourcePanel(s);
  assert.equal(p.has, true);
  assert.equal(p.seasonName, 'Winter');
  assert.deepEqual(p.moons.map((m) => m.name), ['Alba', 'Zephyr']);
});

test('projectSubresourcePanel still shows after a season.changed(null) clears the season', () => {
  // has:false must mean "nothing arrived", not "the arriving value was null" —
  // otherwise the panel vanishes exactly when it has news to report.
  let s = reduceSubresourceState(emptySubresourceState(), 'calendar.season.changed', null);
  const p = projectSubresourcePanel(s);
  assert.equal(p.has, true);
  assert.equal(p.seasonName, null);
});
