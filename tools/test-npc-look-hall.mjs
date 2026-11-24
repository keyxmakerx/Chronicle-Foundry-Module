#!/usr/bin/env node
/**
 * The portrait hall's figures for the NPC and monster sheet: the inner arcs
 * match the hero's recovery arcs, the Interest ring never shows a value the
 * sheet doesn't know, and the plaque metals follow the characteristics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { arcs, interestRing, maliceDiamonds, npcLookContext } from '../scripts/_npc-look-hall.mjs';
import { ringSegments } from '../scripts/_hero-looks.mjs';

test('inner arcs are the hero\'s recovery arcs for the same count', () => {
  for (const [value, max] of [[3, 3], [2, 5], [0, 4], [1, 1]]) {
    const flags = Array.from({ length: max }, (_, i) => i < value);
    assert.deepEqual(arcs(flags), ringSegments(value, max));
  }
  assert.deepEqual(arcs([]), []);
});

test('the Interest ring fills a fifth a point, and is empty and bandless when unknown', () => {
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
  for (const [input, want] of cases) assert.deepEqual(interestRing(input), want, String(input));
});

test('Malice is a track of ten, lit up to the number', () => {
  const lit = (v) => maliceDiamonds(v).filter(Boolean).length;
  assert.equal(maliceDiamonds(7).length, 10);
  for (const [v, want] of [[0, 0], [7, 7], [10, 10], [25, 10], [null, 0], [-3, 0], [2.9, 2]]) assert.equal(lit(v), want, String(v));
});

test('the context holds the metals, the arcs and the next villain action', () => {
  const npc = {
    negotiation: { interest: 3, patience: 2, patiencePips: [true, true, false, false, false] },
    villain: { marks: [{ id: 'a', name: 'War Cry', order: 1, state: 'used' }, { id: 'b', name: 'Reinforcements', order: 2, state: 'next' }, { id: 'c', name: 'Gambit', order: 3, state: 'unused' }] },
    malice: { value: 4 },
  };
  const env = { characteristics: { might: { value: -1 }, agility: { value: 0 }, reason: { value: 1 }, intuition: { value: 2 }, presence: { value: 3 } } };
  const ctx = npcLookContext(npc, {}, env);
  assert.deepEqual(ctx.metals, { might: 'iron', agility: 'iron', reason: 'bronze', intuition: 'gold', presence: 'gold' });
  assert.deepEqual(ctx.interest, { fill: 60, band: 'i3' });
  assert.deepEqual(ctx.patienceArcs.map((a) => a.on), [true, true, false, false, false]);
  assert.deepEqual(ctx.villainArcs.map((a) => a.on), [false, true, true]);
  assert.deepEqual(ctx.villainNext, { order: 2, name: 'Reinforcements' });
  assert.equal(ctx.maliceDiamonds.filter(Boolean).length, 4);
});

test('a sheet with no negotiation, marks or characteristics gets empty figures', () => {
  for (const npc of [{ negotiation: null, villain: { marks: [] } }, {}, null]) {
    const ctx = npcLookContext(npc, {}, {});
    assert.deepEqual(ctx.metals, {});
    assert.deepEqual(ctx.patienceArcs, []);
    assert.deepEqual(ctx.villainArcs, []);
    assert.equal(ctx.villainNext, null);
    assert.deepEqual(ctx.interest, { fill: 0, band: 'none' });
  }
});
