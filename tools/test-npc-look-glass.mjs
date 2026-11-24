#!/usr/bin/env node
/**
 * The arcane glass NPC look's ring figures: arcs spaced as the hero glass
 * spaces its recoveries, Interest in steps that never colour an unknown, and
 * hex glow that follows the characteristic and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ringArcs, interestRing, litHexes, npcLookContext } from '../scripts/_npc-look-glass.mjs';

test('ringArcs spaces one arc per state and lights the true ones', () => {
  const table = [
    [[], []],
    [undefined, []],
    [[true], [{ dash: '100 0', offset: 0, on: true }]],
    [[true, false], [{ dash: '47 53', offset: -1.5, on: true }, { dash: '47 53', offset: -51.5, on: false }]],
  ];
  for (const [input, want] of table) assert.deepEqual(ringArcs(input), want);
  const five = ringArcs([true, true, false, false, false]);
  assert.equal(five.length, 5);
  assert.deepEqual(five.map((a) => a.on), [true, true, false, false, false]);
  assert.equal(five[0].dash, '17 83');
  assert.equal(five[1].offset, -21.5);
});

test('interestRing steps by twenty and says none for an unknown Interest', () => {
  const table = [
    [null, { fill: 0, band: 'none' }],
    [{ interest: null }, { fill: 0, band: 'none' }],
    [{ interest: 0 }, { fill: 0, band: 'i0' }],
    [{ interest: 3 }, { fill: 60, band: 'i3' }],
    [{ interest: 5 }, { fill: 100, band: 'i5' }],
    [{ interest: 9 }, { fill: 100, band: 'i5' }],
    [{ interest: -2 }, { fill: 0, band: 'i0' }],
    [{ interest: '3' }, { fill: 0, band: 'none' }],
  ];
  for (const [input, want] of table) assert.deepEqual(interestRing(input), want);
});

test('litHexes glows with strength, to a full glow at +3', () => {
  assert.deepEqual(
    litHexes({ might: { value: -1 }, agility: { value: 0 }, reason: { value: 1 }, intuition: { value: 2 }, presence: { value: 5 } }),
    { might: 0, agility: 0, reason: 0.33, intuition: 0.67, presence: 1 },
  );
  assert.deepEqual(litHexes(null), {});
  assert.deepEqual(litHexes({ might: {} }), { might: 0 });
});

test('npcLookContext builds a monster from its marks and Stamina, and an NPC from its talk', () => {
  const monster = npcLookContext({
    villain: { marks: [{ state: 'used', name: 'War Cry' }, { state: 'next', name: 'Reinforcements' }, { state: 'unused', name: 'Gambit' }] },
    chronicle: { stamina: { windedAt: 50 } },
    negotiation: null,
  }, {}, { characteristics: { might: { value: 3 } } });
  assert.deepEqual(monster.vaArcs.map((a) => a.on), [false, true, true]);
  assert.equal(monster.nextVillain, 'Reinforcements');
  assert.equal(monster.windedOffset, -49.6);
  assert.deepEqual(monster.lit, { might: 1 });
  assert.deepEqual(monster.patienceArcs, []);

  const npc = npcLookContext({
    villain: { marks: [] },
    chronicle: { stamina: { windedAt: null } },
    negotiation: { interest: 3, patiencePips: [true, true, false, false, false] },
  }, {}, {});
  assert.deepEqual(npc.interest, { fill: 60, band: 'i3' });
  assert.deepEqual(npc.patienceArcs.map((a) => a.on), [true, true, false, false, false]);
  assert.equal(npc.windedOffset, null);
  assert.equal(npc.nextVillain, null);
  assert.deepEqual(npc.vaArcs, []);
});

test('npcLookContext survives a sheet whose figures failed to build', () => {
  const ctx = npcLookContext({ shape: 'npc', chronicle: {} }, undefined, undefined);
  assert.deepEqual(ctx.vaArcs, []);
  assert.deepEqual(ctx.interest, { fill: 0, band: 'none' });
  assert.deepEqual(ctx.lit, {});
});
