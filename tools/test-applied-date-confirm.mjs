#!/usr/bin/env node
/**
 * Pins the Foundry-side half of the applied-date confirmation flow:
 *   1. `_applied-date-confirm.mjs`'s pure helpers: 404/405 classification,
 *      the once-per-session debug-log tolerance, and confirmAppliedDate's
 *      request shape + non-throwing swallow behavior.
 *   2. `calendar-sync.mjs` posts no confirmation: it applies no date to
 *      Foundry, so there is nothing to confirm yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub the Foundry globals calendar-sync.mjs touches at module-load time
// (mirrors tools/test-calendar-backcatalog-fix.mjs / test-realtime-date-signal.mjs).
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
  isConfirmNotSupported,
  notifyConfirmNotSupportedOnce,
  confirmAppliedDate,
  _resetAppliedDateConfirmForTests,
} = await import('../scripts/_applied-date-confirm.mjs');
const { CalendarSync } = await import('../scripts/calendar-sync.mjs');

function makeCalendarSync(overrides) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    {},
    overrides,
  );
}

function makeApi({ postImpl, getImpl } = {}) {
  const posts = [];
  const gets = [];
  return {
    posts,
    gets,
    async post(path, body) {
      posts.push({ path, body });
      if (postImpl) return postImpl(path, body);
      return null;
    },
    async get(path) {
      gets.push(path);
      if (getImpl) return getImpl(path);
      return null;
    },
  };
}

test.beforeEach(() => {
  _resetAppliedDateConfirmForTests();
});

// ── isConfirmNotSupported ────────────────────────────────────────────────

test('isConfirmNotSupported: 404 via explicit err.status', () => {
  assert.equal(isConfirmNotSupported({ status: 404, message: 'whatever' }), true);
});

test('isConfirmNotSupported: 405 via explicit err.status', () => {
  assert.equal(isConfirmNotSupported({ status: 405, message: 'whatever' }), true);
});

test('isConfirmNotSupported: 404/405 via the api-client "Chronicle API error <n>:" message prefix', () => {
  assert.equal(isConfirmNotSupported(new Error('Chronicle API error 404: not found')), true);
  assert.equal(isConfirmNotSupported(new Error('Chronicle API error 405: method not allowed')), true);
});

test('isConfirmNotSupported: other statuses (422, 409, 500) are not the not-supported case', () => {
  assert.equal(isConfirmNotSupported(new Error('Chronicle API error 422: real-time calendar')), false);
  assert.equal(isConfirmNotSupported({ status: 409, message: 'conflict' }), false);
  assert.equal(isConfirmNotSupported(new Error('Chronicle API error 500: boom')), false);
});

test('isConfirmNotSupported: a bare "404" substring in an unrelated message does not misclassify', () => {
  assert.equal(isConfirmNotSupported(new Error('Entity named "Room 404" not found')), false);
});

test('isConfirmNotSupported: null/undefined error does not throw', () => {
  assert.equal(isConfirmNotSupported(null), false);
  assert.equal(isConfirmNotSupported(undefined), false);
});

// ── notifyConfirmNotSupportedOnce ────────────────────────────────────────

test('notifyConfirmNotSupportedOnce: logs exactly once per session', () => {
  let debugCount = 0;
  const original = console.debug;
  console.debug = () => { debugCount += 1; };
  try {
    notifyConfirmNotSupportedOnce();
    notifyConfirmNotSupportedOnce();
    notifyConfirmNotSupportedOnce();
  } finally {
    console.debug = original;
  }
  assert.equal(debugCount, 1);
});

// ── confirmAppliedDate ───────────────────────────────────────────────────

test('confirmAppliedDate: POSTs the applied date to /calendar/date/confirm', async () => {
  const api = makeApi();
  await confirmAppliedDate(api, { year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
  assert.deepEqual(api.posts, [
    { path: '/calendar/date/confirm', body: { year: 1492, month: 3, day: 1 } },
  ], 'body carries only year/month/day, extra fields dropped');
});

test('confirmAppliedDate: a 404 is tolerated silently (single debug log, no throw)', async () => {
  const api = makeApi({ postImpl: () => { throw new Error('Chronicle API error 404: not found'); } });
  let debugCount = 0;
  const original = console.debug;
  console.debug = () => { debugCount += 1; };
  try {
    await assert.doesNotReject(confirmAppliedDate(api, { year: 1492, month: 3, day: 1 }));
  } finally {
    console.debug = original;
  }
  assert.equal(debugCount, 1);
});

test('confirmAppliedDate: a 405 is tolerated the same way as a 404', async () => {
  const api = makeApi({ postImpl: () => { throw new Error('Chronicle API error 405: method not allowed'); } });
  await assert.doesNotReject(confirmAppliedDate(api, { year: 1492, month: 3, day: 1 }));
});

test('confirmAppliedDate: no retry storm — a repeated 404 across calls still logs once total', async () => {
  const api = makeApi({ postImpl: () => { throw new Error('Chronicle API error 404: not found'); } });
  let debugCount = 0;
  const original = console.debug;
  console.debug = () => { debugCount += 1; };
  try {
    await confirmAppliedDate(api, { year: 1492, month: 3, day: 1 });
    await confirmAppliedDate(api, { year: 1492, month: 3, day: 2 });
  } finally {
    console.debug = original;
  }
  assert.equal(debugCount, 1);
  assert.equal(api.posts.length, 2, 'each call still attempts once — no internal retry loop');
});

test('confirmAppliedDate: a genuine non-404/405 failure is swallowed, not thrown', async () => {
  const api = makeApi({ postImpl: () => { throw new Error('Chronicle API error 500: boom'); } });
  await assert.doesNotReject(confirmAppliedDate(api, { year: 1492, month: 3, day: 1 }));
  assert.equal(api.posts.length, 1);
});

test('confirmAppliedDate: null api or date is a no-op, never throws', async () => {
  await assert.doesNotReject(confirmAppliedDate(null, { year: 1492, month: 3, day: 1 }));
  await assert.doesNotReject(confirmAppliedDate(makeApi(), null));
});

// ── calendar-sync.mjs: nothing is applied, so nothing is confirmed ─────────
// TODO(#95): once the built-in calendar applies Chronicle's date, confirm it
// here only after a real apply.

function makeSync({ chronicleCalendar, api } = {}) {
  return makeCalendarSync({
    _api: api ?? makeApi({ getImpl: (path) => (path === '/calendar' ? chronicleCalendar : null) }),
  });
}

test('onInitialSync: caches Chronicle’s calendar and posts no confirm (no apply happened)', async () => {
  const chronicleCalendar = { current_year: 1492, current_month: 3, current_day: 1, current_hour: 8, current_minute: 0, months: [] };
  const cs = makeSync({ chronicleCalendar });
  globalThis.game.settings.get = () => true; // syncCalendar on
  assert.equal(await cs.onInitialSync(), true);
  assert.deepEqual(cs.chronicleDate, { year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
  assert.equal(cs._api.posts.length, 0);
});

test('onInitialSync: no Chronicle calendar configured — resolves false, no confirm', async () => {
  const cs = makeSync({ chronicleCalendar: null });
  globalThis.game.settings.get = () => true;
  assert.equal(await cs.onInitialSync(), false);
  assert.equal(cs._api.posts.length, 0);
});

test('onInitialSync: a failed fetch resolves false without throwing', async () => {
  const api = makeApi({ getImpl: () => { throw new Error('Chronicle API error 500: boom'); } });
  const cs = makeSync({ api });
  globalThis.game.settings.get = () => true;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await cs.onInitialSync(), false);
  } finally {
    console.error = original;
  }
});

test('onInitialSync: syncCalendar off — no request at all', async () => {
  const cs = makeSync({ chronicleCalendar: {} });
  globalThis.game.settings.get = () => false;
  assert.equal(await cs.onInitialSync(), false);
  assert.equal(cs._api.gets.length, 0);
});

test('calendar.date.advanced: updates the cached date and posts no confirm', async () => {
  const cs = makeSync({});
  cs._chronicleCalendar = { current_year: 1492, current_month: 3, current_day: 1 };
  globalThis.game.settings.get = () => true;
  await cs.onMessage({ type: 'calendar.date.advanced', payload: { year: 1492, month: 3, day: 2, hour: 8, minute: 0 } });
  assert.equal(cs.chronicleDate.day, 2);
  assert.equal(cs._api.posts.length, 0);
});
