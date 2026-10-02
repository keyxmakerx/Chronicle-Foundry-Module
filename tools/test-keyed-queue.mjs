#!/usr/bin/env node
/** KeyedQueue: ordering per key, independence across keys, failure isolation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedQueue } from '../scripts/_keyed-queue.mjs';

const tick = () => new Promise((r) => setImmediate(r));

test('tasks for one key run in arrival order without interleaving', async () => {
  const q = new KeyedQueue();
  const log = [];
  const task = (name, waits) => async () => {
    log.push(`${name}:start`);
    for (let i = 0; i < waits; i++) await tick();
    log.push(`${name}:end`);
  };
  await Promise.all([q.run('a', task('1', 3)), q.run('a', task('2', 0)), q.run('a', task('3', 1))]);
  assert.deepEqual(log, ['1:start', '1:end', '2:start', '2:end', '3:start', '3:end']);
});

test('different keys do not wait for each other', async () => {
  const q = new KeyedQueue();
  const log = [];
  const slow = q.run('a', async () => { await tick(); await tick(); log.push('a'); });
  const fast = q.run('b', async () => { log.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ['b', 'a']);
});

test('a failing task rejects only itself; the chain continues', async () => {
  const q = new KeyedQueue();
  const bad = q.run('a', async () => { throw new Error('boom'); });
  const good = q.run('a', async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('isBusy is true while work is queued and false after it settles', async () => {
  const q = new KeyedQueue();
  const p = q.run('a', async () => tick());
  assert.equal(q.isBusy('a'), true);
  await p;
  await tick();
  assert.equal(q.isBusy('a'), false);
});
