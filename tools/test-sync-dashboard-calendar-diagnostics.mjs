#!/usr/bin/env node
/**
 * Integration pin for the "Copy calendar diagnostics" button added to the
 * Status tab of the Sync Dashboard (sync-dashboard.mjs).
 *
 * Tests that:
 *  1. The `copy-calendar-diagnostics` action is registered in DEFAULT_OPTIONS.
 *  2. `buildCalendarDiagnostics` is imported from sync-calendar-diagnostics.mjs.
 *  3. The template exposes the action button and feedback element.
 *  4. A stub input shaped like _buildCalendarDiagnosticsInput()'s output produces
 *     a valid Markdown report via buildCalendarDiagnostics.
 *
 * Run: node --test tools/test-sync-dashboard-calendar-diagnostics.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const dashboardSource = readFileSync(resolve(REPO_ROOT, 'scripts/sync-dashboard.mjs'), 'utf8');
const templateSource = readFileSync(resolve(REPO_ROOT, 'templates/sync-dashboard.hbs'), 'utf8');

const { buildCalendarDiagnostics } = await import('../scripts/sync-calendar-diagnostics.mjs');

test('copy-calendar-diagnostics action is registered in DEFAULT_OPTIONS', () => {
  assert.ok(
    dashboardSource.includes("'copy-calendar-diagnostics'"),
    'Expected the action key "copy-calendar-diagnostics" to be registered in DEFAULT_OPTIONS.actions',
  );
});

test('buildCalendarDiagnostics is imported from sync-calendar-diagnostics.mjs', () => {
  assert.ok(
    dashboardSource.includes('buildCalendarDiagnostics'),
    'Expected sync-dashboard.mjs to import buildCalendarDiagnostics',
  );
  assert.ok(
    dashboardSource.includes('sync-calendar-diagnostics.mjs'),
    'Expected the import to come from sync-calendar-diagnostics.mjs',
  );
});

test('_buildCalendarDiagnosticsInput method is present in sync-dashboard.mjs', () => {
  assert.ok(
    dashboardSource.includes('_buildCalendarDiagnosticsInput'),
    'Expected _buildCalendarDiagnosticsInput to be defined in sync-dashboard.mjs',
  );
});

test('Status tab template has copy-calendar-diagnostics action button', () => {
  assert.ok(
    templateSource.includes('data-action="copy-calendar-diagnostics"'),
    'Expected Status tab template to have a button with data-action="copy-calendar-diagnostics"',
  );
});

test('Status tab template has cal-diag-result feedback element', () => {
  assert.ok(
    templateSource.includes('data-cal-diag-result'),
    'Expected Status tab template to have a [data-cal-diag-result] feedback span',
  );
});

test('buildCalendarDiagnostics with dashboard-shaped input produces a complete report', () => {
  const input = {
    generatedAt: '2026-06-19T12:00:00.000Z',
    versions: {
      module: '1.5.0',
      calendaria: '14.3.2',
      schema: null,
      foundry: '13.300',
      system: 'D&D 5e 2024',
      systemId: 'dnd5e',
    },
    calendar: { name: 'Faerûn Calendar', id: 'faerlun', version: null },
    syncStatus: {
      calendarModule: 'Calendaria',
      calendarSyncEnabled: true,
      syncEnabled: true,
      thisCalendarExcluded: null,
    },
    structureCounts: { months: 12, weekdays: 10, seasons: 4, moons: 1, eras: 1, festivals: 6, cycles: null, weatherZones: 2 },
    apiMethods: { getWeatherForDate: true, getCurrentWeather: true, getAllMoonPhases: false, createNote: true },
    currentDateTime: '1492/1/1 0:00',
    settings: { syncCalendar: true, syncEnabled: true, calendarModule: 'Calendaria', conflictResolution: 'chronicle', autoSync: true },
    recentErrors: [{ time: '12:00:00', message: 'Network timeout', endpoint: '/calendar', status: 503 }],
  };

  const report = buildCalendarDiagnostics(input);

  assert.match(report, /# Chronicle Sync — Calendar Diagnostics/);
  assert.match(report, /Faerûn Calendar/);
  assert.match(report, /1\.5\.0/);
  assert.match(report, /Calendaria:\*\* 14\.3\.2/);
  assert.match(report, /Calendar sync enabled \(global\):\*\* yes/);
  assert.match(report, /Months:\*\* 12/);
  assert.match(report, /Weather zones \(custom climate zones\):\*\* 2/);
  assert.match(report, /## Recent sync errors \(1\)/);
  assert.match(report, /Network timeout/);
  assert.match(report, /syncCalendar/);
});

test('buildCalendarDiagnostics with minimal dashboard input degrades gracefully', () => {
  const input = {
    generatedAt: new Date().toISOString(),
    versions: { module: '1.0.0', foundry: '13.300', system: 'D&D 5e' },
    syncStatus: { calendarModule: 'none', calendarSyncEnabled: false, syncEnabled: false },
    recentErrors: [],
    settings: {},
  };
  const report = buildCalendarDiagnostics(input);
  assert.match(report, /# Chronicle Sync — Calendar Diagnostics/);
  assert.match(report, /## Validation findings \(0\)/);
  assert.match(report, /## Recent sync errors \(0\)/);
});
