#!/usr/bin/env node
/**
 * Deleting something in Foundry never deletes its Chronicle copy without
 * asking (scripts/_remote-deletes.mjs): a burst of deletes is asked about
 * once, No (or a dismissed dialog, or a failed ask) keeps everything, and
 * only Yes runs the Chronicle deletes. Also pins that the sync files route
 * their Foundry-side deletes through it, never calling the API directly.
 *
 * Run: node --test tools/test-remote-deletes.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRemoteDeleteBatch } from '../scripts/_remote-deletes.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A timer we fire by hand: add() arms it, flush happens when we say so.
function manualTimer() {
  const t = { fn: null, armed: 0 };
  t.set = (fn) => { t.fn = fn; t.armed++; return t.armed; };
  t.clear = () => { t.fn = null; };
  return t;
}

function item(label, log) {
  return { label, run: async () => { log.push(label); } };
}

test('a burst of deletes is asked about once, together', async () => {
  const timer = manualTimer(), asked = [], ran = [];
  const batch = createRemoteDeleteBatch({ ask: async (items) => { asked.push(items.map((i) => i.label)); return false; }, setTimer: timer.set, clearTimer: timer.clear });
  batch.add(item('Mirabel', ran));
  batch.add(item('Old Tom', ran));
  batch.add(item('The Widow', ran));
  assert.equal(asked.length, 0, 'nothing is asked until the burst settles');
  await timer.fn();
  assert.deepEqual(asked, [['Mirabel', 'Old Tom', 'The Widow']]);
});

test('No keeps everything in Chronicle', async () => {
  const timer = manualTimer(), ran = [];
  let done = null;
  const batch = createRemoteDeleteBatch({ ask: async () => false, onDone: (r) => { done = r; }, setTimer: timer.set, clearTimer: timer.clear });
  batch.add(item('Mirabel', ran));
  batch.add(item('Old Tom', ran));
  await timer.fn();
  assert.deepEqual(ran, []);
  assert.deepEqual(done, { asked: true, deleted: 0, kept: 2 });
});

test('a dismissed dialog or a failing ask keeps everything too', async () => {
  for (const ask of [async () => null, async () => { throw new Error('no dialog'); }]) {
    const timer = manualTimer(), ran = [];
    const batch = createRemoteDeleteBatch({ ask, setTimer: timer.set, clearTimer: timer.clear });
    batch.add(item('Mirabel', ran));
    const res = await timer.fn();
    assert.deepEqual(ran, []);
    assert.equal(res.kept, 1);
  }
});

test('Yes deletes each one, and one failure does not stop the rest', async () => {
  const timer = manualTimer(), ran = [];
  let done = null;
  const batch = createRemoteDeleteBatch({ ask: async () => true, onDone: (r) => { done = r; }, setTimer: timer.set, clearTimer: timer.clear });
  batch.add(item('Mirabel', ran));
  batch.add({ label: 'Gone already', run: async () => { throw Object.assign(new Error('404'), { status: 404 }); } });
  batch.add(item('Old Tom', ran));
  const warn = console.warn;
  console.warn = () => {};
  try { await timer.fn(); } finally { console.warn = warn; }
  assert.deepEqual(ran, ['Mirabel', 'Old Tom']);
  assert.deepEqual(done, { asked: true, deleted: 2, kept: 1 });
});

test('deletes after an answer start a new question', async () => {
  const timer = manualTimer(), asked = [];
  const batch = createRemoteDeleteBatch({ ask: async (items) => { asked.push(items.length); return false; }, setTimer: timer.set, clearTimer: timer.clear });
  batch.add(item('One', []));
  await timer.fn();
  batch.add(item('Two', []));
  batch.add(item('Three', []));
  await timer.fn();
  assert.deepEqual(asked, [1, 2]);
});

test('the sync files queue their Foundry-side deletes instead of calling the API', () => {
  const src = (f) => readFileSync(resolve(REPO_ROOT, 'scripts', f), 'utf8');
  const actor = src('actor-sync.mjs'), journal = src('journal-sync.mjs');
  for (const [name, text] of [['actor-sync', actor], ['journal-sync', journal]]) {
    assert.match(text, /queueRemoteDelete\(/, `${name} must ask before deleting in Chronicle`);
  }
  assert.doesNotMatch(actor, /await this\._api\.delete\(`\/entities/, 'actor-sync must not delete a Chronicle page without asking');
  assert.doesNotMatch(journal, /await this\._api\.delete\(`\/entities/, 'journal-sync must not delete a Chronicle page without asking');
});
