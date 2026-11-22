#!/usr/bin/env node
/** Pins the night sky look's figures (scripts/_hero-look-sky.mjs): the constellation's stars and lines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTELLATION_BOX, MAX_TIER, MOVE_MS, STAR_LINKS, STAR_PLACES, constellation, lookContext, starPath, starTier,
} from '../scripts/_hero-look-sky.mjs';

const KEYS = ['might', 'agility', 'reason', 'intuition', 'presence'];

test('a star\'s size step follows the value, held between 0 and the biggest', () => {
  for (const [value, tier] of [[-2, 0], [-1, 0], [0, 0], [1, 1], [2, 2], [3, 3], [5, MAX_TIER], ['2', 2], [null, 0], [undefined, 0], ['', 0], [1.9, 1], [NaN, 0]]) {
    assert.equal(starTier(value), tier, String(value));
  }
});

test('the star outline grows with its step and stays centred on the origin', () => {
  assert.equal(starPath(0), 'M0 -7L2 -2L7 0L2 2L0 7L-2 2L-7 0L-2 -2Z');
  assert.equal(starPath(2), 'M0 -15L4 -4L15 0L4 4L0 15L-4 4L-15 0L-4 -4Z');
  const reach = (d) => Math.max(...[...d.matchAll(/-?\d+/g)].map((m) => Math.abs(Number(m[0]))));
  assert.ok(reach(starPath(0)) < reach(starPath(1)) && reach(starPath(1)) < reach(starPath(3)));
});

test('every characteristic has a fixed place that does not depend on its value', () => {
  assert.deepEqual(Object.keys(STAR_PLACES), KEYS);
  const low = constellation({ might: { value: -1 }, agility: { value: 0 } });
  const high = constellation({ might: { value: 4 }, agility: { value: 4 } });
  for (const key of KEYS) {
    assert.deepEqual([low.stars[key].x, low.stars[key].y], STAR_PLACES[key], key);
    assert.deepEqual([high.stars[key].x, high.stars[key].y], STAR_PLACES[key], key);
  }
  assert.ok(high.stars.might.halo > low.stars.might.halo);
});

test('the signed hero\'s stars are the signed sizes', () => {
  const c = constellation({ might: { value: 1 }, agility: { value: 2 }, reason: { value: 0 }, intuition: { value: 1 }, presence: { value: 1 } });
  assert.deepEqual(KEYS.map((k) => c.stars[k].tier), [1, 2, 0, 1, 1]);
});

test('a hero with missing or odd characteristics still gets all five stars', () => {
  for (const input of [undefined, null, {}, { might: null }, { might: { value: 'x' } }]) {
    const c = constellation(input);
    assert.deepEqual(Object.keys(c.stars), KEYS);
    assert.equal(c.stars.might.tier, 0);
  }
});

test('the stars stay inside the drawing space, halo and all', () => {
  const { width, height } = CONSTELLATION_BOX;
  const c = constellation(Object.fromEntries(KEYS.map((k) => [k, { value: 9 }])));
  for (const key of KEYS) {
    const s = c.stars[key];
    assert.ok(s.x - s.halo >= 0 && s.x + s.halo <= width, `${key} across`);
    // The top of the biggest halo may rise a little past the box; the SVG leaves its edge open.
    assert.ok(s.y - s.halo >= -4 && s.y + s.halo <= height, `${key} down`);
  }
});

test('the lines join the stars as signed, in drawing order', () => {
  const { links } = constellation({});
  assert.equal(links.length, STAR_LINKS.length);
  assert.deepEqual(links.map((l) => l.i), [0, 1, 2, 3, 4]);
  assert.equal(links[0].d, 'M70 150L190 60');
  assert.equal(links[4].d, 'M330 120L520 170');
});

test('the context is the constellation, read from Draw Steel\'s characteristics', () => {
  const ctx = lookContext({ characteristics: { might: { value: 3 } } }, {});
  assert.deepEqual(Object.keys(ctx), ['constellation']);
  assert.equal(ctx.constellation.stars.might.tier, 3);
  assert.deepEqual(Object.keys(lookContext(undefined, {}).constellation.stars), KEYS);
});

test('the look\'s move timings stay under the 4 second ceiling', () => {
  for (const [move, ms] of Object.entries(MOVE_MS)) assert.ok(ms > 0 && ms <= 4000, move);
});
