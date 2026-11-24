#!/usr/bin/env node
/**
 * The gilded card's figures for the NPC and monster sheet: the Interest dial
 * never shows a value the sheet doesn't know, the winded mark sits where the
 * Stamina bar's does, Malice is a track of ten, and the coin metals follow
 * the characteristics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dialPoint, interestDial, maliceCoins, npcLookContext, windedMark } from '../scripts/_npc-look-gilded.mjs';

test('the Interest dial fills a fifth a point, and is empty and bandless when unknown', () => {
  const cases = [
    [0, { fill: 0, band: 'i0' }],
    [3, { fill: 60, band: 'i3' }],
    [5, { fill: 100, band: 'i5' }],
    [9, { fill: 100, band: 'i5' }],
    [-2, { fill: 0, band: 'i0' }],
    [null, { fill: 0, band: 'none' }],
    [undefined, { fill: 0, band: 'none' }],
    ['3', { fill: 0, band: 'none' }],
  ];
  for (const [input, want] of cases) assert.deepEqual(interestDial(input), want, String(input));
});

test('Malice is a track of ten, lit up to the number', () => {
  const lit = (v) => maliceCoins(v).filter(Boolean).length;
  assert.equal(maliceCoins(7).length, 10);
  for (const [v, want] of [[0, 0], [7, 7], [10, 10], [25, 10], [null, 0], [-3, 0], [2.9, 2]]) assert.equal(lit(v), want, String(v));
});

test('the dial\'s points run from the left foot over the top to the right foot', () => {
  assert.deepEqual(dialPoint(0, 120), { x: 30, y: 150 });
  assert.deepEqual(dialPoint(0.5, 120), { x: 150, y: 30 });
  assert.deepEqual(dialPoint(1, 120), { x: 270, y: 150 });
});

test('the winded mark follows the bar, and is absent without a winded point', () => {
  assert.deepEqual(windedMark(50), { x1: 150, y1: 45, x2: 150, y2: 15, gx: 150, gy: 3 });
  const early = windedMark(25);
  assert.ok(early.x1 < 150 && early.x2 < 150, 'a quarter of the way is left of the top');
  for (const none of [null, undefined, 0, 100, 140, '50']) assert.equal(windedMark(none), null, String(none));
});

test('the context holds the metals, Malice, the Interest dial and the winded mark', () => {
  const npc = {
    negotiation: { interest: 3 },
    malice: { value: 4 },
    chronicle: { stamina: { windedAt: 50 } },
  };
  const env = { characteristics: { might: { value: -1 }, agility: { value: 0 }, reason: { value: 1 }, intuition: { value: 2 }, presence: { value: 3 } } };
  const ctx = npcLookContext(npc, {}, env);
  assert.deepEqual(ctx.metals, { might: 'iron', agility: 'iron', reason: 'bronze', intuition: 'gold', presence: 'gold' });
  assert.equal(ctx.interestFill, 60);
  assert.equal(ctx.interestBand, 'i3');
  assert.equal(ctx.malicePips.filter(Boolean).length, 4);
  assert.equal(ctx.windedMark.gx, 150);
});

test('a sheet with no negotiation, Malice or characteristics gets empty figures', () => {
  for (const npc of [{ negotiation: null }, {}, null]) {
    const ctx = npcLookContext(npc, {}, {});
    assert.deepEqual(ctx.metals, {});
    assert.equal(ctx.interestFill, 0);
    assert.equal(ctx.interestBand, 'none');
    assert.equal(ctx.malicePips.filter(Boolean).length, 0);
    assert.equal(ctx.windedMark, null);
  }
});
