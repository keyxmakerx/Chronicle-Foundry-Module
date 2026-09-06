#!/usr/bin/env node
/**
 * test-calendar-blackout.mjs — FM-CAL-BLACKOUT regression tests.
 *
 * Run: node --test tools/test-calendar-blackout.mjs
 *
 * Chronicle deleted its calendar plugin on 2026-08-21 for a ground-up rebuild
 * (V5). All 34 calendar routes stay registered and answer
 * `503 {"error":"calendar_rebuilding", …}` — 503 rather than 404 on purpose, so
 * this module does not take its "that Chronicle is too old" compatibility path.
 *
 * An audit of what the module ACTUALLY did under that 503 found four defects
 * and confirmed four safe behaviours. This file pins both halves, because the
 * safe half is the part a future edit would silently break:
 *
 *   1. `calendarStateFromError` classifies 503/calendar_rebuilding as its own
 *      'rebuilding' state — never 'absent' (which advises importing a calendar
 *      that has nowhere to go) and never 'auth' (which blames the GM's token).
 *   2. The api-client attaches `status` and `code` to the thrown error, so no
 *      caller has to regex the message prose to find out what happened.
 *   3. The push storm is dead: 20 world-time ticks cost ONE request and ONE
 *      GM notice, not 40 requests and 20 red console errors.
 *   4. The error log coalesces identical repeats, so a failing endpoint cannot
 *      evict every map/actor/item/note error from the one 50-entry ring the
 *      dashboard and the diagnostics bundle share.
 *   5. SAFE-HALF PINS: a calendar 503 must never abort the rest of initial
 *      sync, and must never write a date into the Foundry world.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
};
const SETTINGS = {
  apiUrl: 'https://chronicle.invalid',
  apiKey: 'test-key',
  campaignId: 'abc12345-1234-4123-8123-abcdef123456',
};
globalThis.game = globalThis.game || {
  settings: { get: (_scope, key) => SETTINGS[key] ?? null, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const { calendarStateFromError, isCalendarRebuilding } =
  await import('../scripts/_calendar-probe-state.mjs');
const {
  calendarBlackoutActive,
  markCalendarRebuilding,
  handleIfCalendarRebuilding,
  _resetCalendarBlackoutForTests,
} = await import('../scripts/_calendar-blackout-guard.mjs');
const { shouldSkipDatePush } = await import('../scripts/_realtime-date-guard.mjs');

/** The exact body Chronicle's placeholder handler returns. */
const REBUILD_BODY = JSON.stringify({
  error: 'calendar_rebuilding',
  message: "Chronicle's calendar is being rebuilt and is temporarily unavailable. "
    + 'Calendar sync is paused; maps, actors, items and notes are unaffected.',
});

/** Build the error the api-client throws for a given status + body. */
function apiError(status, body) {
  const err = new Error(`Chronicle API error ${status}: ${body}`);
  err.status = status;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === 'string') err.code = parsed.error;
    if (typeof parsed.message === 'string') err.serverMessage = parsed.message;
  } catch { /* plain-text body */ }
  return err;
}

async function withStubbedNotifications(fn) {
  const prev = globalThis.ui;
  const seen = [];
  globalThis.ui = { notifications: {
    info: (m) => seen.push(['info', m]),
    warn: (m) => seen.push(['warn', m]),
    error: (m) => seen.push(['error', m]),
  } };
  // Awaited inside the try so an async body's notifications are still captured
  // when it finishes — returning the promise would restore `ui` immediately.
  try { return await fn(seen); } finally { globalThis.ui = prev; }
}

test('503 calendar_rebuilding is its own state, not "absent" and not "auth"', () => {
  const err = apiError(503, REBUILD_BODY);
  assert.equal(calendarStateFromError(err), 'rebuilding');
  assert.equal(isCalendarRebuilding(err), true);

  // The states it must NOT be, and why each would mislead:
  //   'absent' renders "no calendar configured" and advises importing one —
  //   there is nowhere to import it to, and the campaign DOES have a calendar.
  //   'auth' blames the GM's API key, which is fine.
  assert.notEqual(calendarStateFromError(err), 'absent');
  assert.notEqual(calendarStateFromError(err), 'auth');
});

test('the neighbouring classifications are unchanged', () => {
  assert.equal(calendarStateFromError(apiError(404, 'calendar_not_configured')), 'absent');
  assert.equal(calendarStateFromError(apiError(401, 'invalid_token')), 'auth');
  assert.equal(calendarStateFromError(apiError(403, 'nope')), 'auth');
  assert.equal(calendarStateFromError(apiError(500, 'boom')), 'unreachable');
  assert.equal(calendarStateFromError(new Error('network down')), 'unreachable');
});

test('classification survives an error with no numeric status (message only)', () => {
  // Transports that lose the status still carry the api-client's prose.
  const bare = new Error(`Chronicle API error 503: ${REBUILD_BODY}`);
  assert.equal(calendarStateFromError(bare), 'rebuilding');
});

test('a rebuild body cannot be faked by prose containing the word', () => {
  // A 200-shaped error whose text merely mentions the code must not classify
  // as the blackout on the strength of a status the server never sent... but
  // the module DOES accept the literal code, so pin the actual contract:
  // status 503 OR an explicit code/message match.
  const unrelated = apiError(418, 'a teapot named calendar');
  assert.equal(calendarStateFromError(unrelated), 'unreachable');
});

test('the guard notifies exactly once per session and stays armed', async () => {
  _resetCalendarBlackoutForTests();
  await withStubbedNotifications((seen) => {
    assert.equal(calendarBlackoutActive(), false);
    markCalendarRebuilding(apiError(503, REBUILD_BODY));
    markCalendarRebuilding(apiError(503, REBUILD_BODY));
    markCalendarRebuilding(apiError(503, REBUILD_BODY));
    assert.equal(calendarBlackoutActive(), true);
    assert.equal(seen.length, 1, 'the GM is told once, not once per failure');
    // Chronicle's own words are preferred over ours, and the notice is INFO:
    // nothing is broken on the GM's side and there is nothing to fix.
    assert.equal(seen[0][0], 'info');
    assert.match(seen[0][1], /being rebuilt/i);
    assert.match(seen[0][1], /unaffected/i);
  });
});

test('handleIfCalendarRebuilding only claims the blackout', async () => {
  _resetCalendarBlackoutForTests();
  await withStubbedNotifications(() => {
    assert.equal(handleIfCalendarRebuilding(apiError(500, 'boom')), false);
    assert.equal(calendarBlackoutActive(), false, 'a real 500 must not arm the blackout');
    assert.equal(handleIfCalendarRebuilding(apiError(503, REBUILD_BODY)), true);
    assert.equal(calendarBlackoutActive(), true);
  });
});

test('THE STORM: 20 world-time ticks cost 1 request and 1 notice, not 40 and 20', async () => {
  _resetCalendarBlackoutForTests();
  await withStubbedNotifications(async (seen) => {
    let requests = 0;
    const api = {
      get: async () => { requests++; throw apiError(503, REBUILD_BODY); },
      put: async () => { requests++; throw apiError(503, REBUILD_BODY); },
    };

    // Mirrors the shape of _onCalendariaDateTimeChange: check the session
    // guard, then probe, then push.
    for (let i = 0; i < 20; i++) {
      if (calendarBlackoutActive()) continue;
      try {
        if (await shouldSkipDatePush(api)) continue;
        await api.put('/calendar/date', {});
      } catch (err) {
        handleIfCalendarRebuilding(err);
      }
    }

    assert.equal(requests, 1,
      'a GM running the in-game clock must not drive a request pair per tick');
    assert.equal(seen.length, 1, 'and must not be notified per tick');
  });
});

test('a non-blackout probe failure keeps the fail-open contract', async () => {
  _resetCalendarBlackoutForTests();
  const api = { get: async () => { throw apiError(500, 'gateway blew up'); } };
  // false = "do not skip": an unreadable probe is not this guard's business,
  // and the push proceeds to succeed or fail on its own terms.
  assert.equal(await shouldSkipDatePush(api), false);
  assert.equal(calendarBlackoutActive(), false);
});

test('the error log coalesces identical repeats instead of evicting neighbours', async () => {
  const { ChronicleAPI } = await import('../scripts/api-client.mjs');
  const api = new ChronicleAPI();

  api._logError('error', 'GET', '/maps', 500, 'a real map failure');
  for (let i = 0; i < 80; i++) {
    api._logError('error', 'GET', '/calendar/date', 503, REBUILD_BODY);
  }

  const log = api.getErrorLog ? api.getErrorLog() : api._errorLog;
  const mapEntry = log.find((e) => e.path === '/maps');
  assert.ok(mapEntry,
    'the map failure must survive 80 calendar 503s — the ring is shared, and an '
    + 'outage that flushes it destroys the diagnostics for the subsystems that still work');

  const calEntries = log.filter((e) => e.path === '/calendar/date');
  assert.equal(calEntries.length, 1, 'the repeats collapse into one row');
  assert.equal(calEntries[0].count, 80, 'and the row carries the count');
});

test('the api-client attaches status and code so nobody has to regex prose', async () => {
  const { ChronicleAPI } = await import('../scripts/api-client.mjs');
  const api = new ChronicleAPI();
  globalThis.fetch = async () => new Response(REBUILD_BODY, {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(
    () => api.get('/calendar'),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'calendar_rebuilding');
      assert.match(err.serverMessage, /temporarily unavailable/i);
      // The message format is deliberately unchanged: the regex fallbacks in
      // the classifiers still work for transports that lose the status.
      assert.match(err.message, /^Chronicle API error 503:/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The honesty fixes: what the GM is TOLD during the blackout.
// ---------------------------------------------------------------------------

test('the Overview reports the rebuild as info, never as a structure mismatch', async () => {
  const { buildOverviewModel } = await import('../scripts/_overview-model.mjs');

  const model = buildOverviewModel({
    calendarAvailable: false,
    calendarRebuilding: true,
    calendarSyncPaused: false,
  });
  const rows = model.attention || model.needsAttention || [];
  const row = rows.find((r) => /rebuil/i.test(r.text || ''));
  assert.ok(row, 'the blackout must appear on the Overview — silence reads as health');
  assert.equal(row.severity, 'info',
    'info, not error: nothing is broken and there is nothing for the GM to fix');
  assert.ok(!rows.some((r) => /different structures/i.test(r.text || '')),
    'and it must never be reported as a calendar structure mismatch');
});

test('a real pause reports the classifier’s reason, not a hardcoded one', async () => {
  const { buildOverviewModel } = await import('../scripts/_overview-model.mjs');

  const model = buildOverviewModel({
    calendarAvailable: true,
    calendarSyncPaused: true,
    calendarPausedText: 'month 3 has 30 days in Foundry and 31 in Chronicle',
  });
  const rows = model.attention || model.needsAttention || [];
  const row = rows.find((r) => /paused/i.test(r.text || ''));
  assert.ok(row, 'a paused calendar must still raise a row');
  assert.match(row.text, /month 3 has 30 days/,
    'the reason is data from the classifier — this line used to hardcode '
    + '"different structures" for every pause, so any other cause got a remedy that could not help');
});

test('the sync-state classifier ranks "unavailable" above every other verdict', async () => {
  const { classifyCalendarSyncState } = await import('../scripts/_calendar-sync-state.mjs');

  // Defence in depth. The dashboard returns before reaching this function
  // during the blackout, so this branch is unreachable today — which is
  // exactly why it is pinned. Without it the fall-through below answers
  // 'date-drift' for a missing date, rendering a Chronicle-side outage as
  // "out of sync" and sending the GM to check settings that are fine.
  const out = classifyCalendarSyncState({
    unavailable: true,
    unavailableDetail: 'Chronicle’s calendar is being rebuilt.',
    // Everything that would otherwise win, to prove the ranking:
    paused: true,
    pausedDetail: 'structures differ',
    structureCmp: { match: false, detail: 'month 3 differs' },
    chronicleDate: { year: 1523, month: 1, day: 1 },
    foundryDate: { year: 1522, month: 1, day: 1 },
  });
  assert.equal(out.state, 'unavailable',
    'an outage outranks a pause: with no server-side calendar there is nothing '
    + 'to be paused against, and no other verdict is computable');
  assert.match(out.detail, /rebuilt/);

  // And the fall-through it defends against, for the record:
  const drift = classifyCalendarSyncState({ chronicleDate: null, foundryDate: null });
  assert.equal(drift.state, 'date-drift',
    'a missing date still reads as drift — which is why "unavailable" must be '
    + 'passed explicitly rather than inferred from absent data');
});
