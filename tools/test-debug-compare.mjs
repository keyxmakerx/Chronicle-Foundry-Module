import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSideBySide, formatAmount, ROW_STATUS } from '../scripts/_debug-compare.mjs';

const chron = (items = [], extra = {}) => ({ moneyLabel: 'Gold', money: 12, items, ...extra });

test('money matches, differs, or is missing in Foundry', () => {
  const run = (money) => compareSideBySide({ chronicle: chron(), foundry: { moneyPath: 'system.gp', money } }).rows[0];
  assert.equal(run(12).status, ROW_STATUS.MATCH);
  assert.equal(run('12').status, ROW_STATUS.MATCH);
  assert.equal(run(12.001).status, ROW_STATUS.MATCH);
  assert.equal(run(11).status, ROW_STATUS.DIFFERENT);
  assert.equal(run(undefined).status, ROW_STATUS.MISSING);
  assert.equal(run(null).status, ROW_STATUS.MISSING);
  assert.equal(run('abc').status, ROW_STATUS.MISSING);
  assert.equal(run(0).status, ROW_STATUS.DIFFERENT);
});

test('no money row when Chronicle has no money field', () => {
  const r = compareSideBySide({ chronicle: { moneyLabel: '', items: [] }, foundry: { money: 5 } });
  assert.deepEqual(r.rows, []);
});

test('items: match, different count, not in Foundry', () => {
  const r = compareSideBySide({
    chronicle: chron([
      { itemId: 'a', name: 'Rope', quantity: 2 },
      { itemId: 'b', name: 'Torch', quantity: 5 },
      { itemId: 'c', name: 'Lamp', quantity: 1 },
    ]),
    foundry: { money: 12, items: [
      { id: '1', name: 'Rope', entityId: 'a', quantity: 2 },
      { id: '2', name: 'Torch', entityId: 'b', quantity: 3 },
    ] },
  });
  const by = Object.fromEntries(r.rows.map((x) => [x.thing, x]));
  assert.equal(by.Rope.status, 'match');
  assert.equal(by.Torch.status, 'different');
  assert.equal(by.Torch.chronicle, '5');
  assert.equal(by.Torch.foundry, '3');
  assert.equal(by.Lamp.status, 'missing');
  assert.equal(by.Lamp.foundry, '');
  assert.equal(r.differences, 2);
});

test('stacks with the same link add up', () => {
  const r = compareSideBySide({
    chronicle: { items: [{ itemId: 'b', name: 'Torch', quantity: 5 }] },
    foundry: { items: [
      { name: 'Torch', entityId: 'b', quantity: 2 },
      { name: 'Torch', entityId: 'b', quantity: 3 },
    ] },
  });
  assert.equal(r.rows[0].status, 'match');
});

test('an unlinked Foundry item lines up by name, a linked one never does', () => {
  const byName = compareSideBySide({
    chronicle: { items: [{ itemId: 'x', name: 'Sword', quantity: 1 }] },
    foundry: { items: [{ name: 'sword ', quantity: 1 }] },
  });
  assert.equal(byName.rows[0].status, 'match');
  const linkedElsewhere = compareSideBySide({
    chronicle: { items: [{ itemId: 'x', name: 'Sword', quantity: 1 }] },
    foundry: { items: [{ name: 'Sword', entityId: 'other', quantity: 1 }] },
  });
  assert.deepEqual(linkedElsewhere.rows.map((x) => x.status), ['missing', 'foundry-only']);
});

test('Foundry-only items are merged by name and listed last', () => {
  const r = compareSideBySide({
    chronicle: { items: [{ itemId: 'a', name: 'Rope', quantity: 1 }] },
    foundry: { items: [
      { name: 'Rope', entityId: 'a', quantity: 1 },
      { name: 'Dagger', quantity: 1 },
      { name: 'dagger', quantity: 2 },
    ] },
  });
  const last = r.rows.at(-1);
  assert.equal(last.status, 'foundry-only');
  assert.equal(last.foundry, '3');
  assert.equal(r.rows.length, 2);
});

test('missing quantity counts as one; empty input is harmless', () => {
  const r = compareSideBySide({ chronicle: { items: [{ itemId: 'a', name: 'Rope' }] }, foundry: { items: [{ name: 'Rope', entityId: 'a' }] } });
  assert.equal(r.rows[0].status, 'match');
  assert.deepEqual(compareSideBySide().rows, []);
});

test('compare never mutates its input', () => {
  const input = { chronicle: { items: [{ itemId: 'a', name: 'Rope', quantity: 1 }] }, foundry: { items: [{ name: 'Rope', entityId: 'a', quantity: 1 }] } };
  const copy = JSON.parse(JSON.stringify(input));
  compareSideBySide(input);
  assert.deepEqual(input, copy);
});

test('formatAmount trims to two decimals', () => {
  assert.equal(formatAmount(12), '12');
  assert.equal(formatAmount(1.256), '1.26');
  assert.equal(formatAmount(null), '');
});

import { findMoneyField } from '../scripts/_debug-compare.mjs';

test('findMoneyField: by stash key, by guess, or nothing', () => {
  const fields = [
    { key: 'str', label: 'Strength', foundry_path: 'system.abilities.str.value' },
    { key: 'gp', label: 'Gold', foundry_path: 'system.currency.gp' },
  ];
  assert.deepEqual(findMoneyField(fields, 'gp'), { key: 'gp', label: 'Gold', foundryPath: 'system.currency.gp' });
  assert.deepEqual(findMoneyField(fields, ''), { key: 'gp', label: 'Gold', foundryPath: 'system.currency.gp' });
  assert.deepEqual(findMoneyField(fields, 'silver'), { key: 'silver', label: 'silver', foundryPath: '' });
  assert.equal(findMoneyField([{ key: 'str' }], ''), null);
  assert.equal(findMoneyField(null, ''), null);
});
