#!/usr/bin/env node
/** Pins the night sky NPC look's figures (scripts/_npc-look-sky.mjs): the rings, the motive stars and lines, the villain arc. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  MAX_STARS, MOTIVE_PLACES, interestBand, motiveConstellation, npcLookContext, ringArcs, villainArc, windedMark,
} from '../scripts/_npc-look-sky.mjs';
import { STAR_PLACES, constellation } from '../scripts/_hero-look-sky.mjs';

const row = (key, kind = 'motivation', state = 'found') => ({ key, label: key, kind, state });
const rows = (n, state = 'found') => Array.from({ length: n }, (_, i) => row(`m${i}`, 'motivation', state));

test('the first five places are the characteristics\' places, so the pattern reads the same on every sheet', () => {
  assert.deepEqual(MOTIVE_PLACES.slice(0, 5), Object.values(STAR_PLACES));
  assert.equal(MAX_STARS, MOTIVE_PLACES.length);
});

test('the inner arcs are lit where the flag is, on a circle of 100, with a gap between them', () => {
  assert.deepEqual(ringArcs([]), []);
  const arcs = ringArcs([true, true, false, false, false]);
  assert.deepEqual(arcs.map((a) => a.on), [true, true, false, false, false]);
  assert.equal(arcs.length, 5);
  assert.equal(arcs[0].dash, '17 83');
  assert.ok(arcs.every((a, i) => i === 0 || a.offset < arcs[i - 1].offset), 'each arc starts further round');
  assert.deepEqual(ringArcs([true]).map((a) => a.dash), ['100 0']);
});

test('the winded mark sits across the track at the point, and is absent where it would not show', () => {
  for (const at of [null, undefined, 0, 100, 150, 'x']) assert.equal(windedMark(at), null, String(at));
  const half = windedMark(50);
  assert.ok(Math.abs(half.x1 - 170) < 0.2 && Math.abs(half.x2 - 170) < 0.2, 'half way round is straight below the centre');
  assert.ok(half.y1 > 170 && half.y2 > half.y1);
  const quarter = windedMark(25);
  assert.ok(quarter.x1 > 170 && Math.abs(quarter.y1 - 170) < 0.2, 'a quarter round is straight right of the centre');
});

test('Interest sets one band for the ring, the number and the answer', () => {
  for (const [interest, band] of [[0, 'i0'], [3, 'i3'], [5, 'i5'], [7, 'i5'], [-2, 'i0'], [3.9, 'i3'], ['4', 'i4'], [null, 'none'], [undefined, 'none'], ['', 'none']]) {
    assert.equal(interestBand(interest), band, String(interest));
  }
});

test('a short list spreads across the sky, one star each, at a known place', () => {
  const xs = (n) => motiveConstellation(rows(n)).stars.map((s) => s.x);
  assert.deepEqual(xs(0), []);
  assert.deepEqual(xs(1), [330]);
  assert.deepEqual(xs(2), [190, 450]);
  assert.deepEqual(xs(3), [70, 330, 520]);
  assert.deepEqual(xs(5), [70, 190, 330, 450, 520]);
});

test('every row keeps its own key, words and state on its star', () => {
  const { stars } = motiveConstellation([row('greed', 'motivation', 'found'), row('freedom', 'pitfall', 'hidden')]);
  assert.deepEqual(stars.map((s) => [s.key, s.kind, s.state, s.i]), [['greed', 'motivation', 'found', 0], ['freedom', 'pitfall', 'hidden', 1]]);
});

test('the full five are joined as the hero\'s five characteristics are, with the loop closed', () => {
  const { links, ghosts } = motiveConstellation(rows(5));
  assert.deepEqual(links.map((l) => l.d), [
    'M70 150L190 60', 'M190 60L330 120', 'M330 120L450 40', 'M450 40L520 170', 'M330 120L520 170',
  ]);
  assert.deepEqual(ghosts.map((g) => g.d), links.map((l) => l.d));
  assert.deepEqual(links.map((l) => l.i), [0, 1, 2, 3, 4]);
});

test('a line is veiled until both of its stars are found', () => {
  const states = ['found', 'hidden', 'found', 'used', 'found'];
  const { links } = motiveConstellation(states.map((state, i) => row(`m${i}`, 'motivation', state)));
  assert.deepEqual(links.map((l) => l.veiled), [true, true, false, false, false]);
  assert.ok(motiveConstellation(rows(5, 'found')).links.every((l) => !l.veiled));
});

test('more than five stars hang from the nearest earlier star, and past the seventh the rest are listed', () => {
  const seven = motiveConstellation(rows(7));
  assert.equal(seven.stars.length, 7);
  assert.equal(seven.links.length, 7);
  assert.deepEqual(seven.more, []);
  const nine = motiveConstellation(rows(9));
  assert.equal(nine.stars.length, MAX_STARS);
  assert.deepEqual(nine.more.map((r) => r.key), ['m7', 'm8']);
  // Every row is somewhere: no hidden row is dropped.
  assert.equal(nine.stars.length + nine.more.length, 9);
});

test('the stars stay inside the drawing space, halo and all', () => {
  const { stars } = motiveConstellation(rows(MAX_STARS));
  for (const s of stars) assert.ok(s.x - s.halo >= 0 && s.x + s.halo <= 590 && s.y - s.halo >= -4 && s.y + s.halo <= 240, s.key);
});

test('odd input still gives a constellation', () => {
  for (const input of [undefined, null, [], 'x', [null, undefined, 3]]) {
    const c = motiveConstellation(input);
    assert.deepEqual(c.stars, []);
    assert.deepEqual(c.links, []);
  }
});

test('the villain stars sit on an arc, each in its own place, and the next one is named', () => {
  const marks = [{ id: 'a', name: 'War Cry', order: 1, state: 'used' }, { id: 'b', name: 'Reinforcements', order: 2, state: 'next' }, { id: 'c', name: 'Gambit', order: 3, state: 'unused' }];
  const arc = villainArc(marks);
  assert.deepEqual(arc.places.map((p) => p.x), [20, 50, 80]);
  assert.ok(arc.places[1].y > arc.places[0].y, 'the middle star hangs lowest');
  assert.equal(arc.places[0].y, arc.places[2].y);
  assert.deepEqual(arc.next, { name: 'Reinforcements', order: 2 });
  assert.equal(arc.labelWidth, 96);
  assert.match(arc.arc, /^M-?\d+ -?\d+A205 205 0 0 0 -?\d+ -?\d+$/);
  assert.equal(villainArc([{ id: 'a', name: 'x', order: 1, state: 'used' }]).next, null);
  assert.deepEqual(villainArc([]).places, []);
  assert.deepEqual(villainArc(undefined).places, []);
});

test('more villain actions than three narrow their labels so they do not run together', () => {
  const marks = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: 'x', order: i + 1, state: 'unused' }));
  const arc = villainArc(marks);
  assert.equal(arc.places.length, 6);
  assert.ok(arc.labelWidth < 96 && arc.labelWidth >= 52);
});

const npcFigures = (extra = {}) => ({
  shape: 'npc',
  chronicle: { stamina: { band: 'unknown', fill: 0, windedAt: null } },
  negotiation: { interest: 3, patience: 2, rows: [row('greed'), row('freedom', 'pitfall', 'hidden')] },
  villain: { marks: [], total: 0 },
  ...extra,
});

test('an NPC\'s ring is Interest, with Patience as the arcs inside it', () => {
  const look = npcLookContext(npcFigures(), {}, { characteristics: {} });
  assert.equal(look.ring.fill, 60);
  assert.deepEqual(look.ring.segs.map((s) => s.on), [true, true, false, false, false]);
  assert.equal(look.ring.winded, null);
  assert.equal(look.band, 'i3');
  assert.equal(look.known, true);
  assert.equal(look.motives.stars.length, 2);
});

test('an NPC whose meters are not shown has an empty ring, not Draw Steel\'s starting values', () => {
  const look = npcLookContext(npcFigures({ negotiation: { interest: null, patience: null, rows: [] } }), {}, {});
  assert.equal(look.ring.fill, 0);
  assert.ok(look.ring.segs.every((s) => !s.on));
  assert.equal(look.band, 'none');
  assert.equal(look.known, false);
});

test('a monster\'s ring is Stamina with the winded point, and the villain actions are the arcs', () => {
  const marks = [{ id: 'a', name: 'A', order: 1, state: 'used' }, { id: 'b', name: 'B', order: 2, state: 'next' }, { id: 'c', name: 'C', order: 3, state: 'unused' }];
  const look = npcLookContext({
    shape: 'monster', chronicle: { stamina: { band: 'healthy', fill: 70, windedAt: 50 } }, negotiation: null, villain: { marks },
  }, {}, { characteristics: { might: { value: 2 } } });
  assert.equal(look.ring.fill, 70);
  assert.ok(look.ring.winded);
  assert.deepEqual(look.ring.segs.map((s) => s.on), [false, true, true]);
  assert.deepEqual(look.motives.stars, []);
  assert.equal(look.constellation.stars.might.tier, 2);
});

test('the monster\'s constellation is the hero\'s own, not a copy of it', () => {
  const characteristics = { might: { value: -1 }, agility: { value: 0 }, reason: { value: 1 }, intuition: { value: 1 }, presence: { value: 3 } };
  const look = npcLookContext({ shape: 'monster', chronicle: {}, villain: { marks: [] } }, {}, { characteristics });
  assert.deepEqual(look.constellation, constellation(characteristics));
});

test('a sheet whose figures failed to build still gets figures that draw', () => {
  for (const npc of [undefined, null, {}, { shape: 'monster' }, { shape: 'npc', negotiation: null }]) {
    const look = npcLookContext(npc, undefined, undefined);
    assert.ok(look.ring && look.motives && look.villain && look.constellation, JSON.stringify(npc));
    assert.deepEqual(Object.keys(look.constellation.stars), ['might', 'agility', 'reason', 'intuition', 'presence']);
  }
});

test('the module is pure: it reads no Foundry global', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/_npc-look-sky.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /\b(game|ui|canvas|foundry|CONFIG|ds|Hooks)\./);
});
