#!/usr/bin/env node
/**
 * The calendar window opens large enough for Chronicle's calendar page (up to
 * a cap, never smaller than before) and draws it edge to edge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calendarWindowSize } from '../scripts/_calendar-window.mjs';

test('a first window fills most of a large screen, capped', () => {
  assert.deepEqual(calendarWindowSize(1920, 1080), { width: 1180, height: 880 });
  assert.deepEqual(calendarWindowSize(1280, 800), { width: 1180, height: 720 });
});

test('a small screen still gets the old size, never less', () => {
  assert.deepEqual(calendarWindowSize(700, 500), { width: 760, height: 640 });
  assert.deepEqual(calendarWindowSize(undefined, NaN), { width: 760, height: 640 });
});

test('the window draws the page edge to edge', async () => {
  const src = await readFile(new URL('../scripts/player-notebook.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles/chronicle-sync.css', import.meta.url), 'utf8');
  assert.match(src, /'chronicle-calendar-window', 'cs-borderless'/);
  assert.match(src, /calendarWindowSize\(window\.innerWidth, window\.innerHeight\), \.\.\.savedWindowPlace\(\)/);
  assert.match(css, /\.chronicle-calendar-window\.cs-borderless \.window-content \{ padding: 0;/);
});
