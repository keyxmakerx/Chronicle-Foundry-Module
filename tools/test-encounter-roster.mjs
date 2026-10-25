#!/usr/bin/env node
/**
 * Pins scripts/_encounter-roster.mjs: expanding planned creatures into
 * rows, reading each row's state from the scene's tokens, finding the actor,
 * laying tokens on free squares, and which tokens Show all and Undo touch.
 *
 * Run: `node --test tools/test-encounter-roster.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellToPoint, combatantHiddenUpdates, compendiumFallback, expandRows, groupLetters, hiddenTokenIds, layoutItems, occupiedCells,
  parseEncounter, pickCombat, placedTokenIds, placeHidden, pointToCell, resolveActor, rosterState,
  rowKey, startRows, tokenRef, trackerAdditions, trackerBadge,
} from '../scripts/_encounter-roster.mjs';

const wire = {
  id: 'e1',
  page: { id: 'p1', name: 'The Siege' },
  name: 'Ramparts fight',
  ready: true,
  heroes: [{ id: 'h1', name: 'Vex' }],
  creatures: [
    { id: 'c1', entityId: 'pg1', name: 'Goblin War Chief', count: 1, group: 'A', start: 'hidden' },
    { id: 'c2', entityId: 'pg2', name: 'Hobgoblin Soldier', count: 3, group: 'B', start: 'seen' },
    { id: 'c3', entityId: '', name: 'Skeleton Archer', count: 2, group: 'c', start: 'later' },
  ],
  version: 4,
};
const enc = parseEncounter(wire);
const rows = expandRows(enc.creatures);
const tok = (id, rowId, n, hidden, extra = {}) => ({ id, hidden, ref: { encounterId: 'e1', rowId, n }, ...extra });

test('a row with a count becomes one row per creature, named and keyed', () => {
  assert.deepEqual(rows.map((r) => r.name), [
    'Goblin War Chief', 'Hobgoblin Soldier 1', 'Hobgoblin Soldier 2', 'Hobgoblin Soldier 3', 'Skeleton Archer 1', 'Skeleton Archer 2',
  ]);
  assert.deepEqual(rows.map((r) => r.key), ['c1#1', 'c2#1', 'c2#2', 'c2#3', 'c3#1', 'c3#2']);
  assert.equal(rowKey('c2', 3), 'c2#3');
  assert.equal(rows[1].baseName, 'Hobgoblin Soldier');
  assert.equal(rows[1].group, 'B');
  assert.equal(rows[4].group, 'C');
});

test('odd plan data is made safe: unknown starts place nothing, counts and groups clamp', () => {
  const e = parseEncounter({ id: 'x', creatures: [
    { name: 'A', count: 0, group: 'Z', start: 'now' },
    { id: 'k', name: ' ', count: 9999, start: 'seen' },
    { id: 'm', name: 'M', count: 'many' },
  ] });
  assert.equal(e.creatures[0].count, 1);
  assert.equal(e.creatures[0].group, '');
  assert.equal(e.creatures[0].start, 'later');
  assert.equal(e.creatures[0].id, 'c0');
  assert.equal(e.creatures[1].count, 50);
  assert.equal(e.creatures[1].name, 'Creature');
  assert.equal(e.creatures[2].count, 1);
  assert.equal(parseEncounter({}), null);
  assert.deepEqual(parseEncounter({ id: 'y' }).creatures, []);
});

test('a token flag counts only when it is whole', () => {
  assert.deepEqual(tokenRef({ encounterId: 'e', rowId: 'r', n: 2, extra: 1 }), { encounterId: 'e', rowId: 'r', n: 2 });
  for (const bad of [null, 'x', {}, { encounterId: 'e', rowId: 'r' }, { encounterId: 'e', rowId: 'r', n: 0 }, { encounterId: 'e', rowId: 'r', n: 1.5 }, { encounterId: '', rowId: 'r', n: 1 }]) {
    assert.equal(tokenRef(bad), null);
  }
});

test('each row reads Not placed, Seen or Hidden from the scene', () => {
  const tokens = [tok('t1', 'c1', 1, true), tok('t2', 'c2', 1, false), tok('t9', 'c3', 1, false, { ref: null })];
  const state = rosterState('e1', rows, tokens);
  assert.deepEqual(state.map((r) => r.state), ['hidden', 'seen', 'out', 'out', 'out', 'out']);
  assert.equal(state[0].tokenId, 't1');
  assert.equal(state[2].tokenId, null);
});

test('another encounter\'s token, or an unflagged one, never marks a row placed', () => {
  const other = { id: 't3', hidden: false, ref: { encounterId: 'e2', rowId: 'c1', n: 1 } };
  assert.equal(rosterState('e1', rows, [other])[0].state, 'out');
});

test('a row with two tokens reads hidden if either is, so nothing looks safer than it is', () => {
  const state = rosterState('e1', rows, [tok('a', 'c1', 1, false), tok('b', 'c1', 1, true)]);
  assert.equal(state[0].state, 'hidden');
  assert.equal(state[0].tokenId, 'b');
});

test('Set up the start places seen and hidden rows that are not on the scene, never later ones', () => {
  const state = rosterState('e1', rows, [tok('t2', 'c2', 1, false)]);
  assert.deepEqual(startRows(state).map((r) => r.key), ['c1#1', 'c2#2', 'c2#3']);
  assert.equal(placeHidden(rows[0]), true);
  assert.equal(placeHidden(rows[1]), false);
  assert.equal(placeHidden(rows[4]), true);
});

test('Show all hidden and Undo touch only this encounter\'s tokens', () => {
  const tokens = [
    tok('a', 'c1', 1, true), tok('b', 'c2', 1, false), tok('c', 'c3', 1, true),
    { id: 'd', hidden: true, ref: null },
    { id: 'e', hidden: true, ref: { encounterId: 'e2', rowId: 'c1', n: 1 } },
  ];
  assert.deepEqual(hiddenTokenIds('e1', tokens), ['a', 'c']);
  assert.deepEqual(placedTokenIds('e1', tokens), ['a', 'b', 'c']);
  assert.deepEqual(hiddenTokenIds('none', tokens), []);
});

const actors = [
  { id: 'a1', name: 'Hobgoblin Soldier', inCreatureFolder: false },
  { id: 'a2', name: 'hobgoblin soldier ', inCreatureFolder: true },
  { id: 'a3', name: 'Renamed in Foundry', linkedEntityId: 'pg2', inCreatureFolder: true },
  { id: 'a4', name: 'Skeleton Archer', inCreatureFolder: false },
];

test('the actor is the one creature sync linked, then the folder\'s by name, then any by name', () => {
  assert.deepEqual(resolveActor(rows[1], actors), { actor: actors[2], via: 'linked' });
  assert.deepEqual(resolveActor({ entityId: 'zz', baseName: 'Hobgoblin Soldier' }, actors), { actor: actors[1], via: 'folder' });
  assert.deepEqual(resolveActor(rows[4], actors), { actor: actors[3], via: 'name' });
  assert.equal(resolveActor(rows[0], actors), null);
  assert.equal(resolveActor({ entityId: '', baseName: '' }, actors), null);
});

const grid = { size: 100, originX: 50, originY: 50 };

test('points and cells convert both ways', () => {
  assert.deepEqual(pointToCell(249, 50, grid), { i: 1, j: 0 });
  assert.deepEqual(pointToCell(40, 40, grid), { i: -1, j: -1 });
  assert.deepEqual(cellToPoint(2, 3, grid), { x: 250, y: 350 });
});

test('occupied cells cover every square a larger token stands on', () => {
  const set = occupiedCells([{ x: 150, y: 50, width: 2, height: 2 }, { x: 50, y: 50 }], grid);
  assert.deepEqual([...set].sort(), ['0,0', '1,0', '1,1', '2,0', '2,1'].sort());
});

test('tokens land on free squares nearest the click, without overlapping', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key }));
  const { placements, unplaced } = layoutItems(items, { i: 5, j: 5 }, { occupied: new Set(['5,5']) });
  assert.deepEqual(unplaced, []);
  assert.equal(placements.length, 5);
  const cells = placements.map((p) => `${p.i},${p.j}`);
  assert.equal(new Set(cells).size, 5);
  assert.ok(!cells.includes('5,5'));
  for (const p of placements) assert.ok(Math.max(Math.abs(p.i - 5), Math.abs(p.j - 5)) <= 1);
  assert.deepEqual(placements.map((p) => p.key), ['a', 'b', 'c', 'd', 'e']);
});

test('a large token takes its whole footprint and goes first', () => {
  const { placements } = layoutItems([{ key: 's' }, { key: 'big', w: 2, h: 2 }], { i: 0, j: 0 });
  const big = placements.find((p) => p.key === 'big');
  const small = placements.find((p) => p.key === 's');
  assert.deepEqual({ i: big.i, j: big.j }, { i: 0, j: 0 });
  const covered = new Set([[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => `${i},${j}`));
  assert.ok(!covered.has(`${small.i},${small.j}`));
});

test('bounds keep tokens on the scene and what cannot fit is reported', () => {
  const bounds = { minI: 0, minJ: 0, maxI: 1, maxJ: 0 };
  const { placements, unplaced } = layoutItems([{ key: 'a' }, { key: 'b' }, { key: 'c' }], { i: 0, j: 0 }, { bounds });
  assert.deepEqual(placements.map((p) => p.key), ['a', 'b']);
  assert.deepEqual(unplaced, ['c']);
});

test('layout is the same every time', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.deepEqual(layoutItems(items, { i: 3, j: 3 }), layoutItems(items, { i: 3, j: 3 }));
});

test('the tracker uses an unstarted combat, only offers a started one, else makes a new one', () => {
  assert.deepEqual(pickCombat([]), { kind: 'new' });
  assert.deepEqual(pickCombat([{ id: 'x', started: true }]), { kind: 'ask', id: 'x' });
  assert.deepEqual(pickCombat([{ id: 'x', started: true }, { id: 'y', started: false }]), { kind: 'add', id: 'y' });
});

test('only placed rows join the tracker, hidden ones hidden, and none twice', () => {
  const state = rosterState('e1', rows, [tok('t1', 'c1', 1, true), tok('t2', 'c2', 1, false), tok('t3', 'c2', 2, false)]);
  const add = trackerAdditions(state, new Set(['t3']));
  assert.deepEqual(add.map((a) => [a.key, a.tokenId, a.hidden, a.group]), [['c1#1', 't1', true, 'A'], ['c2#1', 't2', false, 'B']]);
  assert.deepEqual(groupLetters(add), ['A', 'B']);
  assert.deepEqual(groupLetters([{ group: '' }]), []);
});

test('rows not on the scene read Pending only once the fight is in the tracker', () => {
  const state = rosterState('e1', rows, [tok('t1', 'c1', 1, true), tok('t2', 'c2', 1, false)]);
  const inCombat = new Set(['t1']);
  assert.equal(trackerBadge(state[0], { trackerOn: true, inCombat }), 'in');
  assert.equal(trackerBadge(state[1], { trackerOn: true, inCombat }), 'notIn');
  assert.equal(trackerBadge(state[2], { trackerOn: true, inCombat }), 'pending');
  assert.equal(trackerBadge(state[2], { trackerOn: false, inCombat }), '');
});

test('a combatant follows its token\'s hidden flag, and nothing is written when they agree', () => {
  assert.deepEqual(combatantHiddenUpdates(true, [{ id: 'k1', hidden: false }, { id: 'k2', hidden: true }]), [{ _id: 'k1', hidden: true }]);
  assert.deepEqual(combatantHiddenUpdates(false, [{ id: 'k1', hidden: false }]), []);
  assert.deepEqual(combatantHiddenUpdates(false, [{ id: 'k1', hidden: true }]), [{ _id: 'k1', hidden: false }]);
  assert.deepEqual(combatantHiddenUpdates(true, []), []);
});

test('a row no world actor answers falls back on a compendium entry by name, the first listed winning', () => {
  const entries = [
    { name: 'Skeleton Archer', uuid: 'u1', pack: 'Monsters' },
    { name: 'skeleton archer', uuid: 'u2', pack: 'Homebrew' },
  ];
  assert.deepEqual(compendiumFallback({ baseName: ' Skeleton ARCHER ' }, entries), entries[0]);
  assert.equal(compendiumFallback({ baseName: 'Wyrm' }, entries), null);
  assert.equal(compendiumFallback({ baseName: '' }, entries), null);
  assert.equal(compendiumFallback({ baseName: 'Skeleton Archer' }, undefined), null);
});
