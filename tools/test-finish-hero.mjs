#!/usr/bin/env node
/**
 * "Finish your hero": which class Chronicle picked, when the sheet still
 * needs it, and who is offered the card. No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classPick, pickToFinish, pickChanged, offersCard } from '../scripts/_finish-hero.mjs';

const DS = [
  { key: 'class', type: 'string', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true },
  { key: 'level', type: 'number', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true, foundry_item_fields: { level: 'system.level' } },
];

test('the class field is the one mapped to the class item, else "class"', () => {
  assert.deepEqual(classPick(DS, { class: ' Fury ', level: 3 }), { name: 'Fury', level: 3 });
  assert.deepEqual(classPick([], { class: 'Wizard', level: '2' }), { name: 'Wizard', level: 2 });
  const renamed = [{ ...DS[0], key: 'hero_class' }];
  assert.deepEqual(classPick(renamed, { hero_class: 'Censor', class: 'ignored' }), { name: 'Censor', level: 1 });
});

test('no class, a blank one or a bad level', () => {
  assert.equal(classPick(DS, {}), null);
  assert.equal(classPick(DS, { class: '  ' }), null);
  assert.equal(classPick(DS, { class: 4 }), null);
  assert.equal(classPick(DS, null), null);
  assert.equal(classPick(DS, { class: 'Fury', level: 0 }).level, 1);
  assert.equal(classPick(DS, { class: 'Fury', level: 'x' }).level, 1);
});

test('only a sheet with no class item needs finishing', () => {
  const pick = { name: 'Fury', level: 1 };
  assert.deepEqual(pickToFinish([{ type: 'ancestry' }], pick), pick);
  assert.equal(pickToFinish([{ type: 'class', name: 'Tactician' }], pick), null, 'any class item counts: the sheet is built');
  assert.equal(pickToFinish([], null), null);
});

test('the flag is written only when it changes', () => {
  assert.equal(pickChanged(null, undefined), false);
  assert.equal(pickChanged(null, { name: 'Fury', level: 1 }), true);
  assert.equal(pickChanged({ name: 'Fury', level: 1 }, { name: 'Fury', level: 1 }), false);
  assert.equal(pickChanged({ name: 'Fury', level: 1 }, { name: 'Fury', level: 2 }), true);
  assert.equal(pickChanged({ name: 'Fury', level: 1 }, null), true);
});

test('the card is for the owning player, once a session, never the GM', () => {
  const pick = { name: 'Fury', level: 1 };
  assert.equal(offersCard({ isGM: false, isOwner: true, pick, shown: false }), true);
  assert.equal(offersCard({ isGM: true, isOwner: true, pick, shown: false }), false);
  assert.equal(offersCard({ isGM: false, isOwner: false, pick, shown: false }), false);
  assert.equal(offersCard({ isGM: false, isOwner: true, pick, shown: true }), false);
  assert.equal(offersCard({ isGM: false, isOwner: true, pick: null, shown: false }), false);
});
