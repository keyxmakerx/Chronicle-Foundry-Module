#!/usr/bin/env node
/**
 * Unit tests for the pure diagnostics report builder in
 * `scripts/sync-calendar-diagnostics.mjs`.
 *
 * Run: `node --test tools/test-sync-calendar-diagnostics.mjs`
 * Uses Node's built-in `node:test` (Node ≥ 18); no Foundry globals needed —
 * the builder is pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildCalendarDiagnostics } = await import('../scripts/sync-calendar-diagnostics.mjs');

test('empty input never throws and produces a titled report', () => {
  const out = buildCalendarDiagnostics();
  assert.match(out, /# Chronicle Sync — Calendar Diagnostics/);
  assert.match(out, /## Validation findings \(0\)/);
  assert.match(out, /## Sync status/);
});

test('null/garbage input is tolerated', () => {
  assert.doesNotThrow(() => buildCalendarDiagnostics(null));
  assert.doesNotThrow(() => buildCalendarDiagnostics('nope'));
  assert.doesNotThrow(() => buildCalendarDiagnostics(42));
});

test('versions and calendar identity surface', () => {
  const out = buildCalendarDiagnostics({
    versions: { module: '1.2.3', calendaria: '14.5', schema: '2', foundry: '13.300', system: 'D&D 5e', systemId: 'dnd5e' },
    calendar: { name: 'Calendar of Therin', id: 'therin' },
  });
  assert.match(out, /Calendaria:\*\* 14\.5/);
  assert.match(out, /Calendar of Therin/);
  assert.match(out, /dnd5e/);
});

test('findings are grouped by severity with counts', () => {
  const out = buildCalendarDiagnostics({
    findings: [
      { severity: 'error', code: 'E1', message: 'bad thing', fixHint: 'do x' },
      { severity: 'warning', code: 'W1', message: 'iffy thing' },
      { severity: 'info', code: 'I1', message: 'fyi' },
      { severity: 'error', code: 'E2', message: 'another bad' },
    ],
  });
  assert.match(out, /## Validation findings \(4\)/);
  assert.match(out, /### ERROR \(2\)/);
  assert.match(out, /### WARNING \(1\)/);
  assert.match(out, /### INFO \(1\)/);
  assert.match(out, /`E1` — bad thing _\(fix: do x\)_/);
});

test('weather-zone note clarifies the count semantics', () => {
  const out = buildCalendarDiagnostics({ structureCounts: { weatherZones: 0 } });
  assert.match(out, /Weather zones \(custom climate zones\):\*\* 0/);
  assert.match(out, /per-day weather .* is not a zone/i);
});

test('selected-day weather distinguishes current vs selected date', () => {
  const out = buildCalendarDiagnostics({
    selectedDate: { year: 1492, month: 1, day: 5 },
    dayDetail: {
      weatherCurrent: { label: 'Clear' },
      weatherForDate: { label: 'Meteor Shower' },
      notes: [{ name: 'Day of Rebirth' }],
      moonPhases: [{ moonName: 'Selûne', phaseName: 'Full' }],
    },
  });
  assert.match(out, /Weather \(current date\):\*\* Clear/);
  assert.match(out, /Weather \(selected date\):\*\* Meteor Shower/);
  assert.match(out, /Day of Rebirth/);
  assert.match(out, /Selûne: Full/);
});

test('api method probe lists present and missing', () => {
  const out = buildCalendarDiagnostics({
    apiMethods: { getWeatherForDate: false, getCurrentWeather: true, getAllMoonPhases: true },
  });
  assert.match(out, /Present:\*\* getCurrentWeather, getAllMoonPhases/);
  assert.match(out, /Missing:\*\* getWeatherForDate/);
});

test('recent errors are listed and capped', () => {
  const errors = Array.from({ length: 30 }, (_, n) => ({ time: `t${n}`, message: `err ${n}`, endpoint: '/x', status: 500 }));
  const out = buildCalendarDiagnostics({ recentErrors: errors });
  assert.match(out, /## Recent sync errors \(30\)/);
  assert.match(out, /err 0 \(\/x 500\)/);
  // capped at 25 lines rendered
  assert.ok(!out.includes('err 27'));
});

test('raw appendix is emitted as a json block when present', () => {
  const out = buildCalendarDiagnostics({ raw: { weather: { preset_id: 'meteor_shower', zone: '_default' } } });
  assert.match(out, /## Raw \(verbatim object shapes\)/);
  assert.match(out, /"preset_id": "meteor_shower"/);
});

test('boolean sync status renders yes/no/unknown', () => {
  const out = buildCalendarDiagnostics({ syncStatus: { calendarSyncEnabled: true, syncEnabled: false } });
  assert.match(out, /Calendar sync enabled \(global\):\*\* yes/);
  assert.match(out, /Master sync enabled:\*\* no/);
  assert.match(out, /This calendar excluded from sync:\*\* \(unknown\)/);
});
