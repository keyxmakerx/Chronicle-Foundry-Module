#!/usr/bin/env node
/**
 * The motion levels: reduced-motion people start on Calm, unknown values
 * play as Full, and a window grows from the press that opened it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultMotion, growOrigin, motionLevel } from '../scripts/_motion.mjs';

const css = readFileSync(new URL('../styles/chronicle-sync.css', import.meta.url), 'utf8');

test('reduced motion starts on Calm, otherwise Full', () => {
  assert.equal(defaultMotion(true), 'calm');
  assert.equal(defaultMotion(false), 'full');
});

test('unknown saved values play as Full', () => {
  for (const v of ['full', 'calm', 'off']) assert.equal(motionLevel(v), v);
  assert.equal(motionLevel(undefined), 'full');
  assert.equal(motionLevel('wild'), 'full');
});

test('a window grows from a recent press, clamped inside it', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  assert.equal(growOrigin({ x: 150, y: 60, at: 1000 }, rect, 1200), '50px 10px');
  assert.equal(growOrigin({ x: 10, y: 900, at: 1000 }, rect, 1200), '0px 300px');
  assert.equal(growOrigin({ x: 150, y: 60, at: 1000 }, rect, 2000), null);
  assert.equal(growOrigin(null, rect, 0), null);
});

test('Calm swaps every move for a fade and Off stops them', () => {
  for (const cls of ['cs-grow', 'cs-settle', 'cs-peek']) {
    assert.match(css, new RegExp(`\\[data-cs-motion="calm"\\][^{]*\\.${cls}`), `calm ${cls}`);
    assert.match(css, new RegExp(`\\[data-cs-motion="off"\\][^{]*\\.${cls}`), `off ${cls}`);
  }
});

test('the reduced-motion rule reaches only Chronicle\'s own windows', () => {
  assert.doesNotMatch(css, /prefers-reduced-motion: reduce\)\s*\{\s*\*,/);
});
