#!/usr/bin/env node
/**
 * Unit tests for the W5 Calendaria⇄Chronicle worldstate bridge
 * (cordinator#34) in `scripts/calendar-sync.mjs`.
 *
 * Pins: the value+time-window echo guards (both weather directions + the
 * date channels), the worldstate.changed↔date.advanced dedup, the
 * setWeather→setCustomWeather fallback, the celestial-note projection diff
 * (one note per type per day; dm_only→secret), the reserved-note skip in
 * the note-sync handlers (no bounce-back POST), and the syncWorldstate
 * setting gate.
 *
 * Run: `node --test tools/test-worldstate-bridge.mjs`
 * No mocking framework — Node's built-in `node:test` (Node ≥ 18).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Foundry global stubs (import-time requirements; see the visibility
// test for the pattern) ---
const settingValues = { syncCalendar: true, syncWorldstate: true };
globalThis.foundry = globalThis.foundry || {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (base) => base,
    },
  },
};
globalThis.game = {
  settings: {
    get: (_scope, key) => settingValues[key],
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true, getFlag: () => ({}), setFlag: async () => {} },
  modules: { get: () => null },
  journal: { get: () => null },
};
globalThis.Hooks = { on: () => {}, off: () => {} };

const {
  CalendarSync,
  WORLDSTATE_ECHO_WINDOW_MS,
  isEchoWithinWindow,
  worldstateDateKey,
  celestialMarkerFor,
  celestialTypeFromNote,
  isChronicleCelestialNote,
  celestialNoteVisibility,
  planCelestialProjection,
} = await import('../scripts/calendar-sync.mjs');

// --- test doubles ---

/** Fresh CalendarSync wired to a recording fake API + Calendaria stub. */
function makeSync({ getResponses = {}, calendaria = {} } = {}) {
  const calls = { get: [], put: [], post: [], delete: [] };
  const api = {
    get: async (path) => { calls.get.push(path); return getResponses[path] ?? null; },
    put: async (path, body) => { calls.put.push({ path, body }); return {}; },
    post: async (path, body) => { calls.post.push({ path, body }); return { id: 'evt-new' }; },
    delete: async (path) => { calls.delete.push(path); return {}; },
  };
  const calCalls = { setWeather: [], setCustomWeather: [], setDateTime: [], createNote: [], updateNote: [], deleteNote: [] };
  globalThis.CALENDARIA = {
    api: {
      setDateTime: async (d) => { calCalls.setDateTime.push(d); },
      setWeather: async (id, opts) => { calCalls.setWeather.push({ id, opts }); return true; },
      setCustomWeather: async (w) => { calCalls.setCustomWeather.push(w); return true; },
      getNotesForDate: () => [],
      createNote: async (n) => { calCalls.createNote.push(n); return { id: `note-${calCalls.createNote.length}` }; },
      updateNote: async (id, n) => { calCalls.updateNote.push({ id, ...n }); },
      deleteNote: async (id) => { calCalls.deleteNote.push(id); },
      getActiveCalendar: () => null,
      ...calendaria,
    },
  };
  const sync = new CalendarSync();
  sync._api = api;
  sync._calendarModule = 'calendaria';
  sync._hasModernCalendariaApi = true;
  return { sync, calls, calCalls };
}

function resetSettings() {
  settingValues.syncCalendar = true;
  settingValues.syncWorldstate = true;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

test('isEchoWithinWindow: same value inside window suppresses', () => {
  const now = 1_000_000;
  assert.ok(isEchoWithinWindow('rain', now - 1, 'rain', now));
  assert.ok(!isEchoWithinWindow('rain', now - WORLDSTATE_ECHO_WINDOW_MS - 1, 'rain', now), 'outside window syncs');
  assert.ok(!isEchoWithinWindow('rain', now - 1, 'snow', now), 'different value syncs');
  assert.ok(!isEchoWithinWindow(null, 0, 'rain', now), 'no prior value syncs');
  assert.ok(!isEchoWithinWindow('rain', now - 1, null, now), 'null incoming never matches');
});

test('worldstateDateKey: date-only, null for partial dates', () => {
  assert.equal(worldstateDateKey({ year: 1492, month: 6, day: 15 }), '1492-6-15');
  assert.equal(worldstateDateKey({ year: 1492, month: 6, day: 15, hour: 9 }), '1492-6-15');
  assert.equal(worldstateDateKey({ year: 1492 }), null);
  assert.equal(worldstateDateKey(null), null);
});

test('celestial marker round-trips through note content', () => {
  const marker = celestialMarkerFor('blood-moon');
  assert.equal(celestialTypeFromNote({ content: marker + 'Blood Moon' }), 'blood-moon');
  assert.equal(celestialTypeFromNote({ flagData: { content: marker } }), 'blood-moon');
  assert.ok(isChronicleCelestialNote({ content: marker }));
  assert.ok(!isChronicleCelestialNote({ content: 'an ordinary note' }));
  assert.ok(!isChronicleCelestialNote(null));
});

test('celestialNoteVisibility: dm_only -> secret, else visible', () => {
  assert.equal(celestialNoteVisibility({ visibility: 'dm_only' }), 'secret');
  assert.equal(celestialNoteVisibility({ visibility: 'everyone' }), 'visible');
  assert.equal(celestialNoteVisibility({}), 'visible');
});

test('planCelestialProjection: create/update/delete, one note per type', () => {
  const existing = [
    { id: 'n1', content: celestialMarkerFor('aurora') + 'Aurora' },
    { id: 'n2', content: celestialMarkerFor('comet') + 'Comet' },
  ];
  const seedEvents = [
    { type: 'aurora', name: 'Northern Lights' },           // update n1
    { type: 'blood-moon', name: 'Crimson Rise' },          // create
    { type: 'blood-moon', name: 'Duplicate ignored' },     // one per type
  ];
  const plan = planCelestialProjection(existing, seedEvents);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].note.id, 'n1');
  assert.equal(plan.updates[0].event.name, 'Northern Lights');
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].type, 'blood-moon');
  assert.deepEqual(plan.deletes.map((n) => n.id), ['n2']); // comet cleared
});

test('planCelestialProjection: empty inputs are safe', () => {
  assert.deepEqual(planCelestialProjection(null, null), { creates: [], updates: [], deletes: [] });
});

// ---------------------------------------------------------------------
// Weather: Calendaria -> Chronicle push
// ---------------------------------------------------------------------

test('weatherChange hook PUTs preset to /calendar/weather', async () => {
  resetSettings();
  const { sync, calls } = makeSync();
  await sync._onCalendariaWeatherChange({ presetId: 'thunderstorm', label: 'Thunderstorm' });
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].path, '/calendar/weather');
  assert.deepEqual(calls.put[0].body, { preset_id: 'thunderstorm', preset_label: 'Thunderstorm' });
});

test('weatherChange is suppressed when it echoes our own apply', async () => {
  resetSettings();
  const { sync, calls } = makeSync();
  await sync._applyChronicleWeather({ preset_id: 'rain' });
  await sync._onCalendariaWeatherChange({ presetId: 'rain' }); // echo of the apply
  assert.equal(calls.put.length, 0, 'echoed weatherChange must not PUT');
});

test('weatherChange gated by syncWorldstate=false', async () => {
  resetSettings();
  settingValues.syncWorldstate = false;
  const { sync, calls } = makeSync();
  await sync._onCalendariaWeatherChange({ presetId: 'rain' });
  assert.equal(calls.put.length, 0);
});

// ---------------------------------------------------------------------
// Weather: Chronicle -> Calendaria apply
// ---------------------------------------------------------------------

test('_applyChronicleWeather sets preset with allPeriods', async () => {
  resetSettings();
  const { sync, calCalls } = makeSync();
  await sync._applyChronicleWeather({ preset_id: 'blizzard' });
  assert.equal(calCalls.setWeather.length, 1);
  assert.equal(calCalls.setWeather[0].id, 'blizzard');
  assert.deepEqual(calCalls.setWeather[0].opts, { allPeriods: true });
  assert.equal(calCalls.setCustomWeather.length, 0);
});

test('_applyChronicleWeather falls back to setCustomWeather for unknown presets', async () => {
  resetSettings();
  const { sync, calCalls } = makeSync({
    calendaria: { setWeather: async () => { throw new Error('unknown preset'); } },
  });
  await sync._applyChronicleWeather({
    preset_id: 'fireflies', preset_label: 'Fireflies', color: '#9f9', description: 'Glowing swarms',
  });
  assert.equal(calCalls.setCustomWeather.length, 1);
  assert.equal(calCalls.setCustomWeather[0].label, 'Fireflies');
  assert.equal(calCalls.setCustomWeather[0].color, '#9f9');
});

test('_applyChronicleWeather skips its own push echoing back', async () => {
  resetSettings();
  const { sync, calCalls } = makeSync();
  await sync._onCalendariaWeatherChange({ presetId: 'hail' }); // GM set it locally, pushed
  await sync._applyChronicleWeather({ preset_id: 'hail' });    // WS echo comes back
  assert.equal(calCalls.setWeather.length, 0, 'echoed apply must not re-set Calendaria');
});

test('weather.changed message re-GETs and applies', async () => {
  resetSettings();
  const { sync, calls, calCalls } = makeSync({
    getResponses: { '/calendar/weather': { preset_id: 'fog' } },
  });
  await sync.onMessage({ type: 'calendar.weather.changed', payload: {} });
  assert.deepEqual(calls.get, ['/calendar/weather']);
  assert.equal(calCalls.setWeather.length, 1);
  assert.equal(calCalls.setWeather[0].id, 'fog');
});

// ---------------------------------------------------------------------
// worldstate.changed date handling + dedup vs date.advanced
// ---------------------------------------------------------------------

test('worldstate.changed applies date+weather once; duplicate date.advanced deduped', async () => {
  resetSettings();
  const cur = { year: 1492, month: 6, day: 16, hour: 9, minute: 30, current_weather: { preset_id: 'rain' } };
  const { sync, calCalls } = makeSync({
    getResponses: { '/calendar/date': cur, '/calendar/world-state': { date: { year: 1492, month: 6, day: 16 }, events: [] } },
  });
  await sync.onMessage({ type: 'calendar.worldstate.changed', payload: { date: { year: 1492, month: 6, day: 16 } } });
  assert.equal(calCalls.setDateTime.length, 1, 'date applied from the re-GET');
  assert.equal(calCalls.setDateTime[0].hour, 9, 'hour comes from the authoritative GET');
  assert.equal(calCalls.setWeather.length, 1, 'weather rides the same response');

  // The legacy channel announcing the SAME move must not re-apply.
  await sync.onMessage({ type: 'calendar.date.advanced', payload: { year: 1492, month: 6, day: 16 } });
  assert.equal(calCalls.setDateTime.length, 1, 'duplicate date.advanced deduped');
});

test('date.advanced still applies a genuinely new date', async () => {
  resetSettings();
  const { sync, calCalls } = makeSync();
  await sync.onMessage({ type: 'calendar.date.advanced', payload: { year: 1492, month: 6, day: 20 } });
  assert.equal(calCalls.setDateTime.length, 1);
  assert.equal(calCalls.setDateTime[0].day, 20);
});

test('dateTimeChange push suppressed when echoing our own apply (latent date loop)', async () => {
  resetSettings();
  const { sync, calls } = makeSync();
  await sync.onMessage({ type: 'calendar.date.advanced', payload: { year: 1492, month: 6, day: 21 } });
  // Calendaria fires dateTimeChange AFTER _setLocalDate's finally cleared _syncing.
  await sync._onCalendariaDateTimeChange({ year: 1492, month: 6, dayOfMonth: 21, hour: 0, minute: 0 });
  assert.equal(calls.put.length, 0, 'echoed dateTimeChange must not PUT the same date back');
});

// ---------------------------------------------------------------------
// Celestial-note projection
// ---------------------------------------------------------------------

test('projection creates one note per seed event with dm_only -> secret', async () => {
  resetSettings();
  const seed = {
    date: { year: 1492, month: 6, day: 15 },
    events: [
      { type: 'blood-moon', name: 'Crimson Rise', visibility: 'dm_only' },
      { type: 'aurora', name: 'Northern Lights', visibility: 'everyone' },
    ],
  };
  const { sync, calCalls } = makeSync({ getResponses: { '/calendar/world-state': seed } });
  await sync._refreshCelestialProjection();
  assert.equal(calCalls.createNote.length, 2);
  const bloodMoon = calCalls.createNote.find((n) => n.content.includes('chronicle-celestial:blood-moon'));
  assert.ok(bloodMoon, 'note carries the machine marker');
  assert.equal(bloodMoon.gmOnly, true);
  assert.equal(bloodMoon.visibility, 'secret');
  const aurora = calCalls.createNote.find((n) => n.content.includes('chronicle-celestial:aurora'));
  assert.equal(aurora.visibility, 'visible');
});

test('projection updates in place and deletes cleared events (never stacks)', async () => {
  resetSettings();
  const seed = { date: { year: 1492, month: 6, day: 15 }, events: [{ type: 'aurora', name: 'Renamed Lights' }] };
  const existing = [
    { id: 'n-aurora', content: celestialMarkerFor('aurora') + 'Aurora' },
    { id: 'n-comet', content: celestialMarkerFor('comet') + 'Comet' },
    { id: 'n-user', content: 'a hand-written GM note' }, // untouched
  ];
  const { sync, calCalls } = makeSync({
    getResponses: { '/calendar/world-state': seed },
    calendaria: { getNotesForDate: () => existing },
  });
  await sync._refreshCelestialProjection();
  assert.equal(calCalls.createNote.length, 0, 'existing type updates, never stacks');
  assert.equal(calCalls.updateNote.length, 1);
  assert.equal(calCalls.updateNote[0].id, 'n-aurora');
  assert.deepEqual(calCalls.deleteNote, ['n-comet'], 'cleared event deletes its note; user note untouched');
});

test('projection gated by syncWorldstate=false', async () => {
  resetSettings();
  settingValues.syncWorldstate = false;
  const { sync, calls, calCalls } = makeSync();
  await sync._refreshCelestialProjection();
  assert.equal(calls.get.length, 0);
  assert.equal(calCalls.createNote.length, 0);
});

// ---------------------------------------------------------------------
// Reserved-note echo prevention in the note-sync path
// ---------------------------------------------------------------------

test('projected celestial notes never bounce back as Chronicle events', async () => {
  resetSettings();
  const { sync, calls } = makeSync();
  const projected = {
    id: 'note-x',
    name: 'Blood Moon',
    content: celestialMarkerFor('blood-moon') + 'Blood Moon',
    flagData: { startDate: { year: 1492, month: 6, day: 15 } },
  };
  await sync._onCalendariaNoteCreated(projected);
  await sync._onCalendariaNoteUpdated(projected);
  await sync._onCalendariaNoteDeleted(projected);
  assert.equal(calls.post.length, 0, 'no POST /calendar/events for a projection');
  assert.equal(calls.put.length, 0);
  assert.equal(calls.delete.length, 0);
});

test('ordinary Calendaria notes still sync (guard is marker-scoped)', async () => {
  resetSettings();
  const { sync, calls } = makeSync();
  await sync._onCalendariaNoteCreated({
    id: 'note-y',
    name: 'Market Day',
    content: 'The stalls open at dawn.',
    flagData: { startDate: { year: 1492, month: 6, day: 15 } },
  });
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].path, '/calendar/events');
  assert.equal(calls.post[0].body.name, 'Market Day');
});

// ---------------------------------------------------------------------
// Note parity fields
// ---------------------------------------------------------------------

test('note->event payload carries color/icon/all_day/start time when present', async () => {
  resetSettings();
  const { sync } = makeSync();
  const payload = sync._calendariaNoteToChronicleEvent({
    name: 'Festival',
    color: '#f00',
    icon: 'fa-star',
    allDay: false,
    flagData: { startDate: { year: 1492, month: 6, day: 15, hour: 18, minute: 30 } },
  });
  assert.equal(payload.color, '#f00');
  assert.equal(payload.icon, 'fa-star');
  assert.equal(payload.all_day, false);
  assert.equal(payload.start_hour, 18);
  assert.equal(payload.start_minute, 30);
  // All-day notes carry no start time.
  const allDay = sync._calendariaNoteToChronicleEvent({
    name: 'Holiday', allDay: true,
    flagData: { startDate: { year: 1492, month: 6, day: 16 } },
  });
  assert.equal(allDay.all_day, true);
  assert.equal(allDay.start_hour, undefined);
});
