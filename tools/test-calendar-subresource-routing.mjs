#!/usr/bin/env node
/**
 * test-calendar-subresource-routing.mjs — FM-SYNC-SUBRESOURCES-P1.
 *
 * Pins the WIRED half of the sub-resource arc — everything the pure-helper
 * suite (`test-calendar-subresources.mjs`) can't reach because it touches
 * `CalendarSync` state and stubbed Foundry globals:
 *
 *   1. Every handled `calendar.*` type routes to its handler.
 *   2. dm_only weather is NEVER exposed to players — announcements are GM
 *      whispers, and no branch ever posts an unwhispered ChatMessage.
 *   3. `calendar.structure.updated` (and its cycle/festival siblings) triggers
 *      a re-compare, pauses on a new incompatibility, un-pauses on recovery,
 *      and NEVER writes the structure into Foundry.
 *   4. The `default:` branch logs an unhandled `calendar.*` type exactly once
 *      per session and stays silent on non-calendar traffic.
 *
 * Run: node --test tools/test-calendar-subresource-routing.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Foundry global stubs (same shape as test-calendar-backcatalog-fix.mjs) ───

const settingValues = {
  syncCalendar: true,
  calendarAnnounceWeather: true,
  calendarAnnounceWorldstate: true,
  calendarAnnounceSeasonEra: true,
  calendarAnnounceMoon: false,
};

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (base) => base } },
};
globalThis.game = globalThis.game || {
  settings: { get: (_scope, key) => settingValues[key], register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

/** Every ChatMessage.create() call made during a test. */
let chatCalls = [];
globalThis.ChatMessage = {
  getWhisperRecipients: (which) => (which === 'GM' ? [{ id: 'gm-user-1' }, { id: 'gm-user-2' }] : []),
  create: (data) => { chatCalls.push(data); return Promise.resolve(data); },
};

/** Every ui.notifications call, so the un-pause notice can be asserted. */
let notices = [];
globalThis.ui = {
  notifications: {
    warn: (m) => notices.push({ level: 'warn', m }),
    info: (m) => notices.push({ level: 'info', m }),
    error: (m) => notices.push({ level: 'error', m }),
  },
};

const { CalendarSync } = await import('../scripts/calendar-sync.mjs');
const { emptySubresourceState } = await import('../scripts/_calendar-subresources.mjs');

/**
 * Build a CalendarSync without running the constructor (it registers hooks and
 * reads settings), seeded with the fields the sub-resource paths touch.
 */
function makeSync(overrides = {}) {
  return Object.assign(
    Object.create(CalendarSync.prototype),
    {
      _syncDepth: 0,
      _calendarModule: 'calendaria',
      _hasModernCalendariaApi: true,
      _calendarSyncDisabled: false,
      _calendarMismatchDetail: null,
      _structureChangedDetail: null,
      _subresourceState: emptySubresourceState(),
      _loggedUnhandledTypes: new Set(),
      _chronicleCalendar: null,
      _api: { get: async () => null },
    },
    overrides,
  );
}

function reset() {
  chatCalls = [];
  notices = [];
  for (const k of Object.keys(settingValues)) {
    settingValues[k] = { syncCalendar: true, calendarAnnounceMoon: false }[k] ?? true;
  }
  settingValues.syncCalendar = true;
  settingValues.calendarAnnounceMoon = false;
}

// A 12-month/7-weekday pair that compareCalendarStructures accepts.
const CHRONICLE_12x7 = {
  name: 'Harptos',
  months: Array.from({ length: 12 }, () => ({ days: 30 })),
  weekdays: Array.from({ length: 7 }, (_, i) => ({ name: `d${i}` })),
};
const FOUNDRY_12x7 = {
  name: 'Harptos (Foundry)',
  monthDays: Array.from({ length: 12 }, () => 30),
  weekdayCount: 7,
};
const FOUNDRY_15x6 = {
  name: 'Therin',
  monthDays: Array.from({ length: 15 }, () => 24),
  weekdayCount: 6,
};

// ── 1. Routing: each handled type reaches its handler ───────────────────────

test('every handled calendar.* type routes to its handler', async () => {
  reset();
  const seen = [];
  const cs = makeSync({
    _onChronicaleDateAdvanced: async () => seen.push('date'),
    _onChronicleEventCreated:  async () => seen.push('created'),
    _onChronicleEventUpdated:  async () => seen.push('updated'),
    _onChronicleEventDeleted:  async () => seen.push('deleted'),
    _onChronicleWeatherChanged: async () => seen.push('weather'),
    _onChronicleSubresourceChanged: async (t) => seen.push(`sub:${t}`),
    _onChronicleStructureUpdated: async (t) => seen.push(`struct:${t}`),
  });

  for (const type of [
    'calendar.date.advanced', 'calendar.event.created', 'calendar.event.updated',
    'calendar.event.deleted', 'calendar.weather.changed', 'calendar.worldstate.changed',
    'calendar.season.changed', 'calendar.era.changed', 'calendar.moon.phase_changed',
    'calendar.structure.updated', 'calendar.cycle.changed', 'calendar.festival.changed',
  ]) {
    await cs.onMessage({ type, payload: null });
  }

  assert.deepEqual(seen, [
    'date', 'created', 'updated', 'deleted',
    'weather',
    'sub:calendar.worldstate.changed',
    'sub:calendar.season.changed',
    'sub:calendar.era.changed',
    'sub:calendar.moon.phase_changed',
    'struct:calendar.structure.updated',
    'struct:calendar.cycle.changed',
    'struct:calendar.festival.changed',
  ]);
});

test('sub-resource messages are suppressed while calendar sync is paused', async () => {
  reset();
  const seen = [];
  const cs = makeSync({
    _calendarSyncDisabled: true,
    _onChronicleWeatherChanged: async () => seen.push('weather'),
    _onChronicleSubresourceChanged: async (t) => seen.push(t),
  });
  await cs.onMessage({ type: 'calendar.weather.changed', payload: { preset_label: 'Clear' } });
  await cs.onMessage({ type: 'calendar.season.changed', payload: { name: 'Spring' } });
  assert.deepEqual(seen, [], 'a paused module must not apply sub-resource state');
});

test('structure signals are processed EVEN WHILE PAUSED — the only recovery path', async () => {
  reset();
  let called = 0;
  const cs = makeSync({
    _calendarSyncDisabled: true,
    _onChronicleStructureUpdated: async () => { called += 1; },
  });
  await cs.onMessage({ type: 'calendar.structure.updated', payload: null });
  assert.equal(called, 1, 'structure.updated must run ahead of the pause guard');
});

test('sub-resource routing is off entirely when syncCalendar is disabled', async () => {
  reset();
  settingValues.syncCalendar = false;
  let called = 0;
  const cs = makeSync({ _onChronicleWeatherChanged: async () => { called += 1; } });
  await cs.onMessage({ type: 'calendar.weather.changed', payload: { preset_label: 'Clear' } });
  assert.equal(called, 0);
});

// ── 2. dm_only: announcements never reach players ───────────────────────────

test('SECURITY: weather announcements are GM whispers, never public chat', async () => {
  reset();
  const cs = makeSync({ _calendarModule: 'simple-calendar' }); // no Calendaria setter
  await cs._onChronicleWeatherChanged({
    preset_label: 'Unnatural darkness',
    zone_name: 'The Sunken Ward',
    description: 'dm_only mood — the party has not discovered this zone',
  });

  assert.equal(chatCalls.length, 1, 'exactly one chat line');
  const msg = chatCalls[0];
  assert.ok(Array.isArray(msg.whisper), 'whisper MUST be an array of user ids');
  assert.deepEqual(msg.whisper, ['gm-user-1', 'gm-user-2'], 'whisper targets only GM users');
  assert.ok(msg.whisper.length > 0, 'an empty whisper array is a PUBLIC message in Foundry');
  assert.match(msg.content, /Unnatural darkness/);
});

test('SECURITY: no sub-resource branch ever posts an unwhispered ChatMessage', async () => {
  reset();
  const cs = makeSync({ _calendarModule: 'simple-calendar' });
  settingValues.calendarAnnounceMoon = true; // turn every announcement on

  await cs._onChronicleWeatherChanged({ preset_label: 'Blood rain' });
  await cs._onChronicleSubresourceChanged('calendar.worldstate.changed', {
    date: { year: 1492, month: 3, day: 15 }, moodTint: { color: '#a00', intensity: 0.9 },
  });
  await cs._onChronicleSubresourceChanged('calendar.season.changed', { name: 'The Long Dark' });
  await cs._onChronicleSubresourceChanged('calendar.era.changed', { name: 'Age of Ash' });
  await cs._onChronicleSubresourceChanged('calendar.moon.phase_changed', {
    moon_id: 1, moon_name: 'Selûne', phase_name: 'Full',
  });

  assert.equal(chatCalls.length, 5, 'all five announced');
  for (const m of chatCalls) {
    assert.ok(Array.isArray(m.whisper) && m.whisper.length > 0,
      `unwhispered ChatMessage would be player-visible: ${JSON.stringify(m)}`);
  }
});

test('SECURITY: chat content is HTML-escaped at the boundary', async () => {
  reset();
  const cs = makeSync({ _calendarModule: 'simple-calendar' });
  await cs._onChronicleSubresourceChanged('calendar.season.changed', {
    name: '<img src=x onerror="alert(1)">',
  });
  assert.equal(chatCalls.length, 1);
  assert.doesNotMatch(chatCalls[0].content, /<img/);
  assert.match(chatCalls[0].content, /&lt;img/);
});

test('each announcement respects its own world setting', async () => {
  reset();
  const cs = makeSync({ _calendarModule: 'simple-calendar' });

  // Moon is OFF by default — state still updates, chat stays quiet.
  await cs._onChronicleSubresourceChanged('calendar.moon.phase_changed', {
    moon_id: 1, moon_name: 'Luna', phase_name: 'Full',
  });
  assert.equal(chatCalls.length, 0, 'moon announcements are off by default');
  assert.equal(cs._subresourceState.moons['1'].phase, 'Full', 'but the dashboard panel still updates');

  // Season/era ON by default.
  await cs._onChronicleSubresourceChanged('calendar.season.changed', { name: 'Spring' });
  assert.equal(chatCalls.length, 1);

  // Turn season/era off; nothing more posts.
  settingValues.calendarAnnounceSeasonEra = false;
  await cs._onChronicleSubresourceChanged('calendar.era.changed', { name: 'Fifth Age' });
  assert.equal(chatCalls.length, 1);
  assert.equal(cs._subresourceState.era.name, 'Fifth Age', 'panel updates regardless of the chat toggle');
});

// ── weather: Calendaria apply vs chat fallback ──────────────────────────────

test('weather is applied via a Calendaria setter when one exists — no chat line', async () => {
  reset();
  const applied = [];
  globalThis.CALENDARIA = { api: { setWeather: (d) => { applied.push(d); } } };
  const cs = makeSync({ _calendarModule: 'calendaria' });
  await cs._onChronicleWeatherChanged({ preset_label: 'Heavy snow', temperature_celsius: -8 });
  delete globalThis.CALENDARIA;

  assert.equal(applied.length, 1, 'handed to Calendaria');
  assert.equal(applied[0].label, 'Heavy snow');
  assert.equal(applied[0].temperature, -8);
  assert.equal(chatCalls.length, 0, 'no duplicate chat line once applied to the module');
});

test('weather degrades to chat when Calendaria exposes no setter', async () => {
  reset();
  globalThis.CALENDARIA = { api: { getCurrentWeather: () => ({}) } }; // reads only
  const cs = makeSync({ _calendarModule: 'calendaria' });
  await cs._onChronicleWeatherChanged({ preset_label: 'Heavy snow' });
  delete globalThis.CALENDARIA;

  assert.equal(chatCalls.length, 1, 'read-only Calendaria falls back to chat');
  assert.match(chatCalls[0].content, /Heavy snow/);
});

test('a failing Calendaria setter degrades to chat rather than losing the update', async () => {
  reset();
  globalThis.CALENDARIA = { api: { setWeather: () => { throw new Error('boom'); } } };
  const cs = makeSync({ _calendarModule: 'calendaria' });
  await cs._onChronicleWeatherChanged({ preset_label: 'Hail' });
  delete globalThis.CALENDARIA;

  assert.equal(chatCalls.length, 1, 'the update must survive an apply failure');
});

test('a null weather payload (zone-change ping) refetches GET /calendar/weather', async () => {
  reset();
  const gets = [];
  const cs = makeSync({
    _calendarModule: 'simple-calendar',
    _api: {
      get: async (p) => {
        gets.push(p);
        // The nested Weather model shape the REST endpoint returns.
        return { preset_label: 'Sandstorm', wind: { speed_tier: 'gale' }, zone_name: 'Waste' };
      },
    },
  });
  await cs._onChronicleWeatherChanged(null);

  assert.deepEqual(gets, ['/calendar/weather'], 'the zone ping must refetch, not no-op');
  assert.equal(chatCalls.length, 1);
  assert.match(chatCalls[0].content, /Sandstorm/);
  assert.match(chatCalls[0].content, /Waste/);
});

test('a null weather payload with a failing refetch is a quiet no-op', async () => {
  reset();
  const cs = makeSync({
    _calendarModule: 'simple-calendar',
    _api: { get: async () => { throw new Error('502'); } },
  });
  await cs._onChronicleWeatherChanged(null);
  assert.equal(chatCalls.length, 0);
  assert.equal(cs._syncDepth, 0, 'the reentrant guard must unwind even on the error path');
});

// ── 3. structure.updated → re-compare, never auto-apply ─────────────────────

test('structure.updated re-runs the comparison and pauses on a NEW incompatibility', async () => {
  reset();
  let structureWrites = 0;
  const cs = makeSync({
    _api: { get: async () => CHRONICLE_12x7 },
    _readActiveFoundryStructure: () => FOUNDRY_15x6,
    // Any call to the date/structure writers would be an auto-apply.
    _setLocalDate: async () => { structureWrites += 1; return true; },
  });
  await cs._onChronicleStructureUpdated('calendar.structure.updated');

  assert.equal(cs._calendarSyncDisabled, true, 'a now-incompatible structure must pause');
  assert.match(cs._calendarMismatchDetail, /12mo\/7wd/);
  assert.equal(cs._structureChangedDetail, null, 'the advisory does not co-exist with a pause');
  assert.equal(structureWrites, 0, 'NO auto-apply — the Foundry calendar is never rewritten');
  assert.ok(notices.some((n) => n.level === 'warn'), 'the operator is warned once');
});

test('structure.updated sets the advisory badge when the re-compare stays compatible', async () => {
  reset();
  const cs = makeSync({
    _api: { get: async () => CHRONICLE_12x7 },
    _readActiveFoundryStructure: () => FOUNDRY_12x7,
  });
  await cs._onChronicleStructureUpdated('calendar.structure.updated');

  assert.equal(cs._calendarSyncDisabled, false, 'a compatible structure must not pause');
  assert.match(cs._structureChangedDetail, /still compatible/);
  assert.match(cs._structureChangedDetail, /NOT modified/, 'the detail states no write happened');
});

test('structure.updated CLEARS a prior mismatch pause once the structures match again', async () => {
  reset();
  const cs = makeSync({
    _calendarSyncDisabled: true,
    _calendarMismatchDetail: 'Chronicle: Harptos 12mo/7wd · Foundry: Therin 15mo/6wd — month count',
    _api: { get: async () => CHRONICLE_12x7 },
    _readActiveFoundryStructure: () => FOUNDRY_12x7,
  });
  await cs._onChronicleStructureUpdated('calendar.structure.updated');

  assert.equal(cs._calendarSyncDisabled, false, 'the pause must lift when its cause is gone');
  assert.equal(cs._calendarMismatchDetail, null);
  assert.ok(notices.some((n) => n.level === 'info' && /resumed/.test(n.m)), 'the GM is told sync resumed');
});

test('structure.updated fails OPEN when either structure is unreadable', async () => {
  reset();
  // Foundry side unreadable.
  const a = makeSync({
    _api: { get: async () => CHRONICLE_12x7 },
    _readActiveFoundryStructure: () => null,
  });
  await a._onChronicleStructureUpdated('calendar.structure.updated');
  assert.equal(a._calendarSyncDisabled, false, 'unreadable Foundry structure must not pause');
  assert.equal(a._structureChangedDetail, null, 'and must not claim a verdict either');

  // Chronicle side unreadable.
  const b = makeSync({
    _api: { get: async () => ({ name: 'degraded', months: [] }) },
    _readActiveFoundryStructure: () => FOUNDRY_12x7,
  });
  await b._onChronicleStructureUpdated('calendar.structure.updated');
  assert.equal(b._calendarSyncDisabled, false);
  assert.equal(b._structureChangedDetail, null);
});

test('structure re-compare survives a /calendar fetch failure using the cached structure', async () => {
  reset();
  const cs = makeSync({
    _chronicleCalendar: CHRONICLE_12x7,
    _api: { get: async () => { throw new Error('offline'); } },
    _readActiveFoundryStructure: () => FOUNDRY_12x7,
  });
  await cs._onChronicleStructureUpdated('calendar.cycle.changed');
  assert.match(cs._structureChangedDetail, /calendar\.cycle\.changed/);
  assert.equal(cs._syncDepth, 0);
});

// ── 4. default: log-once for unhandled calendar.* types ─────────────────────

test('an unhandled calendar.* type logs exactly once per session', async () => {
  reset();
  const logs = [];
  const orig = console.debug;
  console.debug = (m) => logs.push(String(m));
  try {
    const cs = makeSync();
    await cs.onMessage({ type: 'calendar.weather.zones.changed', payload: null });
    await cs.onMessage({ type: 'calendar.weather.zones.changed', payload: null });
    await cs.onMessage({ type: 'calendar.weather.zones.changed', payload: null });
  } finally {
    console.debug = orig;
  }
  const hits = logs.filter((l) => l.includes('calendar.weather.zones.changed'));
  assert.equal(hits.length, 1, 'one debug line per type per session, not per broadcast');
  assert.match(hits[0], /unhandled calendar WebSocket type/);
});

test('non-calendar traffic never logs (every module sees every message)', async () => {
  reset();
  const logs = [];
  const orig = console.debug;
  console.debug = (m) => logs.push(String(m));
  try {
    const cs = makeSync();
    await cs.onMessage({ type: 'entity.updated', payload: {} });
    await cs.onMessage({ type: 'map.created', payload: {} });
    await cs.onMessage({ type: 'note.deleted', payload: {} });
  } finally {
    console.debug = orig;
  }
  assert.deepEqual(logs.filter((l) => l.includes('unhandled calendar')), []);
});

test('routed types never fall into the unhandled log', async () => {
  reset();
  const logs = [];
  const orig = console.debug;
  console.debug = (m) => logs.push(String(m));
  try {
    const cs = makeSync({
      _onChronicleWeatherChanged: async () => {},
      _onChronicleSubresourceChanged: async () => {},
      _onChronicleStructureUpdated: async () => {},
      _onChronicaleDateAdvanced: async () => {},
      _onChronicleEventCreated: async () => {},
      _onChronicleEventUpdated: async () => {},
      _onChronicleEventDeleted: async () => {},
    });
    for (const type of [
      'calendar.date.advanced', 'calendar.event.created', 'calendar.weather.changed',
      'calendar.season.changed', 'calendar.era.changed', 'calendar.moon.phase_changed',
      'calendar.worldstate.changed', 'calendar.structure.updated',
    ]) {
      await cs.onMessage({ type, payload: null });
    }
  } finally {
    console.debug = orig;
  }
  assert.deepEqual(logs.filter((l) => l.includes('unhandled calendar')), []);
});

// ── reentrancy discipline ───────────────────────────────────────────────────

test('every sub-resource handler unwinds the reentrant _syncDepth guard', async () => {
  reset();
  const cs = makeSync({ _calendarModule: 'simple-calendar' });
  await cs._onChronicleWeatherChanged({ preset_label: 'Clear' });
  await cs._onChronicleSubresourceChanged('calendar.season.changed', { name: 'Spring' });
  await cs._onChronicleStructureUpdated('calendar.structure.updated');
  assert.equal(cs._syncDepth, 0, 'a leaked depth would mask every later local hook');
  assert.equal(cs._syncing, false);
});
