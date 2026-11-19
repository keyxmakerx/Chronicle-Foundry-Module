#!/usr/bin/env node
/** Direction and held changes (scripts/_held-changes.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pushGate, pullGate, parseHeld, holdChange, dropHeld } from '../scripts/_held-changes.mjs';

test('direction decides which way a change may go', () => {
  assert.equal(pushGate('both', true, 'journals'), 'send');
  assert.equal(pushGate('push', true, 'journals'), 'send');
  assert.equal(pushGate('pull', true, 'journals'), 'drop');
  assert.equal(pushGate('off', true, 'journals'), 'drop');
  assert.equal(pullGate('both', true, 'journals'), 'apply');
  assert.equal(pullGate('pull', true, 'journals'), 'apply');
  assert.equal(pullGate('push', true, 'journals'), 'drop');
  assert.equal(pullGate('off', true, 'journals'), 'drop');
});

test('with live sync off, document parts wait and views of Chronicle do not', () => {
  for (const part of ['journals', 'maps', 'characters', 'creatures']) {
    assert.equal(pushGate('both', false, part), 'hold', part);
    assert.equal(pullGate('both', false, part), 'hold', part);
  }
  for (const part of ['calendar', 'shops']) {
    assert.equal(pushGate('both', false, part), 'send', part);
    assert.equal(pullGate('both', false, part), 'apply', part);
  }
  assert.equal(pushGate('pull', false, 'journals'), 'drop', 'a blocked direction is not held');
  assert.equal(pullGate('push', false, 'journals'), 'drop');
});

test('one document has one waiting entry, kept in its place', () => {
  let list = [];
  list = holdChange(list, { key: 'journal:a', part: 'journals', kind: 'update', label: 'A', data: { name: true } });
  list = holdChange(list, { key: 'journal:b', part: 'journals', kind: 'update', label: 'B' });
  list = holdChange(list, { key: 'journal:a', part: 'journals', kind: 'update', data: { ownership: true } },
    (before, next) => ({ ...before.data, ...next.data }));
  assert.deepEqual(list.map((r) => r.key), ['journal:a', 'journal:b']);
  assert.deepEqual(list[0].data, { name: true, ownership: true });
  assert.equal(list[0].label, 'A', 'the label is kept when the new change gives none');
  list = holdChange(list, { key: 'journal:a', part: 'journals', kind: 'delete', label: 'A', data: { entityId: 'e1' } });
  assert.equal(list[0].kind, 'delete');
  assert.deepEqual(list[0].data, { entityId: 'e1' }, 'without a merge the new change replaces the old');
});

test('dropping a change leaves the rest', () => {
  const list = holdChange([], { key: 'k', part: 'journals', kind: 'update' });
  assert.deepEqual(dropHeld(list, 'k'), []);
  assert.equal(dropHeld(list, 'other'), list);
});

test('a saved list that cannot be read is empty, and bad entries are left out', () => {
  assert.deepEqual(parseHeld('not json'), []);
  assert.deepEqual(parseHeld('{"a":1}'), []);
  assert.deepEqual(parseHeld(''), []);
  const kept = parseHeld(JSON.stringify([{ key: 'k', part: 'journals', kind: 'update', data: 3 }, { part: 'x' }, null]));
  assert.deepEqual(kept, [{ key: 'k', part: 'journals', kind: 'update', label: '', at: '', data: {} }]);
});
