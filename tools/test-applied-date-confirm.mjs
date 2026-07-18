#!/usr/bin/env node
/**
 * test-applied-date-confirm.mjs — FM-SYNC-CONFIRMED-DATE regression tests.
 *
 * Run: node --test tools/test-applied-date-confirm.mjs
 *
 * Pins the Foundry-side half of the applied-date upgrade (pairs with a
 * parallel Chronicle-side change, C-SYNC-APPLIED-BEACON):
 *   1. `_applied-date-confirm.mjs`'s pure helpers: 404/405 classification,
 *      the once-per-session debug-log tolerance, and confirmAppliedDate's
 *      request shape + non-throwing swallow behavior.
 *   2. `calendar-sync.mjs::_setLocalDate` reports whether it actually
 *      invoked a local calendar-module setter (Calendaria modern/legacy,
 *      SimpleCalendar) without throwing.
 *   3. Both apply call sites — the poll path (`onInitialSync`) and the
 *      WebSocket-driven path (`_onChronicaleDateAdvanced`) — confirm ONLY on
 *      real apply-success: never on a bare fetch, never on apply failure or
 *      a no-op (no calendar-module setter available).
 *   4. The confirm POST does not re-enter the `_syncDepth` reentrancy guard.
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
    { _hasModernCalendariaApi: true, _syncDepth: 0, _calendarSyncDisabled: false, _isActiveCalendarExcluded: () => false },
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

// ── calendar-sync.mjs: _setLocalDate reports whether a real apply happened ──

test('_setLocalDate: Calendaria modern API — setDateTime invoked, resolves true', async () => {
  let called = null;
  globalThis.CALENDARIA = { api: { setDateTime: async (d) => { called = d; } } };
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
  assert.equal(applied, true);
  assert.deepEqual(called, { year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
});

test('_setLocalDate: Calendaria legacy API — setDate invoked, resolves true', async () => {
  globalThis.game.Calendaria = { setDate: async () => {} };
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: false });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  assert.equal(applied, true);
  delete globalThis.game.Calendaria;
});

test('_setLocalDate: Calendaria detected but neither API surface present — no-op, resolves false', async () => {
  globalThis.CALENDARIA = undefined;
  delete globalThis.game.Calendaria;
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: false });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  assert.equal(applied, false);
});

test('_setLocalDate: Calendaria setDateTime throws — logs the error, resolves false', async () => {
  globalThis.CALENDARIA = { api: { setDateTime: async () => { throw new Error('boom'); } } };
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true });
  const original = console.error;
  let logged = null;
  console.error = (...args) => { logged = args; };
  let applied;
  try {
    applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  } finally {
    console.error = original;
  }
  assert.equal(applied, false);
  assert.ok(logged);
});

test('_setLocalDate: SimpleCalendar — setDate invoked (and awaited), resolves true', async () => {
  let called = null;
  globalThis.SimpleCalendar = { api: { setDate: async (d) => { called = d; } } };
  const cs = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
  assert.equal(applied, true);
  assert.deepEqual(called, { year: 1492, month: 2, day: 0, hour: 8, minute: 0, seconds: 0 });
});

test('_setLocalDate: SimpleCalendar detected but no setDate — no-op, resolves false', async () => {
  globalThis.SimpleCalendar = { api: {} };
  const cs = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  assert.equal(applied, false);
});

test('_setLocalDate: no calendar module detected at all — resolves false', async () => {
  const cs = makeCalendarSync({ _calendarModule: null });
  const applied = await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  assert.equal(applied, false);
});

test('_setLocalDate: the _syncDepth reentrancy guard still wraps the call (increments then decrements)', async () => {
  globalThis.CALENDARIA = {
    api: {
      setDateTime: async function () {
        assert.equal(this === undefined ? cs._syncDepth : cs._syncDepth, 1, '_syncDepth is 1 while the setter runs');
      },
    },
  };
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true, _syncDepth: 0 });
  assert.equal(cs._syncDepth, 0);
  await cs._setLocalDate({ year: 1492, month: 3, day: 1 });
  assert.equal(cs._syncDepth, 0, '_syncDepth unwound after the call');
});

// ── _onChronicaleDateAdvanced (WebSocket-driven apply path) ────────────────

test('_onChronicaleDateAdvanced: confirms ONLY after a real apply', async () => {
  globalThis.CALENDARIA = { api: { setDateTime: async () => {} } };
  const api = makeApi();
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true, _api: api });
  await cs._onChronicaleDateAdvanced({ year: 1492, month: 3, day: 1, hour: 8, minute: 0 });
  assert.deepEqual(api.posts, [
    { path: '/calendar/date/confirm', body: { year: 1492, month: 3, day: 1 } },
  ]);
});

test('_onChronicaleDateAdvanced: does NOT confirm when apply is a no-op (no calendar-module setter)', async () => {
  globalThis.CALENDARIA = undefined;
  delete globalThis.game.Calendaria;
  const api = makeApi();
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: false, _api: api });
  await cs._onChronicaleDateAdvanced({ year: 1492, month: 3, day: 1 });
  assert.equal(api.posts.length, 0);
});

test('_onChronicaleDateAdvanced: does NOT confirm when the local setter throws (apply failure)', async () => {
  globalThis.CALENDARIA = { api: { setDateTime: async () => { throw new Error('boom'); } } };
  const api = makeApi();
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true, _api: api });
  const original = console.error;
  console.error = () => {};
  try {
    await cs._onChronicaleDateAdvanced({ year: 1492, month: 3, day: 1 });
  } finally {
    console.error = original;
  }
  assert.equal(api.posts.length, 0);
});

test('_onChronicaleDateAdvanced: null data is a no-op (no apply, no confirm)', async () => {
  const api = makeApi();
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _api: api });
  await cs._onChronicaleDateAdvanced(null);
  assert.equal(api.posts.length, 0);
});

test('_onChronicaleDateAdvanced: confirm never re-enters the _syncDepth reentrancy guard', async () => {
  globalThis.CALENDARIA = { api: { setDateTime: async () => {} } };
  const depths = [];
  const api = makeApi({
    postImpl(path, body) {
      // The confirm POST fires strictly after _setLocalDate's finally block
      // has unwound the guard back to 0 — a confirm call that re-entered the
      // guard (or ran DURING the apply) would observe a nonzero depth here.
      depths.push(cs._syncDepth);
      return null;
    },
  });
  const cs = makeCalendarSync({ _calendarModule: 'calendaria', _hasModernCalendariaApi: true, _api: api, _syncDepth: 0 });
  await cs._onChronicaleDateAdvanced({ year: 1492, month: 3, day: 1 });
  assert.deepEqual(depths, [0]);
  assert.equal(cs._syncDepth, 0);
});

// ── onInitialSync (poll apply path) ─────────────────────────────────────────
// Uses the simple-calendar module so the Calendaria-only structure-mismatch
// guard (B-R2) never engages — out of scope here, covered by
// tools/test-calendar-sync-hotfix.mjs.

function makeInitialSyncHarness({ chronicleCalendar, setDateImpl, postImpl } = {}) {
  const api = makeApi({
    getImpl: (path) => (path === '/calendar' ? chronicleCalendar : null),
    postImpl,
  });
  globalThis.SimpleCalendar = { api: { setDate: setDateImpl ?? (async () => {}) } };
  const cs = makeCalendarSync({
    _calendarModule: 'simple-calendar',
    _api: api,
    getSetting: undefined,
  });
  return { cs, api };
}

test('onInitialSync: confirms the applied date after a successful poll-path apply', async () => {
  const chronicleCalendar = {
    current_year: 1492, current_month: 3, current_day: 1, current_hour: 8, current_minute: 0,
    months: [],
  };
  const { cs, api } = makeInitialSyncHarness({ chronicleCalendar });
  // getSetting('syncCalendar') is read at the top of onInitialSync via the
  // module-level import; stub it through globalThis.game.settings.get.
  globalThis.game.settings.get = () => true;
  await cs.onInitialSync();
  assert.deepEqual(api.posts, [
    { path: '/calendar/date/confirm', body: { year: 1492, month: 3, day: 1 } },
  ]);
});

test('onInitialSync: does NOT confirm when the poll-path apply is a no-op', async () => {
  const chronicleCalendar = {
    current_year: 1492, current_month: 3, current_day: 1, current_hour: 8, current_minute: 0,
    months: [],
  };
  const { cs, api } = makeInitialSyncHarness({ chronicleCalendar, setDateImpl: undefined });
  globalThis.SimpleCalendar = { api: {} }; // no setDate — apply is a no-op
  globalThis.game.settings.get = () => true;
  await cs.onInitialSync();
  assert.equal(api.posts.length, 0);
});

test('onInitialSync: no Chronicle calendar configured — no apply attempted, no confirm', async () => {
  const { cs, api } = makeInitialSyncHarness({ chronicleCalendar: null });
  globalThis.game.settings.get = () => true;
  await cs.onInitialSync();
  assert.equal(api.posts.length, 0);
});
