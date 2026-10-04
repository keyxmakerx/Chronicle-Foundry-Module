#!/usr/bin/env node
/** Pins where the movable jot tab and panel go (scripts/_jot-placement.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampBox,
  panelBesideTab,
  parsePlacement,
  pastThreshold,
  withPlacement,
} from '../scripts/_jot-placement.mjs';

const screen = { width: 1600, height: 900 };

test('a small wobble on a click is not a drag', () => {
  assert.equal(pastThreshold(1, 2), false);
  assert.equal(pastThreshold(3, 3), true);
  assert.equal(pastThreshold(0, -10), true);
});

test('a bad or missing saved value means not moved', () => {
  for (const raw of ['', '{}', 'not json', 'null', '{"tab":{"left":"x","top":1}}', '{"panel":5}']) {
    assert.deepEqual(parsePlacement(raw), { tab: null, panel: null }, raw);
  }
});

test('saving one part keeps the other', () => {
  let raw = withPlacement('{}', 'tab', { left: 100.4, top: 850 });
  raw = withPlacement(raw, 'panel', { left: 20, top: 30 });
  assert.deepEqual(parsePlacement(raw), { tab: { left: 100, top: 850 }, panel: { left: 20, top: 30 } });
  raw = withPlacement(raw, 'panel', null);
  assert.deepEqual(parsePlacement(raw), { tab: { left: 100, top: 850 }, panel: null });
});

test('boxes stay fully on screen', () => {
  const size = { width: 360, height: 520 };
  assert.deepEqual(clampBox({ left: -50, top: -10 }, size, screen), { left: 0, top: 0 });
  assert.deepEqual(clampBox({ left: 1500, top: 800 }, size, screen), { left: 1240, top: 380 });
  assert.deepEqual(clampBox({ left: 300, top: 200 }, size, screen), { left: 300, top: 200 });
  // A box bigger than the screen pins to the top-left so its handle shows.
  assert.deepEqual(clampBox({ left: 10, top: 10 }, { width: 2000, height: 1000 }, screen), { left: 0, top: 0 });
});

test('an unmoved panel opens above the tab, or below it near the top', () => {
  const size = { width: 360, height: 520 };
  const low = { left: 1200, top: 872, width: 100, height: 28 };
  assert.deepEqual(panelBesideTab(low, size, screen), { left: 940, top: 348 });
  const high = { left: 10, top: 20, width: 100, height: 28 };
  assert.deepEqual(panelBesideTab(high, size, screen), { left: 0, top: 52 });
});
