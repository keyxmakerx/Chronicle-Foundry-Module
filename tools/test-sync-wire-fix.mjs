// test-sync-wire-fix.mjs — FM-SYNC-WIRE-FIX-R1 behavioral pins for the wire fixes
// that can't be exercised through the pure helpers:
//   fix 1 — sync.status listener revives initial sync (accepts both emit shapes)
//   fix 2 — SimpleCalendar structure reader + the guard now covering the SC path
//   fix 4 — visibility toggle routes to POST /entities/:id/reveal (not a bare PUT)
//   fix 5 — item relations use the flat /relations/:id routes + snake_case body
//
// Run: node --test tools/test-sync-wire-fix.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Foundry global stubs shared by every import chain below ---
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
  user: { id: 'u1', isGM: true },
  journal: { find: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.CONST = globalThis.CONST || { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2, NONE: 0 } };
globalThis.Actor = globalThis.Actor || class {};

const { SyncManager } = await import('../scripts/sync-manager.mjs');
const { CalendarSync } = await import('../scripts/calendar-sync.mjs');
const { ItemSync } = await import('../scripts/item-sync.mjs');
const { SyncDashboard } = await import('../scripts/sync-dashboard.mjs');

// ═══════════════════════════════════════════════════════════════════════════
// Fix 1 — sync.status listener revives initial sync (FM-SYNC-1)
// ═══════════════════════════════════════════════════════════════════════════

function makeManagerSpy() {
  const sm = new SyncManager();
  let count = 0;
  sm._performInitialSync = async () => { count += 1; };
  return { sm, calls: () => count };
}

test('fix1: the UNWRAPPED emit shape {status:"connected"} fires initial sync (the actual bug)', async () => {
  const { sm, calls } = makeManagerSpy();
  await sm._onSyncStatus({ status: 'connected' });
  assert.equal(calls(), 1, 'initial sync fired for the real emit shape');
  assert.equal(sm._initialSyncDone, true, 'latch set so the reconnect resync path is now live');
});

test('fix1: the wrapped shape {payload:{status:"connected"}} still fires it (defensive)', async () => {
  const { sm, calls } = makeManagerSpy();
  await sm._onSyncStatus({ payload: { status: 'connected' } });
  assert.equal(calls(), 1);
  assert.equal(sm._initialSyncDone, true);
});

test('fix1: initial sync is one-shot — a second connected event does not re-run it', async () => {
  const { sm, calls } = makeManagerSpy();
  await sm._onSyncStatus({ status: 'connected' });
  await sm._onSyncStatus({ status: 'connected' });
  assert.equal(calls(), 1, 'the _initialSyncDone latch prevents a double initial sync');
});

test('fix1: a non-connected status never fires initial sync', async () => {
  const { sm, calls } = makeManagerSpy();
  await sm._onSyncStatus({ status: 'disconnected' });
  await sm._onSyncStatus({ payload: { status: 'reconnecting' } });
  await sm._onSyncStatus({});
  await sm._onSyncStatus(null);
  assert.equal(calls(), 0);
  assert.equal(sm._initialSyncDone, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 2 — SimpleCalendar structure reader + guard now covers the SC path
// ═══════════════════════════════════════════════════════════════════════════

function makeCalendarSync(overrides) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    { _hasModernCalendariaApi: false, _syncDepth: 0, _calendarSyncDisabled: false },
    overrides,
  );
}

test('fix2: _readActiveSimpleCalendarStructure reads getCurrentCalendar (numberOfDays + weekdays)', () => {
  globalThis.SimpleCalendar = {
    api: {
      getCurrentCalendar: () => ({
        name: 'Calendar of Harptos',
        months: [{ numberOfDays: 30 }, { numberOfDays: 30 }, { numberOfDays: 31 }],
        weekdays: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}], // 10-day tenday
      }),
    },
  };
  const cs = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  const s = cs._readActiveSimpleCalendarStructure();
  assert.equal(s.name, 'Calendar of Harptos');
  assert.deepEqual(s.monthDays, [30, 30, 31]);
  assert.equal(s.weekdayCount, 10);
  delete globalThis.SimpleCalendar;
});

test('fix2: _readActiveSimpleCalendarStructure falls back to getAllMonths/getAllWeekdays', () => {
  globalThis.SimpleCalendar = {
    api: {
      getAllMonths: () => [{ numberOfDays: 31 }, { numberOfDays: 28 }],
      getAllWeekdays: () => [{}, {}, {}, {}, {}, {}, {}],
    },
  };
  const cs = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  const s = cs._readActiveSimpleCalendarStructure();
  assert.deepEqual(s.monthDays, [31, 28]);
  assert.equal(s.weekdayCount, 7);
  delete globalThis.SimpleCalendar;
});

test('fix2: an unreadable SimpleCalendar structure returns null (guard fails OPEN)', () => {
  globalThis.SimpleCalendar = { api: {} }; // no readers at all
  const cs = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  assert.equal(cs._readActiveSimpleCalendarStructure(), null);
  delete globalThis.SimpleCalendar;
});

test('fix2: _readActiveFoundryStructure dispatches by module', () => {
  globalThis.SimpleCalendar = { api: { getAllMonths: () => [{ numberOfDays: 20 }], getAllWeekdays: () => [{}] } };
  const sc = makeCalendarSync({ _calendarModule: 'simple-calendar' });
  assert.deepEqual(sc._readActiveFoundryStructure().monthDays, [20]);
  const unknown = makeCalendarSync({ _calendarModule: null });
  assert.equal(unknown._readActiveFoundryStructure(), null);
  delete globalThis.SimpleCalendar;
});

test('fix2: onInitialSync PAUSES a SimpleCalendar world whose structure mismatches (was unguarded)', async () => {
  game.settings.get = (_scope, key) => (key === 'syncCalendar' ? true : '');
  globalThis.SimpleCalendar = {
    api: { getCurrentCalendar: () => ({ name: 'SC 2mo', months: [{ numberOfDays: 30 }, { numberOfDays: 30 }], weekdays: [{}, {}, {}, {}, {}, {}, {}] }) },
  };
  let setLocalCalled = false;
  const cs = makeCalendarSync({
    _calendarModule: 'simple-calendar',
    _api: { get: async () => ({ current_year: 1, current_month: 1, current_day: 1, months: new Array(12).fill({ days: 30 }), weekdays: new Array(7).fill({}) }) },
    _setLocalDate: async () => { setLocalCalled = true; return false; },
  });
  await cs.onInitialSync();
  assert.equal(cs._calendarSyncDisabled, true, 'SC structure mismatch pauses calendar sync');
  assert.equal(setLocalCalled, false, 'no date was written into the incompatible SC calendar');
  assert.match(cs._calendarMismatchDetail, /month count/);
  delete globalThis.SimpleCalendar;
});

test('fix2: onInitialSync does NOT pause a matching SimpleCalendar world (writes the date)', async () => {
  game.settings.get = (_scope, key) => (key === 'syncCalendar' ? true : '');
  globalThis.SimpleCalendar = {
    api: { getCurrentCalendar: () => ({ name: 'SC match', months: new Array(12).fill({ numberOfDays: 30 }), weekdays: new Array(7).fill({}) }) },
  };
  let setLocalCalled = false;
  const cs = makeCalendarSync({
    _calendarModule: 'simple-calendar',
    _api: { get: async () => ({ current_year: 1, current_month: 1, current_day: 1, months: new Array(12).fill({ days: 30 }), weekdays: new Array(7).fill({}) }) },
    _setLocalDate: async () => { setLocalCalled = true; return false; },
  });
  await cs.onInitialSync();
  assert.equal(cs._calendarSyncDisabled, false, 'a compatible SC structure does not pause');
  assert.equal(setLocalCalled, true, 'the date apply path runs when structures match');
  delete globalThis.SimpleCalendar;
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 4 — visibility toggle routes to POST /entities/:id/reveal
// ═══════════════════════════════════════════════════════════════════════════

function recordingApi() {
  const calls = [];
  const rec = (method) => async (path, body) => { calls.push({ method, path, body }); return {}; };
  return { calls, get: rec('GET'), post: rec('POST'), put: rec('PUT'), delete: rec('DELETE') };
}

test('fix4: _onToggleVisibility POSTs /entities/:id/reveal with {is_private} (never a bare PUT)', async () => {
  const api = recordingApi();
  // `api` is a getter over `_syncManager.api`, so inject through the manager.
  const dash = Object.assign(Object.create(SyncDashboard.prototype), {
    _syncManager: { api }, _cache: { entities: [] }, render: () => {},
  });
  await dash._onToggleVisibility('ent-42', false);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].path, '/entities/ent-42/reveal');
  assert.deepEqual(api.calls[0].body, { is_private: true });
  assert.equal(api.calls.some((c) => c.method === 'PUT'), false, 'no bare entity PUT');
});

test('fix4: _onBulkSetVisibility POSTs /reveal for each selected entity', async () => {
  const api = recordingApi();
  const dash = Object.assign(Object.create(SyncDashboard.prototype), {
    _syncManager: { api },
    _selectedEntities: new Set(['a', 'b']),
    _cache: {},
    _logActivity: () => {},
    render: () => {},
  });
  await dash._onBulkSetVisibility(true);
  assert.equal(api.calls.length, 2);
  assert.ok(api.calls.every((c) => c.method === 'POST' && /\/reveal$/.test(c.path)));
  assert.ok(api.calls.every((c) => c.body.is_private === true));
});

// ═══════════════════════════════════════════════════════════════════════════
// Fix 5 — item relations: flat /relations/:id routes + snake_case create body
// ═══════════════════════════════════════════════════════════════════════════

function makeItemSync(api) {
  const is = new ItemSync();
  is._api = api;
  is._syncing = false;
  return is;
}

function makeItem({ flags = {}, name = 'Sword', system = {} } = {}, actorFlags = {}) {
  const actor = new globalThis.Actor();
  actor.name = 'Hero';
  actor.getFlag = (_scope, key) => actorFlags[key];
  return {
    name,
    system,
    parent: actor,
    getFlag: (_scope, key) => flags[key],
    setFlag: async (_scope, key, val) => { flags[key] = val; },
  };
}

test('fix5: create SKIPS (no POST) when the item has no linked Chronicle entity, logging once', async () => {
  const api = recordingApi();
  const is = makeItemSync(api);
  const dbg = console.debug;
  let logs = 0;
  console.debug = () => { logs += 1; };
  try {
    // Two custom items, actor synced (source entity present), no item entityId flag.
    await is._handleCreateItem(makeItem({}, { entityId: 'actor-1' }), {}, 'u1');
    await is._handleCreateItem(makeItem({}, { entityId: 'actor-1' }), {}, 'u1');
  } finally {
    console.debug = dbg;
  }
  assert.equal(api.calls.length, 0, 'no relation POST for a target-less custom item');
  assert.equal(logs, 1, 'the skip notice is logged once per session, not per item');
});

test('fix5: create sends snake_case body + object metadata when a target entity IS linked', async () => {
  const api = recordingApi();
  const is = makeItemSync(api);
  const item = makeItem({ flags: { entityId: 'item-entity-9' }, name: 'Rope', system: { quantity: 3, equipped: false } }, { entityId: 'actor-1' });
  await is._handleCreateItem(item, {}, 'u1');
  assert.equal(api.calls.length, 1);
  const call = api.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/entities/actor-1/relations');
  // snake_case binding — the whole point of the fix.
  assert.equal(call.body.target_entity_id, 'item-entity-9');
  assert.equal(call.body.relation_type, 'Has Item');
  assert.equal(call.body.reverse_relation_type, 'In Inventory Of');
  assert.equal('targetEntityId' in call.body, false, 'no camelCase key leaks through');
  // metadata is a raw OBJECT, not a JSON-encoded string.
  assert.equal(typeof call.body.metadata, 'object');
  assert.equal(call.body.metadata.quantity, 3);
});

test('fix5: delete uses the FLAT route DELETE /relations/:relationId', async () => {
  const api = recordingApi();
  const is = makeItemSync(api);
  const item = makeItem({ flags: { relationId: 42 } }, { entityId: 'actor-1' });
  await is._handleDeleteItem(item, {}, 'u1');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'DELETE');
  assert.equal(api.calls[0].path, '/relations/42', 'flat route, not /entities/:id/relations/:id');
});

test('fix5: update uses PUT /relations/:relationId with an object metadata body', async () => {
  const api = recordingApi();
  const is = makeItemSync(api);
  const item = makeItem({ flags: { relationId: 42 }, system: { quantity: 5, equipped: true } }, { entityId: 'actor-1' });
  await is._handleUpdateItem(item, { system: { quantity: 5 } }, {}, 'u1');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'PUT');
  assert.equal(api.calls[0].path, '/relations/42', 'flat route, not /entities/:id/relations/:id/metadata');
  assert.equal(typeof api.calls[0].body.metadata, 'object');
  assert.equal(api.calls[0].body.metadata.quantity, 5);
  assert.equal(api.calls[0].body.metadata.equipped, true);
});
