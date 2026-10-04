#!/usr/bin/env node
/**
 * Pins the wired half of the sub-resource arc (the parts touching
 * `CalendarSync` state, complementing the pure-helper suite in
 * `test-calendar-subresources.mjs`):
 *
 *   1. Every handled `calendar.*` type routes to its handler.
 *   2. dm_only weather is NEVER exposed to players — announcements are GM
 *      whispers only.
 *   3. `calendar.structure.updated` (and its cycle/festival siblings)
 *      refetches Chronicle's calendar into the cache.
 *   4. The `default:` branch logs an unhandled `calendar.*` type once per
 *      session and stays silent on non-calendar traffic.
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

// ── 1. Routing: each handled type reaches its handler ───────────────────────

test('every handled calendar.* type routes to its handler', async () => {
  reset();
  const seen = [];
  const cs = makeSync({
    _onChronicleDateAdvanced: async () => seen.push('date'),
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
  const cs = makeSync();
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
  const cs = makeSync();
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
  const cs = makeSync();
  await cs._onChronicleSubresourceChanged('calendar.season.changed', {
    name: '<img src=x onerror="alert(1)">',
  });
  assert.equal(chatCalls.length, 1);
  assert.doesNotMatch(chatCalls[0].content, /<img/);
  assert.match(chatCalls[0].content, /&lt;img/);
});

test('each announcement respects its own world setting', async () => {
  reset();
  const cs = makeSync();

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

test('a null weather payload (zone-change ping) refetches GET /calendar/weather', async () => {
  reset();
  const gets = [];
  const cs = makeSync({
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
    _api: { get: async () => { throw new Error('502'); } },
  });
  await cs._onChronicleWeatherChanged(null);
  assert.equal(chatCalls.length, 0);
});

// ── 3. structure.updated → refetch into the cache ───────────────────────────

test('structure.updated refetches /calendar into the cache', async () => {
  reset();
  const fresh = { name: 'Harptos', months: [{ days: 30 }] };
  const cs = makeSync({ _api: { get: async () => fresh } });
  await cs._onChronicleStructureUpdated('calendar.structure.updated');
  assert.equal(cs._chronicleCalendar, fresh);
});

test('structure.updated survives a /calendar fetch failure and keeps the cached calendar', async () => {
  reset();
  const cached = { name: 'Harptos', months: [{ days: 30 }] };
  const cs = makeSync({
    _chronicleCalendar: cached,
    _api: { get: async () => { throw new Error('offline'); } },
  });
  await cs._onChronicleStructureUpdated('calendar.cycle.changed');
  assert.equal(cs._chronicleCalendar, cached);
});

test('structure signals never write into Foundry or post chat', async () => {
  reset();
  const cs = makeSync({ _api: { get: async () => ({ months: [{ days: 30 }] }) } });
  await cs.onMessage({ type: 'calendar.structure.updated', payload: null });
  assert.equal(chatCalls.length, 0);
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
      _onChronicleDateAdvanced: async () => {},
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
