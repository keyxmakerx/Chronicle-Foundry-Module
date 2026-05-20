#!/usr/bin/env node
/**
 * Regression pins for FM-CAL-DASHBOARD-LINK — the two affordances that
 * surface `SyncCalendarApplication` from outside the settings menu:
 *
 *   1. Dashboard Calendar tab → "Open Sync Calendar" button.
 *      - `templates/sync-dashboard.hbs` must contain a button with
 *        `data-action="open-sync-calendar"` inside the Calendar tab.
 *      - `scripts/sync-dashboard.mjs` must register the action handler
 *        on `DEFAULT_OPTIONS.actions['open-sync-calendar']`.
 *      - The handler must invoke `openSyncCalendar()` (the singleton
 *        helper exported from sync-calendar.mjs).
 *
 *   2. Scene-controls toolbar → `sync-calendar` tool.
 *      - `scripts/module.mjs` must register a `sync-calendar` tool
 *        inside the `chronicle-sync` scene-control group, with the
 *        `fa-calendar-days` icon and a callback that opens the app.
 *
 * These are static-source pins (string-grep on the source) — no Foundry
 * runtime is involved. They prevent silent removal of the discoverability
 * affordances; behavior testing is operator-side.
 *
 * Run: `node --test tools/test-sync-calendar-discoverability.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const dashboardTemplate = readFileSync(resolve(REPO_ROOT, 'templates/sync-dashboard.hbs'), 'utf8');
const dashboardScript   = readFileSync(resolve(REPO_ROOT, 'scripts/sync-dashboard.mjs'), 'utf8');
const moduleScript      = readFileSync(resolve(REPO_ROOT, 'scripts/module.mjs'), 'utf8');
const langJson          = JSON.parse(readFileSync(resolve(REPO_ROOT, 'lang/en.json'), 'utf8'));

// ---------------------------------------------------------------------
// (1) Dashboard Calendar tab button
// ---------------------------------------------------------------------

test('dashboard Calendar tab contains the Open Sync Calendar button', () => {
  // The button lives at the top of the data-tab="calendar" block.
  assert.match(
    dashboardTemplate,
    /data-tab="calendar"[\s\S]*?data-action="open-sync-calendar"/,
    'templates/sync-dashboard.hbs: <button data-action="open-sync-calendar"> must appear inside data-tab="calendar"',
  );
});

test('dashboard Calendar tab button references the OpenSyncCalendar i18n key', () => {
  assert.match(
    dashboardTemplate,
    /CHRONICLE\.Dashboard\.Calendar\.OpenSyncCalendar/,
    'templates/sync-dashboard.hbs must localize the button label via CHRONICLE.Dashboard.Calendar.OpenSyncCalendar',
  );
});

test('sync-dashboard.mjs registers the open-sync-calendar action', () => {
  assert.match(
    dashboardScript,
    /['"]open-sync-calendar['"]\s*:\s*SyncDashboard\.#onOpenSyncCalendarAction/,
    'scripts/sync-dashboard.mjs: DEFAULT_OPTIONS.actions must wire open-sync-calendar to SyncDashboard.#onOpenSyncCalendarAction',
  );
});

test('sync-dashboard.mjs imports the openSyncCalendar singleton helper', () => {
  assert.match(
    dashboardScript,
    /import\s+\{\s*openSyncCalendar\s*\}\s+from\s+['"]\.\/sync-calendar\.mjs['"]/,
    'scripts/sync-dashboard.mjs must import { openSyncCalendar } from ./sync-calendar.mjs',
  );
});

test('#onOpenSyncCalendarAction invokes openSyncCalendar()', () => {
  // Crude but specific: look for the handler body that calls the helper.
  const handlerMatch = /static\s+#onOpenSyncCalendarAction[\s\S]*?openSyncCalendar\s*\(\s*\)/.exec(dashboardScript);
  assert.ok(handlerMatch, 'scripts/sync-dashboard.mjs: #onOpenSyncCalendarAction must call openSyncCalendar()');
});

// ---------------------------------------------------------------------
// (2) Scene-control button
// ---------------------------------------------------------------------

test('module.mjs imports openSyncCalendar', () => {
  assert.match(
    moduleScript,
    /import\s+\{\s*openSyncCalendar\s*\}\s+from\s+['"]\.\/sync-calendar\.mjs['"]/,
    'scripts/module.mjs must import { openSyncCalendar } from ./sync-calendar.mjs',
  );
});

test('module.mjs registers a sync-calendar tool inside the chronicle-sync scene-control group', () => {
  // Must appear in BOTH the v12 array shape and the v13 object shape.
  // We check the tool name string twice — once per shape — anchored to
  // the calendar-days icon to avoid false positives if somebody adds an
  // unrelated tool with the same name elsewhere.
  const occurrences = moduleScript.match(/name:\s*['"]sync-calendar['"]/g) || [];
  assert.ok(
    occurrences.length >= 2,
    `scripts/module.mjs: expected sync-calendar tool registered in BOTH v12 array shape and v13 object shape; found ${occurrences.length} occurrence(s)`,
  );
  assert.match(
    moduleScript,
    /fa-solid fa-calendar-days/,
    'scripts/module.mjs: sync-calendar tool must use the fa-calendar-days icon',
  );
});

test('module.mjs scene-control sync-calendar tool is GM-gated', () => {
  // The `if (!game.user.isGM) return;` guard sits at the top of the
  // getSceneControlButtons hook — both tools (dashboard + sync-calendar)
  // inherit that guard. Pin the guard's presence so a future PR can't
  // remove it and accidentally expose the tool to players.
  assert.match(
    moduleScript,
    /Hooks\.on\(['"]getSceneControlButtons['"][\s\S]*?if\s*\(\s*!\s*game\.user\.isGM\s*\)\s*return/,
    'scripts/module.mjs: getSceneControlButtons hook must short-circuit for non-GMs (guards both dashboard and sync-calendar tools)',
  );
});

test('module.mjs scene-control button localizes its title via CHRONICLE.SceneControl.SyncCalendar', () => {
  assert.match(
    moduleScript,
    /CHRONICLE\.SceneControl\.SyncCalendar/,
    'scripts/module.mjs: scene-control title must use CHRONICLE.SceneControl.SyncCalendar',
  );
});

// ---------------------------------------------------------------------
// (3) i18n keys exist
// ---------------------------------------------------------------------

test('lang/en.json carries CHRONICLE.Dashboard.Calendar.OpenSyncCalendar', () => {
  const v = langJson?.CHRONICLE?.Dashboard?.Calendar?.OpenSyncCalendar;
  assert.equal(typeof v, 'string', 'CHRONICLE.Dashboard.Calendar.OpenSyncCalendar must be a string');
  assert.ok(v.length > 0);
});

test('lang/en.json carries CHRONICLE.Dashboard.Calendar.OpenSyncCalendarHint', () => {
  const v = langJson?.CHRONICLE?.Dashboard?.Calendar?.OpenSyncCalendarHint;
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
});

test('lang/en.json carries CHRONICLE.SceneControl.SyncCalendar', () => {
  const v = langJson?.CHRONICLE?.SceneControl?.SyncCalendar;
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
});
