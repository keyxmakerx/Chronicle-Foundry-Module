#!/usr/bin/env node
/**
 * Tests for scripts/_stash-model.mjs: unwrapping Chronicle's stash responses,
 * validating a move body, and the "now or ask the GM" framing.
 *
 * Run: `node --test tools/test-stash-model.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMovePayload,
  formatMoney,
  isFeatureMissing,
  moveFraming,
  normalizeView,
  parseAmount,
  touchedCharacterIds,
  unwrapHistory,
  unwrapRequests,
} from '../scripts/_stash-model.mjs';

const VIEW = {
  downtimeOpen: true,
  canApprove: false,
  character: { id: 'c1', name: 'Aria', moneyKey: 'gold', money: 3, items: [{ itemId: 'i1', name: 'Rope', quantity: 2 }] },
  stashes: [{ id: 7, name: 'Camp', money: 1.5, items: [{ itemId: 'i2', name: 'Tent', quantity: 1 }] }],
  destinations: [
    { kind: 'stash', id: '7', name: 'Camp' },
    { kind: 'character', id: 'c2', name: 'Bram' },
    { kind: 'bogus', id: 'x', name: 'Nope' },
  ],
};

test('normalizeView: reads the documented shape, stringifies a numeric stash id', () => {
  const v = normalizeView(VIEW);
  assert.equal(v.downtimeOpen, true);
  assert.equal(v.canApprove, false);
  assert.equal(v.character.moneyKey, 'gold');
  assert.equal(v.character.items[0].itemId, 'i1');
  assert.equal(v.stashes[0].id, '7');
  assert.equal(v.stashes[0].money, 1.5);
});

test('normalizeView: drops destinations of an unknown kind', () => {
  const v = normalizeView(VIEW);
  assert.deepEqual(v.destinations.map((d) => d.id), ['7', 'c2']);
});

test('normalizeView: missing arrays default to empty; no character is null', () => {
  const v = normalizeView({ character: { id: 'c1' } });
  assert.deepEqual(v.stashes, []);
  assert.deepEqual(v.destinations, []);
  assert.deepEqual(v.character.items, []);
  assert.equal(v.character.moneyKey, '');
  assert.equal(normalizeView({}), null);
  assert.equal(normalizeView(null), null);
  assert.equal(normalizeView([]), null);
});

test('normalizeView: an item with no quantity counts as one', () => {
  const v = normalizeView({ character: { id: 'c', items: [{ itemId: 'a', name: 'A' }, { name: 'no id' }] } });
  assert.equal(v.character.items.length, 1);
  assert.equal(v.character.items[0].quantity, 1);
});

test('unwrapHistory: object envelope, bare array and data envelope all work', () => {
  const row = { id: 5, kind: 'money', status: 'applied', summary: 'Wealth changed 2 → 3 · in Foundry', fromName: 'Aria', toName: 'Aria' };
  assert.equal(unwrapHistory({ history: [row] })[0].summary, row.summary);
  assert.equal(unwrapHistory([row])[0].id, '5');
  assert.equal(unwrapHistory({ data: [row] }).length, 1);
  assert.deepEqual(unwrapHistory(null), []);
  assert.deepEqual(unwrapHistory({ history: 'x' }), []);
});

test('unwrapHistory: caps at the server limit and skips rows without an id', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
  rows.push({ summary: 'no id' });
  assert.equal(unwrapHistory({ history: rows }).length, 50);
});

test('unwrapRequests: reads {requests:[...]} and a bare array', () => {
  const line = { id: 9, status: 'pending', kind: 'item', quantity: 2, itemName: 'Rope', requesterName: 'Aria' };
  assert.equal(unwrapRequests({ requests: [line] })[0].requesterName, 'Aria');
  assert.equal(unwrapRequests([line])[0].quantity, 2);
  assert.deepEqual(unwrapRequests({}), []);
});

test('parseAmount: positive numbers with up to two decimals only', () => {
  assert.equal(parseAmount('3'), 3);
  assert.equal(parseAmount(' 2.5 '), 2.5);
  assert.equal(parseAmount('2,25'), 2.25);
  for (const bad of ['', '0', '-1', '1.234', 'abc', '1e3', null, undefined]) {
    assert.equal(parseAmount(bad), null, `${bad} must be refused`);
  }
});

test('formatMoney: whole numbers bare, others two decimals', () => {
  assert.equal(formatMoney(3), '3');
  assert.equal(formatMoney(2.5), '2.50');
});

const C1 = { kind: 'character', id: 'c1' };
const S7 = { kind: 'stash', id: '7' };

test('buildMovePayload: item move carries integer quantity and no actingUserId by default', () => {
  const r = buildMovePayload({ kind: 'item', itemId: 'i1', quantity: '2', from: C1, to: S7 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { kind: 'item', itemId: 'i1', quantity: 2, from: C1, to: S7 });
  assert.equal('actingUserId' in r.body, false);
});

test('buildMovePayload: money move sends a number amount; actingUserId added when given', () => {
  const r = buildMovePayload({ kind: 'money', amount: '2.5', from: C1, to: S7, actingUserId: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(r.body.amount, 2.5);
  assert.equal(r.body.actingUserId, 'u1');
  assert.equal('itemId' in r.body, false);
});

test('buildMovePayload: refuses bad quantity, amount, endpoints, same place and unknown kind', () => {
  const cases = [
    [{ kind: 'item', itemId: 'i', quantity: 0, from: C1, to: S7 }, 'quantity'],
    [{ kind: 'item', itemId: 'i', quantity: 1.5, from: C1, to: S7 }, 'quantity'],
    [{ kind: 'item', quantity: 1, from: C1, to: S7 }, 'item'],
    [{ kind: 'money', amount: '0', from: C1, to: S7 }, 'amount'],
    [{ kind: 'money', amount: 'x', from: C1, to: S7 }, 'amount'],
    [{ kind: 'money', amount: 1, from: C1, to: { kind: 'bogus', id: '1' } }, 'endpoint'],
    [{ kind: 'money', amount: 1, from: C1, to: C1 }, 'same'],
    [{ kind: 'gem', from: C1, to: S7 }, 'kind'],
  ];
  for (const [input, error] of cases) {
    assert.deepEqual(buildMovePayload(input), { ok: false, error }, JSON.stringify(input));
  }
});

test('buildMovePayload: numeric ids are sent as strings', () => {
  const r = buildMovePayload({ kind: 'money', amount: 1, from: C1, to: { kind: 'stash', id: 7 } });
  assert.equal(r.body.to.id, '7');
});

test('moveFraming: GM always Move; player Move in downtime, Ask otherwise', () => {
  assert.deepEqual(moveFraming({ downtimeOpen: false, isGM: true }), { immediate: true, hintKey: 'HintGM', buttonKey: 'Move' });
  assert.deepEqual(moveFraming({ downtimeOpen: true, isGM: false }), { immediate: true, hintKey: 'HintNow', buttonKey: 'Move' });
  assert.deepEqual(moveFraming({ downtimeOpen: false, isGM: false }), { immediate: false, hintKey: 'HintAsk', buttonKey: 'Ask' });
});

test('touchedCharacterIds: list shape, single-id shape, junk', () => {
  assert.deepEqual(touchedCharacterIds({ characterIds: ['a', 'b', 'a'] }), ['a', 'b']);
  assert.deepEqual(touchedCharacterIds({ characterId: 'z' }), ['z']);
  assert.deepEqual(touchedCharacterIds(null), []);
  assert.deepEqual(touchedCharacterIds({ characterIds: 'x' }), []);
});

test('isFeatureMissing: only a 404', () => {
  assert.equal(isFeatureMissing({ status: 404 }), true);
  assert.equal(isFeatureMissing({ status: 500 }), false);
  assert.equal(isFeatureMissing(new Error('x')), false);
});
