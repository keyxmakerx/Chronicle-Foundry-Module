#!/usr/bin/env node
/** Player report: body shape and caps, activity tracker, send/stop rules. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlayerReport, PlayerActivity, PlayerReporter, reasonFromError,
  MAX_PLAYERS, MAX_NAME_CHARS, MAX_FAILURE_CHARS, FAILURE_WINDOW_MS,
} from '../scripts/_player-report.mjs';

const DAY = 24 * 60 * 60 * 1000;
const clock = (start = Date.UTC(2026, 9, 4)) => {
  const c = { t: start, now: () => c.t };
  return c;
};

test('body has the contract fields for every user, mapped or not', () => {
  const act = new PlayerActivity({ now: clock().now });
  act.recordChange('f2');
  const body = buildPlayerReport({
    users: [
      { id: 'f1', name: 'GM Gwen', active: true, isGM: true },
      { id: 'f2', name: 'Ren', active: false, isGM: false },
      { id: 'f3', name: 'Zed', active: true, isGM: false },
    ],
    mappings: { 'c-owner': 'f1', 'c-ren': 'f2' },
    activityFor: (id) => act.get(id),
  });
  assert.deepEqual(body.players.map((p) => p.foundryUserId), ['f1', 'f2', 'f3']);
  assert.deepEqual(body.players.map((p) => p.memberId), ['c-owner', 'c-ren', '']);
  assert.deepEqual(body.players.map((p) => p.online), [true, false, true]);
  assert.equal(body.players[1].lastChangeAt, new Date(Date.UTC(2026, 9, 4)).toISOString());
  assert.equal(body.players[2].lastChangeAt, null);
  assert.equal(body.players[2].lastFailedAt, null);
  assert.equal(body.players[2].lastFailure, '');
  assert.equal(body.players[2].failedCount, 0);
  assert.deepEqual(Object.keys(body.players[0]).sort(), [
    'failedCount', 'foundryUserId', 'lastChangeAt', 'lastFailedAt', 'lastFailure', 'memberId', 'name', 'online',
  ]);
});

test('no emails or extra fields leak from the user objects', () => {
  const body = buildPlayerReport({
    users: [{ id: 'f1', name: 'A', active: true, isGM: false, email: 'a@b.c', password: 'x' }],
    mappings: {},
    activityFor: () => ({}),
  });
  assert.ok(!JSON.stringify(body).includes('a@b.c'));
  assert.ok(!JSON.stringify(body).includes('password'));
});

test('names are capped, players capped at 100 with GMs kept', () => {
  const users = [];
  for (let i = 0; i < 150; i++) users.push({ id: `p${i}`, name: 'n'.repeat(300), active: false, isGM: false });
  users.push({ id: 'gm', name: 'GM', active: true, isGM: true });
  const { players } = buildPlayerReport({ users, mappings: {}, activityFor: () => ({}) });
  assert.equal(players.length, MAX_PLAYERS);
  assert.equal(players[0].foundryUserId, 'gm');
  assert.equal(players[1].name.length, MAX_NAME_CHARS);
});

test('two Chronicle ids on one Foundry user pick the same one every time', () => {
  const args = { users: [{ id: 'f1', name: 'A' }], activityFor: () => ({}) };
  const a = buildPlayerReport({ ...args, mappings: { b: 'f1', a: 'f1' } });
  const b = buildPlayerReport({ ...args, mappings: { a: 'f1', b: 'f1' } });
  assert.equal(a.players[0].memberId, 'a');
  assert.deepEqual(a, b);
});

test('tolerates missing inputs', () => {
  assert.deepEqual(buildPlayerReport({ users: null, mappings: null, activityFor: null }), { players: [] });
});

test('tracker: change and failure are recorded per user', () => {
  const c = clock();
  const act = new PlayerActivity({ now: c.now });
  act.recordChange('u1');
  c.t += 1000;
  act.recordFailure('u1', 'HTTP 500 Internal Server Error');
  const g = act.get('u1');
  assert.equal(g.lastChangeAt, Date.UTC(2026, 9, 4));
  assert.equal(g.lastFailedAt, Date.UTC(2026, 9, 4) + 1000);
  assert.equal(g.lastFailure, 'HTTP 500 Internal Server Error');
  assert.equal(g.failedCount, 1);
  assert.equal(act.get('nobody').failedCount, 0);
});

test('tracker: failures count over a rolling 7 days', () => {
  const c = clock();
  const act = new PlayerActivity({ now: c.now });
  act.recordFailure('u1', 'old');
  c.t += 6 * DAY;
  act.recordFailure('u1', 'mid');
  assert.equal(act.get('u1').failedCount, 2);
  c.t += 2 * DAY; // first one is now 8 days old
  assert.equal(act.get('u1').failedCount, 1);
  c.t += FAILURE_WINDOW_MS;
  assert.equal(act.get('u1').failedCount, 0);
  assert.equal(act.get('u1').lastFailure, 'mid', 'the last reason stays after the count ages out');
});

test('tracker: failure text is capped and whitespace flattened', () => {
  const act = new PlayerActivity();
  act.recordFailure('u1', 'x'.repeat(1000));
  assert.equal(act.get('u1').lastFailure.length, MAX_FAILURE_CHARS);
  act.recordFailure('u1', 'a\n\n  b');
  assert.equal(act.get('u1').lastFailure, 'a b');
});

test('tracker: the map is capped and drops the least recently touched user', () => {
  const act = new PlayerActivity();
  for (let i = 0; i < 300; i++) act.recordChange(`u${i}`);
  assert.equal(act.size, 200);
  assert.equal(act.get('u0').lastChangeAt, null);
  assert.notEqual(act.get('u299').lastChangeAt, null);
});

test('tracker: per-user failure list is bounded', () => {
  const act = new PlayerActivity();
  for (let i = 0; i < 1000; i++) act.recordFailure('u1', 'x');
  assert.equal(act.get('u1').failedCount, 200);
});

test('tracker: a falsy user id is ignored and revision only moves on records', () => {
  const act = new PlayerActivity();
  act.recordChange('');
  act.recordFailure(undefined, 'x');
  assert.equal(act.size, 0);
  assert.equal(act.revision, 0);
  act.recordChange('u1');
  assert.equal(act.revision, 1);
});

test('reasonFromError uses the status only, never the message', () => {
  assert.equal(reasonFromError({ status: 403, message: '<html>secret page</html>' }), 'HTTP 403 Forbidden');
  assert.equal(reasonFromError({ status: 418 }), 'HTTP 418');
  assert.equal(reasonFromError(new Error('Chronicle API error 500: private text')), 'no response from Chronicle');
  assert.equal(reasonFromError(null), 'no response from Chronicle');
});

const mk = (sendImpl) => {
  const sent = [];
  const logs = [];
  let body = { players: [{ n: 1 }] };
  const r = new PlayerReporter({
    send: async (b) => { sent.push(b); return sendImpl ? sendImpl(b) : { stored: 1 }; },
    build: () => body,
    log: (m) => logs.push(m),
  });
  return { r, sent, logs, set: (b) => { body = b; } };
};

test('reporter sends once, skips when unchanged, sends again on change or force', async () => {
  const { r, sent, set } = mk();
  assert.equal(await r.report(), 'sent');
  assert.equal(await r.report(), 'unchanged');
  assert.equal(sent.length, 1);
  set({ players: [{ n: 2 }] });
  assert.equal(await r.report(), 'sent');
  assert.equal(await r.report({ force: true }), 'sent');
  assert.equal(sent.length, 3);
});

test('reporter stops for the session on 403 and on 404', async () => {
  for (const status of [403, 404]) {
    const { r, sent } = mk(() => { throw Object.assign(new Error('x'), { status }); });
    assert.equal(await r.report(), 'stopped');
    assert.equal(r.stopped, true);
    assert.equal(await r.report({ force: true }), 'stopped');
    assert.equal(sent.length, 1);
  }
});

test('reporter logs a 400 once and keeps going', async () => {
  const { r, logs, sent } = mk(() => { throw Object.assign(new Error('x'), { status: 400 }); });
  assert.equal(await r.report(), 'failed');
  assert.equal(await r.report(), 'failed');
  assert.equal(r.stopped, false);
  assert.equal(sent.length, 2);
  assert.equal(logs.filter((l) => l.includes('400')).length, 1);
});

test('a failed send is retried on the next report even with an unchanged body', async () => {
  let fail = true;
  const { r, sent } = mk(() => { if (fail) throw Object.assign(new Error('x'), { status: 500 }); });
  assert.equal(await r.report(), 'failed');
  fail = false;
  assert.equal(await r.report(), 'sent');
  assert.equal(sent.length, 2);
});

test('a build error is swallowed and reported as failed', async () => {
  const r = new PlayerReporter({ send: async () => {}, build: () => { throw new Error('boom'); } });
  assert.equal(await r.report(), 'failed');
});

test('overlapping reports do not double-send', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { r, sent } = mk(() => gate);
  const first = r.report();
  assert.equal(await r.report({ force: true }), 'busy');
  release();
  assert.equal(await first, 'sent');
  assert.equal(sent.length, 1);
});
