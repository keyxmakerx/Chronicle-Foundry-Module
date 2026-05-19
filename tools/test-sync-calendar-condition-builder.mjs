#!/usr/bin/env node
/**
 * Unit tests for the conditionTree pure builder.
 *
 * Run: `node --test tools/test-sync-calendar-condition-builder.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELDS,
  OPERATORS,
  GROUP_MODES,
  PRESETS,
  emptyRootGroup,
  leaf,
  treeFromPreset,
  validateTree,
  treeToSummary,
} from '../scripts/sync-calendar-condition-builder.mjs';

// ---------------------------------------------------------------------
// Constants / enums
// ---------------------------------------------------------------------

test('FIELDS, OPERATORS, GROUP_MODES, PRESETS are frozen enums', () => {
  assert.ok(Object.isFrozen(FIELDS));
  assert.ok(Object.isFrozen(OPERATORS));
  assert.ok(Object.isFrozen(GROUP_MODES));
  assert.ok(Object.isFrozen(PRESETS));
});

test('OPERATORS covers v1 scope: ==, !=, %, in', () => {
  assert.deepEqual(
    Object.values(OPERATORS).sort(),
    ['!=', '%', '==', 'in'],
  );
});

test('FIELDS covers v1 scope: weekday, monthDay, month, year, season, moonPhase, cycleStage', () => {
  assert.deepEqual(
    new Set(Object.values(FIELDS)),
    new Set(['weekday', 'monthDay', 'month', 'year', 'season', 'moonPhase', 'cycleStage']),
  );
});

// ---------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------

test('emptyRootGroup returns a valid empty AND root', () => {
  const t = emptyRootGroup();
  assert.equal(t.type, 'group');
  assert.equal(t.mode, 'and');
  assert.deepEqual(t.children, []);
});

test('emptyRootGroup accepts an OR mode', () => {
  const t = emptyRootGroup(GROUP_MODES.OR);
  assert.equal(t.mode, 'or');
});

test('leaf produces a 3-key condition without value2 by default', () => {
  const l = leaf('weekday', '==', 5);
  assert.deepEqual(l, { type: 'condition', field: 'weekday', op: '==', value: 5 });
});

test('leaf with value2 carries the secondary operand', () => {
  const l = leaf('moonPhase', '==', 0.5, 0);
  assert.equal(l.value2, 0);
});

// ---------------------------------------------------------------------
// treeFromPreset — happy paths (one per preset)
// ---------------------------------------------------------------------

test('preset: every weekday (3rd of the week)', () => {
  const t = treeFromPreset(PRESETS.EVERY_WEEKDAY, { weekdayOrdinal: 3 });
  assert.deepEqual(t, {
    type: 'group',
    mode: 'and',
    children: [{ type: 'condition', field: 'weekday', op: '==', value: 3 }],
  });
});

test('preset: every 15th of every month', () => {
  const t = treeFromPreset(PRESETS.EVERY_NTH_OF_MONTH, { monthDay: 15 });
  assert.deepEqual(t.children, [
    { type: 'condition', field: 'monthDay', op: '==', value: 15 },
  ]);
});

test('preset: every January (monthOrdinal 1)', () => {
  const t = treeFromPreset(PRESETS.EVERY_MONTH, { monthOrdinal: 1 });
  assert.deepEqual(t.children, [
    { type: 'condition', field: 'month', op: '==', value: 1 },
  ]);
});

test('preset: every "spring" season', () => {
  const t = treeFromPreset(PRESETS.EVERY_SEASON, { seasonId: 'spring-id' });
  assert.deepEqual(t.children, [
    { type: 'condition', field: 'season', op: '==', value: 'spring-id' },
  ]);
});

test('preset: every full moon (Lacrimosa, index 0)', () => {
  const t = treeFromPreset(PRESETS.EVERY_FULL_MOON, { moonIndex: 0 });
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.children[0], {
    type: 'condition', field: 'moonPhase', op: '==', value: 0.5, value2: 0,
  });
});

test('preset: every new moon (Umbra, index 2)', () => {
  const t = treeFromPreset(PRESETS.EVERY_NEW_MOON, { moonIndex: 2 });
  assert.deepEqual(t.children[0], {
    type: 'condition', field: 'moonPhase', op: '==', value: 0, value2: 2,
  });
});

test('preset: every 3rd weekday of winter season', () => {
  const t = treeFromPreset(PRESETS.EVERY_NTH_WEEKDAY_OF_SEASON, {
    weekdayOrdinal: 3,
    seasonId: 'winter-id',
  });
  assert.equal(t.children.length, 2);
  assert.deepEqual(t.children[0], { type: 'condition', field: 'weekday', op: '==', value: 3 });
  assert.deepEqual(t.children[1], { type: 'condition', field: 'season',  op: '==', value: 'winter-id' });
});

test('preset: every cycleStage "feast-day"', () => {
  const t = treeFromPreset(PRESETS.EVERY_CYCLE_STAGE, { cycleStage: 'feast-day' });
  assert.deepEqual(t.children, [
    { type: 'condition', field: 'cycleStage', op: '==', value: 'feast-day' },
  ]);
});

// ---------------------------------------------------------------------
// treeFromPreset — bad params return null
// ---------------------------------------------------------------------

test('preset: missing weekdayOrdinal → null', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_WEEKDAY, {}), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_WEEKDAY, { weekdayOrdinal: 0 }), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_WEEKDAY, { weekdayOrdinal: -1 }), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_WEEKDAY, { weekdayOrdinal: 1.5 }), null);
});

test('preset: missing monthDay → null', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_NTH_OF_MONTH, {}), null);
});

test('preset: missing seasonId / empty string → null', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_SEASON, {}), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_SEASON, { seasonId: '' }), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_SEASON, { seasonId: 42 }), null);
});

test('preset: missing moonIndex / negative → null', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_FULL_MOON, {}), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_FULL_MOON, { moonIndex: -1 }), null);
});

test('preset: every-nth-weekday-of-season needs BOTH params', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_NTH_WEEKDAY_OF_SEASON, { weekdayOrdinal: 1 }), null);
  assert.equal(treeFromPreset(PRESETS.EVERY_NTH_WEEKDAY_OF_SEASON, { seasonId: 'x' }), null);
});

test('preset: cycleStage missing → null', () => {
  assert.equal(treeFromPreset(PRESETS.EVERY_CYCLE_STAGE, {}), null);
});

test('preset: unknown id throws', () => {
  assert.throws(
    () => treeFromPreset('not-a-real-preset', {}),
    /Unknown preset/,
  );
});

// ---------------------------------------------------------------------
// validateTree — Calendaria's root-group rule (pinned)
// ---------------------------------------------------------------------

test('validateTree: empty/missing root yields NotAnObject', () => {
  assert.deepEqual(validateTree(null), ['CHRONICLE.SyncCalendar.Recurrence.Errors.NotAnObject']);
  assert.deepEqual(validateTree(undefined), ['CHRONICLE.SyncCalendar.Recurrence.Errors.NotAnObject']);
  assert.deepEqual(validateTree('string'), ['CHRONICLE.SyncCalendar.Recurrence.Errors.NotAnObject']);
});

test('validateTree: NEGATIVE — non-group root flagged (silently ignored by Calendaria)', () => {
  // This is THE check that matters most. Calendaria's matcher
  // silently ignores conditionTrees with a non-group root — the
  // operator gets a note that never fires. Our validator catches it
  // before save.
  const bad = { type: 'condition', field: 'weekday', op: '==', value: 1 };
  assert.deepEqual(validateTree(bad), ['CHRONICLE.SyncCalendar.Recurrence.Errors.RootMustBeGroup']);
});

test('validateTree: POSITIVE — well-formed group passes', () => {
  const tree = treeFromPreset(PRESETS.EVERY_FULL_MOON, { moonIndex: 1 });
  assert.deepEqual(validateTree(tree), []);
});

test('validateTree: empty group flagged', () => {
  const tree = emptyRootGroup();
  assert.deepEqual(validateTree(tree), ['CHRONICLE.SyncCalendar.Recurrence.Errors.EmptyGroup']);
});

test('validateTree: invalid group mode flagged', () => {
  const tree = { type: 'group', mode: 'xor', children: [leaf('weekday', '==', 1)] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidGroupMode'));
});

test('validateTree: leaf with unknown field flagged (out of v1 scope)', () => {
  const tree = { type: 'group', mode: 'and', children: [leaf('eclipse', '==', 'total')] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.FieldNotInV1Scope'));
});

test('validateTree: leaf with unknown operator flagged', () => {
  const tree = { type: 'group', mode: 'and', children: [leaf('weekday', 'daysAgo', 7)] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.OperatorNotInV1Scope'));
});

test('validateTree: leaf with missing value flagged', () => {
  const tree = { type: 'group', mode: 'and', children: [leaf('weekday', '==', '')] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.MissingValue'));
});

test('validateTree: nested group at depth 2 OK; depth 3 flagged', () => {
  const deep = {
    type: 'group',
    mode: 'and',
    children: [
      { type: 'group', mode: 'or', children: [
        { type: 'group', mode: 'and', children: [leaf('weekday', '==', 1)] },
      ] },
    ],
  };
  const errs = validateTree(deep);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.TooDeep'));
});

test('validateTree: depth-2 nesting passes', () => {
  const tree = {
    type: 'group',
    mode: 'and',
    children: [
      { type: 'group', mode: 'or', children: [
        leaf('weekday', '==', 1),
        leaf('weekday', '==', 6),
      ] },
      leaf('season', '==', 'winter-id'),
    ],
  };
  assert.deepEqual(validateTree(tree), []);
});

test('validateTree: non-object child flagged', () => {
  const tree = { type: 'group', mode: 'and', children: ['not an object'] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidChild'));
});

test('validateTree: child with bogus type flagged', () => {
  const tree = { type: 'group', mode: 'and', children: [{ type: 'rocketship', op: '==' }] };
  const errs = validateTree(tree);
  assert.ok(errs.includes('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidChildType'));
});

// ---------------------------------------------------------------------
// treeToSummary — readable round-trip
// ---------------------------------------------------------------------

test('summary: empty tree', () => {
  assert.equal(treeToSummary(null), '(no recurrence)');
  assert.equal(treeToSummary({ type: 'group', mode: 'and', children: [] }), '(empty group)');
});

test('summary: non-group root flagged', () => {
  assert.equal(
    treeToSummary({ type: 'condition', field: 'weekday', op: '==', value: 1 }),
    '(invalid recurrence — root must be a group)',
  );
});

test('summary: single-leaf tree', () => {
  const tree = treeFromPreset(PRESETS.EVERY_WEEKDAY, { weekdayOrdinal: 5 });
  assert.equal(treeToSummary(tree), 'weekday == 5');
});

test('summary: multi-leaf AND', () => {
  const tree = treeFromPreset(PRESETS.EVERY_NTH_WEEKDAY_OF_SEASON, {
    weekdayOrdinal: 3, seasonId: 'winter-id',
  });
  assert.equal(treeToSummary(tree), 'weekday == 3 AND season == "winter-id"');
});

test('summary: OR group uses OR joiner', () => {
  const tree = {
    type: 'group', mode: 'or',
    children: [leaf('weekday', '==', 1), leaf('weekday', '==', 6)],
  };
  assert.equal(treeToSummary(tree), 'weekday == 1 OR weekday == 6');
});

test('summary: moon-phase value renders numerically', () => {
  const tree = treeFromPreset(PRESETS.EVERY_FULL_MOON, { moonIndex: 0 });
  assert.equal(treeToSummary(tree), 'moonPhase == 0.5');
});

test('summary: nested group renders parenthesized', () => {
  const tree = {
    type: 'group', mode: 'and',
    children: [
      { type: 'group', mode: 'or', children: [leaf('weekday', '==', 1), leaf('weekday', '==', 6)] },
      leaf('season', '==', 'winter-id'),
    ],
  };
  assert.equal(treeToSummary(tree), '(weekday == 1 OR weekday == 6) AND season == "winter-id"');
});
