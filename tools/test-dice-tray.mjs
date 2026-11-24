#!/usr/bin/env node
/**
 * The dice tray by the chat box (scripts/_dice-tray.mjs): what a pool of
 * dice becomes as a roll formula, how a Draw Steel hero's characteristics
 * read, and the wiring the pure rules cannot see.
 *
 * Run: node --test tools/test-dice-tray.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DIE_SIDES, addDie, characteristicChoices, createPool, dieOutline, formulaOf,
  poolIsEmpty, powerRollFormula, setModifier, signed,
} from '../scripts/_dice-tray.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

test('a pool becomes a formula, largest die first, with the modifier spaced', () => {
  let p = createPool();
  assert.equal(formulaOf(p), '');
  p = addDie(p, 6);
  p = addDie(p, 20);
  p = addDie(p, 6);
  assert.equal(formulaOf(p), '1d20 + 2d6');
  assert.equal(formulaOf(setModifier(p, 3)), '1d20 + 2d6 + 3');
  assert.equal(formulaOf(setModifier(p, -2)), '1d20 + 2d6 - 2');
});

test('a modifier alone is not a roll', () => {
  const p = setModifier(createPool(), 5);
  assert.ok(poolIsEmpty(p));
  assert.equal(formulaOf(p), '');
});

test('taking dice away stops at none and drops the size', () => {
  let p = addDie(createPool(), 8);
  p = addDie(p, 8, -1);
  p = addDie(p, 8, -1);
  assert.deepEqual(p.counts, {});
});

test('counts and modifiers are clamped; unknown dice are ignored', () => {
  let p = createPool();
  for (let i = 0; i < 30; i++) p = addDie(p, 10);
  assert.equal(p.counts[10], 20);
  assert.equal(addDie(p, 7), p);
  assert.equal(addDie(p, 6, 1.5), p);
  assert.equal(setModifier(p, 500).modifier, 99);
  assert.equal(setModifier(p, -500).modifier, -99);
  assert.equal(setModifier(p, 'abc').modifier, 0);
  assert.equal(setModifier(p, '2.7').modifier, 2);
});

test('the pool is never changed in place', () => {
  const p = createPool();
  addDie(p, 4);
  setModifier(p, 2);
  assert.deepEqual(p, { counts: {}, modifier: 0 });
});

test('a power roll is 2d10 plus the characteristic', () => {
  assert.equal(powerRollFormula(2), '2d10 + 2');
  assert.equal(powerRollFormula(-1), '2d10 - 1');
  assert.equal(powerRollFormula(0), '2d10');
  assert.equal(powerRollFormula(undefined), '2d10');
});

test('characteristics read in sheet order, unknown values stay null', () => {
  const got = characteristicChoices({ might: { value: 2 }, reason: { value: '3' }, presence: { value: -1 } });
  assert.deepEqual(got, [
    { key: 'might', value: 2 },
    { key: 'agility', value: null },
    { key: 'reason', value: null },
    { key: 'intuition', value: null },
    { key: 'presence', value: -1 },
  ]);
  assert.equal(characteristicChoices(undefined).length, 5);
  assert.deepEqual([signed(2), signed(0), signed(-1), signed(null)], ['+2', '+0', '-1', '']);
});

test('every offered die has an outline drawn in the text colour', () => {
  for (const s of DIE_SIDES) assert.match(dieOutline(s), /stroke="currentColor"/, `d${s}`);
  assert.equal(dieOutline(7), '');
});

test('wiring: registered at init and ready, styled, and every label localized', () => {
  const mod = read('scripts/module.mjs');
  assert.match(mod, /registerDiceTraySetting\(\)/);
  assert.match(mod, /registerDiceTray\(\)/);
  assert.ok(JSON.parse(read('module.json')).styles.includes('styles/dice-tray.css'));

  const lang = JSON.parse(read('lang/en.json')).CHRONICLE.DiceTray;
  const src = read('scripts/dice-tray.mjs');
  const keys = [...src.matchAll(/\bt\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(keys.length > 5);
  for (const k of keys) assert.equal(typeof lang[k], 'string', `CHRONICLE.DiceTray.${k}`);
  for (const k of ['might', 'agility', 'reason', 'intuition', 'presence']) assert.ok(lang.Char[k], k);
  assert.ok(lang.AddDie.includes('{die}'));
});

test('rolls go through Foundry rolls, never a hand-built chat message', () => {
  const src = read('scripts/dice-tray.mjs');
  assert.doesNotMatch(src, /ChatMessage\.create/);
  assert.match(src, /roll\.toMessage\(/);
  assert.match(src, /rollCharacteristic === 'function'/);
});
