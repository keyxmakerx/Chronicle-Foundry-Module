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
  HistoryReporter, HISTORY_BATCH, HISTORY_QUEUE_MAX, ECHO_WINDOW_MS, idsInResponse,
  conflictEvent, conflictFieldNames,
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

test('a create names its id only in the response; that id is an echo too', () => {
  const r = new HistoryReporter({ send: async () => {} });
  const end = r.beginWrite('/entities');
  assert.equal(r.isEcho('new-1'), false);
  end({ id: 'new-1', name: 'The Gilded Eel' });
  assert.equal(r.isEcho('new-1'), true);
  r.beginWrite('/notes')({ data: { id: 42 } });
  assert.equal(r.isEcho('42'), true);
});

test('response ids: a record bare or enveloped, never a list or nothing', () => {
  assert.deepEqual(idsInResponse({ id: 'a-1' }), ['a-1']);
  assert.deepEqual(idsInResponse({ data: { id: 7 } }), ['7']);
  assert.deepEqual(idsInResponse({ data: [{ id: 'x1' }] }), []);
  assert.deepEqual(idsInResponse([{ id: 'x1' }]), []);
  assert.deepEqual(idsInResponse(null), []);
  assert.deepEqual(idsInResponse({ id: { nested: 1 } }), []);
});

test('a change announced before the create returns waits for it', async () => {
  const r = new HistoryReporter({ send: async () => {} });
  const end = r.beginWrite('/entities');
  let echo = null;
  const check = r.writesSettled().then(() => { echo = r.isEcho('new-2'); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(echo, null, 'still waiting on the create');
  end({ id: 'new-2' });
  await check;
  assert.equal(echo, true);
});

test('a failed write ends without naming anything; a stuck one stops the wait at the cap', async () => {
  const r = new HistoryReporter({ send: async () => {} });
  r.beginWrite('/entities')();
  await r.writesSettled();
  assert.equal(r.isEcho('undefined'), false);
  r.beginWrite('/entities');
  const t0 = Date.now();
  await r.writesSettled(20);
  assert.ok(Date.now() - t0 < 1000, 'the cap ends the wait');
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

test('a settled conflict says which side won and why, in the direction of the winner', () => {
  const at = Date.UTC(2026, 10, 27, 12);
  const ev = conflictEvent({
    kind: 'page', resourceId: 'e-1', name: 'Harbor', kept: 'chronicle', reason: 'setting',
    fields: { name: 'Harbour', entry: '<p>secret plans</p>', expected_updated_at: '2026-11-27T11:00:00Z' }, at,
  });
  assert.deepEqual(ev, {
    at: new Date(at).toISOString(), direction: 'to_foundry', kind: 'page', resourceId: 'e-1', name: 'Harbor',
    action: 'Chronicle kept', call: 'foundry conflict', status: 'conflict', ok: true, durationMs: 0,
    message: 'The conflict setting keeps the Chronicle version. Fields the Foundry edit sent: name, entry.',
  });
  const won = conflictEvent({ kind: 'character', resourceId: 'e-2', name: 'Ash', kept: 'foundry', reason: 'newer', fields: ['name'] });
  assert.equal(won.direction, 'to_chronicle');
  assert.equal(won.action, 'Foundry kept');
  assert.match(won.message, /newest version, and the Foundry change was newer\. Fields the Foundry edit sent: name\.$/);
  assert.match(conflictEvent({ kind: 'page', resourceId: 'x', name: 'X', kept: 'foundry', reason: 'part' }).message, /^This part is set to From Foundry/);
});

test('a conflict carries field names, never their values, and stays within the server limits', () => {
  const ev = conflictEvent({ kind: 'page', resourceId: 'e', name: 'n'.repeat(300), kept: 'chronicle', reason: 'setting', fields: { entry: 'GM-only words', 'bad key<script>': 1 } });
  assert.doesNotMatch(ev.message, /GM-only words|script/);
  assert.equal(ev.name.length, 200);
  assert.deepEqual(conflictFieldNames({ expected_updated_at: 'x', fields_data: {}, 'a b': 1 }), ['fields_data']);
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, i]));
  assert.ok(conflictEvent({ kind: 'page', resourceId: 'e', name: 'n', kept: 'foundry', reason: 'setting', fields: many }).message.length <= 500);
});
