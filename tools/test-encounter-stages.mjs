#!/usr/bin/env node
/**
 * Encounter stages on the DM Screen: what a stage may say, when it is due,
 * and that Not yet and Start are remembered for the fight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterNotYet, afterStart, newlyDue, parseStages, rowStaminaPercent, stageMet, stageStates,
} from '../scripts/_encounter-stages.mjs';

const rows = new Set(['q', 'rats']);
const RAW = [
  { id: 's1', when: { kind: 'stamina', row: 'q', percent: 50 }, forms: [{ row: 'q', form: 'unmasked', formName: 'Unmasked' }], arrive: ['rats'], how: 'reveal' },
  { id: 's2', when: { kind: 'round', round: 3 }, forms: [], arrive: ['rats', 'rats'] },
  { id: 's3', when: { kind: 'manual' }, forms: [{ row: 'q', form: '' }], how: 'quiet', note: 'If they flee' },
];

test('stages are read defensively', () => {
  const s = parseStages(RAW, rows);
  assert.deepEqual(s.map((x) => x.id), ['s1', 's2', 's3']);
  assert.deepEqual(s[1].arrive, ['rats'], 'duplicates dropped');
  assert.equal(s[2].how, 'quiet');
  assert.equal(s[0].how, 'reveal');
  const gone = parseStages([
    { id: 'a', when: { kind: 'stamina', row: 'gone', percent: 50 }, forms: [{ row: 'q', form: 'x' }] },
    { id: 'b', forms: [{ row: 'gone', form: 'x' }], arrive: ['gone'] },
    { id: 'c', forms: [{ row: 'q', form: 'Bad Id!' }] },
    { forms: [{ row: 'q', form: '' }] },
  ], rows);
  assert.deepEqual(gone.map((x) => [x.id, x.when.kind]), [['a', 'manual']], 'a stage with nothing left to do is dropped');
  assert.deepEqual(parseStages(null, rows), []);
});

test('Stamina is the lowest of a row’s placed tokens', () => {
  const tokens = [{ rowId: 'q', value: 200, max: 300 }, { rowId: 'q', value: 120, max: 300 }, { rowId: 'rats', value: 1, max: 10 }];
  assert.equal(rowStaminaPercent('q', tokens), 40);
  assert.equal(rowStaminaPercent('none', tokens), null);
  assert.equal(rowStaminaPercent('q', [{ rowId: 'q', value: 5, max: 0 }]), null);
});

test('a stage is due when its moment comes; a manual one never is', () => {
  const [s1, s2, s3] = parseStages(RAW, rows);
  const cases = [
    ['stamina above', s1, { round: 1, tokens: [{ rowId: 'q', value: 151, max: 300 }] }, false],
    ['stamina at half', s1, { round: 1, tokens: [{ rowId: 'q', value: 150, max: 300 }] }, true],
    ['not placed', s1, { round: 5, tokens: [] }, false],
    ['round 2', s2, { round: 2, tokens: [] }, false],
    ['round 3', s2, { round: 3, tokens: [] }, true],
    ['manual', s3, { round: 9, tokens: [] }, false],
  ];
  for (const [name, stage, ctx, want] of cases) assert.equal(stageMet(stage, ctx), want, name);
});

test('Not yet waits for the next round; Start is kept', () => {
  const stages = parseStages(RAW, rows);
  const ctx = { round: 3, tokens: [{ rowId: 'q', value: 10, max: 300 }] };
  let mem = { started: [], notYet: {} };
  assert.deepEqual(stageStates(stages, ctx, mem), ['due', 'due', 'waiting']);
  mem = afterNotYet(mem, 's1', 3);
  assert.deepEqual(stageStates(stages, ctx, mem), ['waiting', 'due', 'waiting']);
  assert.deepEqual(stageStates(stages, { ...ctx, round: 4 }, mem), ['due', 'due', 'waiting']);
  mem = afterStart(mem, 's2');
  mem = afterStart(mem, 's2');
  assert.deepEqual(mem.started, ['s2']);
  assert.deepEqual(stageStates(stages, ctx, mem), ['waiting', 'started', 'waiting']);
});

test('a stage is announced once when it becomes due', () => {
  assert.deepEqual(newlyDue(null, ['due', 'waiting']), [0]);
  assert.deepEqual(newlyDue(['due', 'waiting'], ['due', 'due']), [1]);
  assert.deepEqual(newlyDue(['due'], ['started']), []);
});
