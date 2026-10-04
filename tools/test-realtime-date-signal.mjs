#!/usr/bin/env node
/**
 * `GET /calendar/date` carries `tracks_real_time` (the composed
 * `UsesRealTime()` predicate). This module pauses date-PUSH only
 * (pull/event sync untouched) at the one push site, `CalendarSync.pushDate`.
 *
 * Covers:
 *   1. Skip push when tracks_real_time === true (fetch-before-push).
 *   2. Proceed when false/absent (legacy Chronicle deploys never emit the
 *      field at all — must not be treated as "blocked").
 *   3. A 422 backstop rejection sets the guard WITHOUT throwing/logging as a
 *      generic sync error.
 *   4. The GM notice fires exactly once per session, shared across
 *      CalendarSync instances.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub the Foundry globals calendar-sync.mjs touches at module-load time
// (mirrors tools/test-calendar-backcatalog-fix.mjs).
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => null, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const {
  tracksRealTime,
  isRealTimeRejection,
  shouldSkipDatePush,
  notifyRealTimePushPaused,
  _resetRealtimeDateGuardForTests,
} = await import('../scripts/_realtime-date-guard.mjs');
const { CalendarSync } = await import('../scripts/calendar-sync.mjs');

function makeCalendarSync(overrides) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    {},
    overrides,
  );
}

// A fake ChronicleAPI: `get` answers the fetch-before-push probe, `put`
// records pushes (or throws, per test).
function makeApi({ getResult, getError, putImpl } = {}) {
  const gets = [];
  const puts = [];
  return {
    gets,
    puts,
    async get(path) {
      gets.push(path);
      if (getError) throw getError;
      return getResult;
    },
    async put(path, body) {
      puts.push({ path, body });
      if (putImpl) return putImpl(path, body);
      return { id: 'ok' };
    },
  };
}

test.beforeEach(() => {
  _resetRealtimeDateGuardForTests();
  globalThis.game.settings.get = () => true; // syncCalendar on
  globalThis.ui = { notifications: { warn: () => {} } };
});

// ── Pure helpers ──────────────────────────────────────────────────────────

test('tracksRealTime: reads the field defensively (envelope-audit convention)', () => {
  assert.equal(tracksRealTime({ tracks_real_time: true }), true);
  assert.equal(tracksRealTime({ tracks_real_time: false }), false);
  assert.equal(tracksRealTime({}), false);
  assert.equal(tracksRealTime(null), false);
  assert.equal(tracksRealTime(undefined), false);
  assert.equal(tracksRealTime({ tracks_real_time: 1 }), false, 'truthy non-boolean must not pass');
  assert.equal(tracksRealTime('nope'), false);
});

test('isRealTimeRejection: 422 via explicit err.status', () => {
  assert.equal(isRealTimeRejection({ status: 422, message: 'whatever' }), true);
});

test('isRealTimeRejection: 422 via the api-client "Chronicle API error 422:" message prefix', () => {
  assert.equal(isRealTimeRejection(new Error('Chronicle API error 422: {"message":"real-time calendar"}')), true);
});

test('isRealTimeRejection: other statuses (404, 409, 500) are not the real-time guard', () => {
  assert.equal(isRealTimeRejection(new Error('Chronicle API error 404: not found')), false);
  assert.equal(isRealTimeRejection({ status: 409, message: 'conflict' }), false);
  assert.equal(isRealTimeRejection(new Error('Chronicle API error 500: boom')), false);
});

test('isRealTimeRejection: a bare "422" substring in an unrelated message does not misclassify', () => {
  assert.equal(isRealTimeRejection(new Error('Entity named "Room 422" not found')), false);
});

test('isRealTimeRejection: null/undefined error does not throw', () => {
  assert.equal(isRealTimeRejection(null), false);
  assert.equal(isRealTimeRejection(undefined), false);
});

test('shouldSkipDatePush: true when the probe reports tracks_real_time', async () => {
  const api = makeApi({ getResult: { tracks_real_time: true } });
  assert.equal(await shouldSkipDatePush(api), true);
  assert.deepEqual(api.gets, ['/calendar/date']);
});

test('shouldSkipDatePush: false when absent (legacy Chronicle) or explicitly false', async () => {
  assert.equal(await shouldSkipDatePush(makeApi({ getResult: { year: 1492 } })), false);
  assert.equal(await shouldSkipDatePush(makeApi({ getResult: { tracks_real_time: false } })), false);
});

test('shouldSkipDatePush: a probe failure does not block the push (proceed, let the PUT itself fail/succeed)', async () => {
  const api = makeApi({ getError: new Error('network down') });
  assert.equal(await shouldSkipDatePush(api), false);
});

test('notifyRealTimePushPaused: fires the notification exactly once per session', () => {
  let warnCount = 0;
  globalThis.ui = { notifications: { warn: () => { warnCount += 1; } } };
  notifyRealTimePushPaused();
  notifyRealTimePushPaused();
  notifyRealTimePushPaused();
  assert.equal(warnCount, 1);
});

// ── calendar-sync.mjs: the push site ───────────────────────────────────────

for (const [label, method, payload] of [
  ['pushDate', 'pushDate', { year: 1492, month: 3, day: 15, hour: 9, minute: 30 }],
]) {
  test(`${label}: skips the push when GET /calendar/date reports tracks_real_time`, async () => {
    const api = makeApi({ getResult: { tracks_real_time: true } });
    const cs = makeCalendarSync({ _api: api });
    await cs[method](payload);
    assert.equal(api.puts.length, 0, 'must not PUT when the calendar tracks real time');
    assert.deepEqual(api.gets, ['/calendar/date'], 'must probe before deciding to skip');
  });

  test(`${label}: proceeds when tracks_real_time is false/absent`, async () => {
    const api = makeApi({ getResult: { tracks_real_time: false } });
    const cs = makeCalendarSync({ _api: api });
    await cs[method](payload);
    assert.equal(api.puts.length, 1, 'must still PUT when the flag is false');
  });

  test(`${label}: legacy Chronicle (field entirely absent) still proceeds`, async () => {
    const api = makeApi({ getResult: { year: 1492, month: 3, day: 15 } });
    const cs = makeCalendarSync({ _api: api });
    await cs[method](payload);
    assert.equal(api.puts.length, 1);
  });

  test(`${label}: a 422 backstop on the PUT sets the guard WITHOUT throwing`, async () => {
    const api = makeApi({
      getResult: { tracks_real_time: false },
      putImpl: () => { throw new Error('Chronicle API error 422: {"message":"real-time calendar is read-only for dates"}'); },
    });
    const cs = makeCalendarSync({ _api: api });
    await assert.doesNotReject(cs[method](payload));
  });

  test(`${label}: a genuine non-422 PUT failure still logs as an error (not swallowed as the guard)`, async () => {
    const api = makeApi({
      getResult: { tracks_real_time: false },
      putImpl: () => { throw new Error('Chronicle API error 500: boom'); },
    });
    const cs = makeCalendarSync({ _api: api });
    const originalError = console.error;
    let loggedErr = null;
    console.error = (...args) => { loggedErr = args; };
    try {
      await assert.doesNotReject(cs[method](payload));
    } finally {
      console.error = originalError;
    }
    assert.ok(loggedErr, 'a non-422 PUT failure must still be logged');
  });
}

// ── The notice is a shared, session-scoped singleton ───────────────────────

test('the one-time notice is shared across CalendarSync instances', async () => {
  let warnCount = 0;
  globalThis.ui = { notifications: { warn: () => { warnCount += 1; } } };

  const date = { year: 1492, month: 3, day: 15, hour: 9, minute: 30 };
  await makeCalendarSync({ _api: makeApi({ getResult: { tracks_real_time: true } }) }).pushDate(date);
  assert.equal(warnCount, 1, 'first blocked push notifies');

  await makeCalendarSync({ _api: makeApi({ getResult: { tracks_real_time: true } }) }).pushDate(date);
  assert.equal(warnCount, 1, 'a second instance reuses the already-shown session notice');
});
