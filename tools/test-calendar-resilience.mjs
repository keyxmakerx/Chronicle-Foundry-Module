#!/usr/bin/env node
/**
 * Calendar sync resilience: a bare 503 is not the rebuild blackout, the
 * blackout and a structure-mismatch pause heal without a world reload, Chronicle's
 * 400/422/403 refusals of a date push pause it with one notice, Simple Calendar
 * notes obey the mismatch guard and exclusions, and the echo guard is scoped to
 * the note being applied rather than global.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => null, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true, id: 'u1' },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const { calendarStateFromError } = await import('../scripts/_calendar-probe-state.mjs');
const blackout = await import('../scripts/_calendar-blackout-guard.mjs');
const refusal = await import('../scripts/_date-push-rejection.mjs');
const { _resetRealtimeDateGuardForTests } = await import('../scripts/_realtime-date-guard.mjs');
const { ApplyGuard, echoKey } = await import('../scripts/_apply-guard.mjs');
const { CalendarSync } = await import('../scripts/calendar-sync.mjs');

const REJECT = "Chronicle won't accept this date: its calendar has different months or leap days. Date sync is paused.";
const FORBID = "Only the campaign owner's key can change Chronicle's date. Date sync is paused.";

function apiError(status, body) {
  const err = new Error(`Chronicle API error ${status}: ${body}`);
  err.status = status;
  try {
    const p = JSON.parse(body);
    if (typeof p.error === 'string') err.code = p.error;
    if (typeof p.message === 'string') err.serverMessage = p.message;
  } catch { /* plain text */ }
  return err;
}

function makeCS(overrides = {}) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    { _hasModernCalendariaApi: true, _syncDepth: 0, _calendarSyncDisabled: false, _calendarModule: 'calendaria' },
    overrides,
  );
}

async function capture(fn) {
  const notes = [];
  const prev = { ui: globalThis.ui, err: console.error, warn: console.warn };
  const errors = [];
  globalThis.ui = { notifications: { info: (m) => notes.push(m), warn: (m) => notes.push(m), error: (m) => notes.push(m) } };
  console.error = (...a) => errors.push(a);
  console.warn = () => {};
  try { await fn(); } finally { globalThis.ui = prev.ui; console.error = prev.err; console.warn = prev.warn; }
  return { notes, errors };
}

test.beforeEach(() => {
  blackout._resetCalendarBlackoutForTests();
  refusal._resetDatePushRefusalForTests();
  _resetRealtimeDateGuardForTests();
});

// ── Item 1: blackout only for calendar_rebuilding, self-healing ─────────────

test('a bare 503 (proxy, restart) is unreachable, not the rebuild blackout', () => {
  assert.equal(calendarStateFromError(apiError(503, '<html>Bad gateway</html>')), 'unreachable');
  assert.equal(calendarStateFromError({ status: 503 }), 'unreachable');
  assert.equal(blackout.handleIfCalendarRebuilding(apiError(503, 'upstream down')), false);
  assert.equal(blackout.calendarBlackoutActive(), false);
});

test('a 503 whose body says calendar_rebuilding is the blackout', () => {
  const e = apiError(503, JSON.stringify({ error: 'calendar_rebuilding', message: 'm' }));
  assert.equal(calendarStateFromError(e), 'rebuilding');
});

test('blackout suppresses pushes for the retry window, then lets one through', () => {
  const t0 = 1_000_000;
  blackout.markCalendarRebuilding(null, t0);
  assert.equal(blackout.calendarBlackoutActive(t0 + 1000), true);
  assert.equal(blackout.calendarBlackoutActive(t0 + blackout.BLACKOUT_RETRY_MS + 1), false);
});

test('the next good calendar answer clears the blackout silently', async () => {
  const { notes } = await capture(async () => {
    blackout.markCalendarRebuilding(null);
    assert.equal(blackout.calendarBlackoutActive(), true);
    blackout.noteCalendarAnswerOk();
    assert.equal(blackout.calendarBlackoutActive(), false);
  });
  assert.equal(notes.length, 1, 'only the arming notice; clearing says nothing');
});

test('a successful date push after the blackout window clears it', async () => {
  blackout.markCalendarRebuilding(null, Date.now() - blackout.BLACKOUT_RETRY_MS - 1);
  const api = { get: async () => ({}), put: async () => ({}) };
  const cs = makeCS({ _api: api });
  await cs._onLocalDateChange({ year: 1, month: 1, day: 1 });
  assert.equal(blackout.calendarBlackoutActive(Date.now() + 1), false);
});

// ── Item 2: mismatch pause clears on a pull ─────────────────────────────────

test('onInitialSync re-checks structure while paused and resumes when it matches', async () => {
  const cal = { months: [{ days: 30 }, { days: 30 }], weekdays: [{}, {}], current_year: 1, current_month: 1, current_day: 1 };
  const cs = makeCS({
    _calendarSyncDisabled: true,
    _calendarMismatchDetail: 'x',
    _api: { get: async () => cal, put: async () => ({}), post: async () => ({}) },
    _readActiveFoundryStructure: () => ({ name: 'F', monthDays: [30, 30], weekdayCount: 2 }),
    _setLocalDate: async () => false,
  });
  // getSetting('syncCalendar') reads game.settings.get; stub it truthy.
  const prev = globalThis.game.settings.get;
  globalThis.game.settings.get = () => true;
  try {
    const { notes } = await capture(() => cs.onInitialSync());
    assert.equal(cs._calendarSyncDisabled, false);
    assert.equal(cs._calendarMismatchDetail, null);
    assert.ok(notes.some((m) => /resumed/.test(m)));
  } finally { globalThis.game.settings.get = prev; }
});

test('onInitialSync keeps the pause (and does not re-warn) while still mismatched', async () => {
  const cal = { months: [{ days: 30 }], weekdays: [{}], current_year: 1 };
  const cs = makeCS({
    _calendarSyncDisabled: true,
    _api: { get: async () => cal },
    _readActiveFoundryStructure: () => ({ name: 'F', monthDays: [31, 31], weekdayCount: 7 }),
  });
  const prev = globalThis.game.settings.get;
  globalThis.game.settings.get = () => true;
  try {
    const { notes } = await capture(async () => { assert.equal(await cs.onInitialSync(), false); });
    assert.equal(cs._calendarSyncDisabled, true);
    assert.equal(notes.length, 0);
  } finally { globalThis.game.settings.get = prev; }
});

// ── Items 3 + 4: 400/422/403 refusals ───────────────────────────────────────

for (const [status, text] of [[400, REJECT], [422, REJECT], [403, FORBID]]) {
  test(`a ${status} on a date push pauses it with one exact notice and no console.error`, async () => {
    const api = { get: async () => ({}), put: async () => { throw apiError(status, JSON.stringify({ error: 'x' })); }, puts: 0 };
    const cs = makeCS({ _api: api });
    const { notes, errors } = await capture(async () => {
      await cs._onLocalDateChange({ year: 1, month: 1, day: 1 });
      await cs._onLocalDateChange({ year: 1, month: 1, day: 2 });
      await cs._onLocalDateChange({ year: 1, month: 1, day: 3 });
    });
    assert.deepEqual(notes, [text]);
    assert.equal(errors.length, 0);
    assert.equal(refusal.datePushPaused(), true);
  });
}

test('once paused, later date pushes cost no request', async () => {
  let puts = 0;
  const api = { get: async () => ({}), put: async () => { puts++; throw apiError(400, '{}'); } };
  const cs = makeCS({ _api: api });
  await capture(async () => {
    await cs._onLocalDateChange({ year: 1, month: 1, day: 1 });
    await cs._onLocalDateChange({ year: 1, month: 1, day: 2 });
  });
  assert.equal(puts, 1);
});

test('a 422 about real-time tracking keeps the real-time notice, not the calendar-shape one', () => {
  assert.equal(refusal.handleDatePushRefusal(apiError(422, '{"message":"real-time calendar is read-only"}')), false);
});

test('a 500 is not a refusal and still logs as an error', async () => {
  const api = { get: async () => ({}), put: async () => { throw apiError(500, 'boom'); } };
  const cs = makeCS({ _api: api });
  const { errors } = await capture(() => cs._onLocalDateChange({ year: 1, month: 1, day: 1 }));
  assert.equal(errors.length, 1);
  assert.equal(refusal.datePushPaused(), false);
});

// ── Item 5: Simple Calendar notes obey mismatch guard + exclusions ──────────

const scJournal = { id: 'j1', name: 'Fair', flags: { 'foundryvtt-simple-calendar': { noteData: { startDate: { year: 1, month: 0, day: 0 } } } },
  getFlag: () => null, setFlag: async () => {} };

for (const [label, method, args] of [
  ['create', '_onSimpleCalendarNoteCreate', [scJournal, {}, 'u1']],
  ['update', '_onSimpleCalendarNoteUpdate', [scJournal, {}, {}, 'u1']],
  ['delete', '_onSimpleCalendarNoteDelete', [scJournal, {}, 'u1']],
]) {
  test(`SC note ${label}: no request while the mismatch pause is on`, async () => {
    const calls = [];
    const api = { post: async (...a) => calls.push(a), put: async (...a) => calls.push(a), delete: async (...a) => calls.push(a) };
    const cs = makeCS({ _calendarModule: 'simple-calendar', _calendarSyncDisabled: true, _api: api, _getChronicleEventId: () => 'c1' });
    await cs[method](...args);
    assert.equal(calls.length, 0);
  });

  test(`SC note ${label}: no request for an excluded calendar`, async () => {
    const calls = [];
    const api = { post: async (...a) => calls.push(a), put: async (...a) => calls.push(a), delete: async (...a) => calls.push(a) };
    const cs = makeCS({ _calendarModule: 'simple-calendar', _api: api, _getChronicleEventId: () => 'c1', _isActiveCalendarExcluded: () => true });
    await cs[method](...args);
    assert.equal(calls.length, 0);
  });
}

// ── Item 6: per-note echo guard ──────────────────────────────────────────────

test('ApplyGuard: ids and keys are reference-counted and released', () => {
  const g = new ApplyGuard();
  const k = echoKey({ name: 'A', year: 1, month: 2, day: 3 });
  const t1 = g.begin({ ids: ['n1'], keys: [k] });
  const t2 = g.begin({ ids: ['n1'] });
  g.end(t1);
  assert.equal(g.isEcho({ id: 'n1' }), true, 'still held by the overlapping apply');
  assert.equal(g.isEcho({ key: k }), false);
  g.end(t2);
  assert.equal(g.isEcho({ id: 'n1' }), false);
});

test('during a pull, the applied note is ignored but an unrelated GM edit pushes', async () => {
  const posts = [];
  const cs = makeCS({
    _api: { post: async (p, b) => { posts.push(b); return { id: 'c9' }; } },
    _storeEventMapping: async () => {},
    _isActiveCalendarExcluded: () => false,
  });
  globalThis.CALENDARIA = { api: { createNote: async (n) => {
    await cs._onCalendariaNoteCreated({ id: 'echo-1', name: n.name, startDate: n.startDate });
    await cs._onCalendariaNoteCreated({ id: 'gm-1', name: 'GM edit', startDate: { year: 1492, month: 7, day: 7 } });
    return { id: 'echo-1' };
  } } };
  try {
    await cs._createLocalEvent({ id: 'e1', name: 'Fair', year: 1492, month: 2, day: 3 });
  } finally { delete globalThis.CALENDARIA; }
  assert.equal(posts.length, 1, 'only the unrelated GM note was pushed');
  assert.equal(posts[0].name, 'GM edit');
});

test('a structure refetch no longer mutes date pushes', async () => {
  const cs = makeCS({
    _api: { get: async () => null },
    _readActiveFoundryStructure: () => null,
  });
  await cs._onChronicleStructureUpdated();
  assert.equal(cs._syncing, false);
});

test('a paused date push resumes after resumeDatePush without a second notice', async () => {
  const m = await import('../scripts/_date-push-rejection.mjs');
  m._resetDatePushRefusalForTests();
  const before = globalThis.ui?.notifications;
  const warned = [];
  globalThis.ui = { ...(globalThis.ui || {}), notifications: { warn: (x) => warned.push(x), info: () => {} } };
  assert.equal(m.handleDatePushRefusal({ status: 422, message: 'bad month' }), true);
  assert.equal(m.datePushPaused(), true);
  m.resumeDatePush();
  assert.equal(m.datePushPaused(), false);
  m.handleDatePushRefusal({ status: 422, message: 'bad month' });
  assert.equal(m.datePushPaused(), true);
  assert.equal(warned.length, 1);
  globalThis.ui.notifications = before;
  m._resetDatePushRefusalForTests();
});
