#!/usr/bin/env node
/**
 * CalendarSync's side of the built-in calendar: the players' snapshot comes
 * only from players-audience reads and is saved only when it changes; a
 * calendar players can't see publishes a hidden snapshot; step, setDate and
 * addEvent write to Chronicle through the guarded routes.
 *
 * Run: `node --test tools/test-calendar-builtin.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const settings = new Map([['syncCalendar', true]]);
const saved = [];
globalThis.foundry = globalThis.foundry || { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } } };
globalThis.game = {
  settings: {
    get: (_m, k) => settings.get(k),
    set: async (_m, k, v) => { saved.push([k, v]); settings.set(k, v); },
    register: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {}, callAll: () => {} };

const { CalendarSync } = await import('../scripts/calendar-sync.mjs');

const cal = {
  current_year: 1492, current_month: 2, current_day: 30, current_hour: 23, current_minute: 0,
  hours_per_day: 24, minutes_per_hour: 60, visibility: 'everyone',
  months: [{ name: 'A', days: 30 }, { name: 'B', days: 30 }, { name: 'C', days: 30 }],
  weekdays: [{ name: 'X' }, { name: 'Y' }],
};

function makeApi(routes) {
  const calls = { get: [], put: [], post: [] };
  return {
    calls,
    async get(path) {
      calls.get.push(path);
      for (const [match, answer] of routes) {
        if (path.startsWith(match)) {
          if (answer instanceof Error) throw answer;
          return typeof answer === 'function' ? answer(path) : answer;
        }
      }
      return null;
    },
    async put(path, body) { calls.put.push([path, body]); return {}; },
    async post(path, body) { calls.post.push([path, body]); return { id: 'new' }; },
  };
}

function makeSync(api) {
  const cs = new CalendarSync();
  cs._api = api;
  cs._chronicleCalendar = { ...cal };
  return cs;
}

const err404 = Object.assign(new Error('Chronicle API error 404'), { status: 404 });

test('players snapshot is built only from players-audience reads', async () => {
  saved.length = 0;
  const api = makeApi([
    ['/calendar/date?audience=players', { year: 1492, month: 2, day: 30, hour: 23, audience: 'players', current_moon_phases: [{ moon_name: 'Seen' }] }],
    ['/calendar/events?', (p) => (p.includes('audience=players')
      ? { data: [{ id: 'p', name: 'Fair', year: 1492, month: 2, day: 3, visibility: 'everyone' }, { id: 'g', name: 'Plot', year: 1492, month: 2, day: 4, visibility: 'gm-only' }], audience: 'players' }
      : { data: [] })],
    ['/calendar?audience=players', cal],
  ]);
  const cs = makeSync(api);
  await cs.publishPlayerSnapshot();
  const playerReads = api.calls.get.filter((p) => p !== '/calendar');
  assert.ok(playerReads.length >= 3);
  for (const p of playerReads) assert.match(p, /audience=players/, `${p} must be a players read`);
  assert.equal(saved.length, 1);
  const [key, snap] = saved[0];
  assert.equal(key, 'calendarSnapshot');
  assert.deepEqual(snap.events.map((e) => e.id), ['p']);
  assert.deepEqual(snap.moons.map((m) => m.name), ['Seen']);
  await cs.publishPlayerSnapshot();
  assert.equal(saved.length, 1, 'an unchanged snapshot is not saved again');
});

test('a calendar players cannot see publishes a hidden snapshot', async () => {
  saved.length = 0;
  const cs = makeSync(makeApi([['/calendar?audience=players', err404]]));
  await cs.publishPlayerSnapshot();
  assert.equal(saved[0][1].hidden, true);
});

test('a failed players read keeps the last snapshot', async () => {
  saved.length = 0;
  const cs = makeSync(makeApi([['/calendar?audience=players', new Error('500')]]));
  const original = console.debug; console.debug = () => {};
  try { await cs.publishPlayerSnapshot(); } finally { console.debug = original; }
  assert.equal(saved.length, 0);
});

test('players never publish', async () => {
  saved.length = 0;
  game.user.isGM = false;
  try {
    const api = makeApi([['/calendar?audience=players', cal]]);
    await makeSync(api).publishPlayerSnapshot();
    assert.equal(api.calls.get.length, 0);
    assert.equal(saved.length, 0);
  } finally { game.user.isGM = true; }
});

test('step moves the date through PUT /calendar/date', async () => {
  const api = makeApi([['/calendar/date', { tracks_real_time: false }]]);
  const cs = makeSync(api);
  cs.scheduleRefresh = () => {};
  assert.equal(await cs.step('hour', 1), true);
  assert.deepEqual(api.calls.put, [['/calendar/date', { year: 1492, month: 3, day: 1, hour: 0, minute: 0 }]]);
  assert.deepEqual(cs.chronicleDate, { year: 1492, month: 3, day: 1, hour: 0, minute: 0 });
});

test('setDate refuses a date the calendar cannot hold without a request', async () => {
  const api = makeApi([]);
  const cs = makeSync(api);
  assert.equal(await cs.setDate({ year: 1492, month: 4, day: 1 }), false);
  assert.equal(api.calls.put.length, 0);
});

test('addEvent posts a Chronicle event with wire visibility', async () => {
  const api = makeApi([]);
  const cs = makeSync(api);
  cs.scheduleRefresh = () => {};
  assert.equal(await cs.addEvent({ name: ' Fair ', year: 1492, month: 1, day: 5 }), true);
  assert.equal(await cs.addEvent({ name: 'Plot', year: 1492, month: 1, day: 5, hour: 9, minute: 30, gmOnly: true }), true);
  assert.equal(await cs.addEvent({ name: '  ', year: 1492, month: 1, day: 5 }), false);
  assert.deepEqual(api.calls.post, [
    ['/calendar/events', { name: 'Fair', year: 1492, month: 1, day: 5, all_day: true, visibility: 'everyone' }],
    ['/calendar/events', { name: 'Plot', year: 1492, month: 1, day: 5, all_day: false, start_hour: 9, start_minute: 30, visibility: 'gm-only' }],
  ]);
});

test('a failed players events read keeps the last snapshot instead of blanking events', async () => {
  saved.length = 0;
  let n = 0;
  const cs = makeSync(makeApi([
    ['/calendar/date?audience=players', { year: 1492, month: 2, day: 30, audience: 'players' }],
    ['/calendar/events?', () => { n += 1; if (n === 2) throw new Error('500'); return { data: [], audience: 'players' }; }],
    ['/calendar?audience=players', cal],
  ]));
  const original = console.debug; console.debug = () => {};
  try { await cs.publishPlayerSnapshot(); } finally { console.debug = original; }
  assert.equal(saved.length, 0);
});
