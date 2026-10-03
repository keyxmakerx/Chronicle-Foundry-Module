#!/usr/bin/env node
/**
 * Sync history reporting: which Chronicle messages and activity entries
 * become history rows, echo suppression of this world's own writes, and the
 * reporter's batching, retry and stop-on-refusal rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMessage, resourceIdOf, resourceNameOf, idsInPath, activityToEvent,
  HistoryReporter, HISTORY_BATCH, HISTORY_QUEUE_MAX, ECHO_WINDOW_MS,
} from '../scripts/_history-report.mjs';

test('messages that are changes read as history; bursts are left out', () => {
  assert.deepEqual(describeMessage('entity.updated'), { kind: 'page', action: 'page updated' });
  assert.deepEqual(describeMessage('calendar.date.advanced'), { kind: 'calendar', action: 'date moved' });
  for (const t of ['token.updated', 'calendar.weather.changed', 'calendar.moon.phase_changed', 'sync.status', undefined]) {
    assert.equal(describeMessage(t), null, String(t));
  }
});

test('resource id and name come from the envelope, then the payload', () => {
  assert.equal(resourceIdOf({ resourceId: 'e1', payload: { id: 'x' } }), 'e1');
  assert.equal(resourceIdOf({ payload: { id: 7 } }), '7');
  assert.equal(resourceIdOf({ payload: { id: { bad: 1 } } }), '');
  assert.equal(resourceNameOf({ payload: { name: 'Port Ashwick' } }), 'Port Ashwick');
  assert.equal(resourceNameOf({ payload: { title: 'Session 14' } }), 'Session 14');
  assert.equal(resourceNameOf({}), '');
});

test('ids in a write path skip route words and the query', () => {
  assert.deepEqual(idsInPath('/entities/3f2a-91bc/fields?x=1'), ['3f2a-91bc']);
  assert.deepEqual(idsInPath('/maps/m-1/markers/42'), ['m-1', '42']);
  assert.deepEqual(idsInPath('/calendar/date'), []);
});

test('activity entries: Chronicle already has pushes; problems are failures', () => {
  assert.equal(activityToEvent('push', 'Pushed "X" to Chronicle', 0), null);
  const err = activityToEvent('error', 'Initial sync failed: boom', Date.UTC(2026, 9, 3));
  assert.equal(err.ok, false);
  assert.equal(err.direction, 'link');
  assert.equal(err.message, 'Initial sync failed: boom');
  assert.equal(err.at, '2026-10-03T00:00:00.000Z');
  const conn = activityToEvent('connect', 'Initial sync complete (3 mappings)', 0);
  assert.equal(conn.ok, true);
  assert.equal(conn.action, 'connected');
  assert.equal(conn.message, '');
  assert.equal(activityToEvent('pull', 'Pulled "A"', 0).direction, 'to_foundry');
  assert.equal(activityToEvent('error', 'x'.repeat(900), 0).message.length, 500);
});

test('a change Chronicle sends right after this world wrote it is an echo', () => {
  let now = 1000;
  const r = new HistoryReporter({ send: async () => {}, now: () => now });
  r.noteWrite('/entities/e-1');
  assert.equal(r.isEcho('e-1'), true);
  assert.equal(r.isEcho('e-2'), false);
  assert.equal(r.isEcho(''), false);
  now += ECHO_WINDOW_MS + 1;
  assert.equal(r.isEcho('e-1'), false);
});

test('flush sends in batches of the server limit', async () => {
  const sent = [];
  const r = new HistoryReporter({ send: async (b) => { sent.push(b.events.length); } });
  for (let i = 0; i < HISTORY_BATCH + 7; i++) r.add({ i });
  assert.equal(await r.flush(), HISTORY_BATCH + 7);
  assert.deepEqual(sent, [HISTORY_BATCH, 7]);
  assert.equal(r.pending, 0);
});

test('a failed send keeps the events for next time', async () => {
  let fail = true;
  const r = new HistoryReporter({ send: async () => { if (fail) throw Object.assign(new Error('down'), { status: 502 }); } });
  r.add({ a: 1 });
  assert.equal(await r.flush(), 0);
  assert.equal(r.pending, 1);
  fail = false;
  assert.equal(await r.flush(), 1);
  assert.equal(r.pending, 0);
});

for (const status of [403, 404]) {
  test(`a ${status} stops reporting for the session`, async () => {
    let calls = 0;
    const r = new HistoryReporter({ send: async () => { calls++; throw Object.assign(new Error('no'), { status }); } });
    r.add({ a: 1 });
    await r.flush();
    r.add({ b: 2 });
    await r.flush();
    assert.equal(calls, 1);
    assert.equal(r.disabled, true);
    assert.equal(r.pending, 0);
  });
}

test('the queue keeps only the newest events while Chronicle is away', () => {
  const r = new HistoryReporter({ send: async () => {} });
  for (let i = 0; i < HISTORY_QUEUE_MAX + 5; i++) r.add({ i });
  assert.equal(r.pending, HISTORY_QUEUE_MAX);
  assert.equal(r._queue[0].i, 5);
});

test('flushes never overlap', async () => {
  let release;
  const r = new HistoryReporter({ send: () => new Promise((res) => { release = res; }) });
  r.add({ a: 1 });
  const first = r.flush();
  assert.equal(await r.flush(), 0);
  release();
  assert.equal(await first, 1);
});
