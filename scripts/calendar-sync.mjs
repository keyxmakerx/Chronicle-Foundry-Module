/**
 * Chronicle Sync - Calendar/Calendaria/SimpleCalendar Sync
 *
 * Bidirectional sync between Chronicle's calendar system and Foundry VTT
 * calendar modules. Supports both Calendaria and SimpleCalendar via an
 * adapter pattern. When neither is active, this module is a no-op.
 *
 * Sync flow:
 * - Chronicle → Foundry: Calendar changes arrive via WebSocket, update
 *   the active Foundry calendar module (date, events/notes).
 * - Foundry → Chronicle: Calendar changes detected via Hooks, push to
 *   Chronicle API (PUT /calendar/date, POST/PUT/DELETE /calendar/events).
 *
 * Calendaria notes are synced as Chronicle calendar events. The module uses
 * Calendaria's modern hook names (calendaria.dateTimeChange, calendaria.note*)
 * with fallbacks for older versions.
 *
 * Initial sync: On first connect, fetches Chronicle calendar structure and
 * optionally pushes to the active Foundry calendar module.
 */

import { getSetting, getCalendarSyncExclusions } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

/**
 * Canonical wire-visibility values per the calendar-sync wire contract
 * (cordinator/decisions/2026-05-17-calendar-sync-wire-contract.md).
 *
 * Chronicle's internal storage uses `'gm_only'` (underscore) for historical
 * reasons; chronicle#316's API handler translates between wire `'gm-only'`
 * (kebab) and storage at the boundary. The module emits + consumes wire
 * values. Don't introduce the storage form on the Foundry side.
 */
export const WIRE_VISIBILITY = Object.freeze({
  EVERYONE: 'everyone',
  GM_ONLY:  'gm-only',
});

/**
 * Pure helper: derive the wire-visibility value to emit when sending a
 * Calendaria note to Chronicle. Exported for unit testing — the hot path
 * call sites delegate to this so tests can pin the exact wire string.
 *
 * Accepts either:
 *   - A note stub with `gmOnly: boolean` (Calendaria's documented field)
 *   - A note stub with `visibility: 'visible'|'hidden'|'secret'` —
 *     anything other than 'visible' is treated as GM-only since Calendaria
 *     hides those notes from non-GM users by default.
 *
 * @param {object|null} noteData
 * @returns {'everyone'|'gm-only'}
 */
export function chronicleVisibilityFromCalendariaNote(noteData) {
  if (!noteData || typeof noteData !== 'object') return WIRE_VISIBILITY.EVERYONE;
  if (noteData.gmOnly === true) return WIRE_VISIBILITY.GM_ONLY;
  if (noteData.gmOnly === false) return WIRE_VISIBILITY.EVERYONE;
  const v = noteData.visibility ?? noteData.flagData?.visibility;
  if (v === 'hidden' || v === 'secret') return WIRE_VISIBILITY.GM_ONLY;
  return WIRE_VISIBILITY.EVERYONE;
}

/**
 * Pure helper: should an incoming Chronicle event be treated as GM-only?
 * Accepts both the canonical wire form `'gm-only'` (kebab) and the legacy
 * storage form `'gm_only'` (underscore) so a defensive Foundry consumer
 * survives any future Chronicle translation-layer regression.
 *
 * Exported for unit testing.
 *
 * @param {string|undefined|null} wireValue
 * @returns {boolean}
 */
export function isWireVisibilityGmOnly(wireValue) {
  return wireValue === WIRE_VISIBILITY.GM_ONLY || wireValue === 'gm_only';
}

/**
 * Calendaria's Foundry module id. It tags every note JournalEntry it creates
 * with flags under this scope. (Verified against Sayshal/Calendaria
 * `scripts/constants.mjs` → `MODULE.ID = 'calendaria'`.)
 */
export const CALENDARIA_FLAG_SCOPE = 'calendaria';

/**
 * SimpleCalendar persists each note as a JournalEntry under one of these module
 * flag scopes; the namespace's presence on the document is the note signal.
 * Frozen so a later edit can't silently drop one.
 */
export const SIMPLE_CALENDAR_FLAG_SCOPES = Object.freeze([
  'foundryvtt-simple-calendar',
  'simple-calendar',
]);

/**
 * Pure predicate: is this Foundry JournalEntry a calendar-module note?
 *
 * Both supported calendar modules store their notes as JournalEntry documents:
 *   - **Calendaria** creates one JournalEntry per note in a "Calendar Notes"
 *     folder, flagged `flags.calendaria.isCalendarNote === true`. This includes
 *     *festival/holiday notes it auto-seeds* from a calendar's `festivals`
 *     template (e.g. "Day of Rebirth", "Eve of the Dead") — the exact documents
 *     that triggered this bug. Calendar-structure journals are tagged
 *     `isCalendarJournal`. (Verified against Sayshal/Calendaria
 *     `scripts/notes/note-manager.mjs` + `scripts/festivals/festival-manager.mjs`.)
 *   - **SimpleCalendar** stores each note as a JournalEntry under its own module
 *     flag scope (see SIMPLE_CALENDAR_FLAG_SCOPES).
 *
 * Those documents belong to CalendarSync — which mirrors them to Chronicle as
 * *calendar events* — and must NEVER be pushed to Chronicle as worldbuilding
 * entities. JournalSync calls this to skip them: without the guard a calendar
 * note is POSTed to `/entities` with `entity_type_id: 0`, which the server
 * resolves to the campaign's first entity type (typically "Character"), so the
 * holidays wrongly appear in the Characters list.
 *
 * Detection is by the calendar module's own flag (present the moment the note
 * JournalEntry is created — so it fires on the very first `createJournalEntry`
 * hook) plus our own `calendarEventId` link flag, which a note carries once
 * CalendarSync has mirrored it to a Chronicle event.
 *
 * Defensive against plain object stubs (tests, partial payloads): reads the
 * nested `flags` object directly when `getFlag` is unavailable.
 *
 * @param {object|null} journal - A Foundry JournalEntry (or test stub).
 * @returns {boolean}
 */
export function isCalendarNoteJournal(journal) {
  if (!journal || typeof journal !== 'object') return false;

  const flags = journal.flags || {};

  // Calendaria: note / structure journals carry these explicit boolean flags.
  // Match the specific flags (not merely the presence of a `calendaria` scope)
  // so an unrelated journal that happens to hold a Calendaria enricher flag is
  // not wrongly skipped from entity sync.
  const cal = flags[CALENDARIA_FLAG_SCOPE];
  if (cal && typeof cal === 'object' && (cal.isCalendarNote === true || cal.isCalendarJournal === true)) {
    return true;
  }

  // SimpleCalendar: presence of its note flag scope is the signal.
  for (const scope of SIMPLE_CALENDAR_FLAG_SCOPES) {
    if (flags[scope] && typeof flags[scope] === 'object') return true;
  }

  // A note already mirrored to a Chronicle calendar event carries this flag
  // under our own scope.
  if (typeof journal.getFlag === 'function') {
    if (journal.getFlag(FLAG_SCOPE, 'calendarEventId')) return true;
  } else if (flags[FLAG_SCOPE]?.calendarEventId) {
    return true;
  }

  return false;
}

// --- Worldstate bridge pure helpers (cordinator#34 W5) ---
// Exported for unit tests; the CalendarSync methods delegate here so the
// echo guards + projection diff are pinned without Foundry globals.

/**
 * How long a just-pushed/just-applied value suppresses the identical value
 * arriving back through the other channel. Covers the WS round trip plus
 * Calendaria's async hook dispatch; long enough for slow links, short
 * enough that a real GM re-set of the same value minutes later syncs.
 */
export const WORLDSTATE_ECHO_WINDOW_MS = 10000;

/**
 * Value+time-window echo guard: true when `value` equals the last-seen
 * value AND we saw it within the window. The second suppression mechanism
 * the W5 spec requires on top of the _syncing flag (which can't cover
 * hooks that fire after an await chain clears it).
 */
export function isEchoWithinWindow(lastValue, lastAt, value, now, windowMs = WORLDSTATE_ECHO_WINDOW_MS) {
  if (lastValue === null || lastValue === undefined) return false;
  if (value === null || value === undefined) return false;
  if (lastValue !== value) return false;
  return (now - lastAt) < windowMs;
}

/**
 * Stable date key for the date-apply dedup between the legacy
 * `calendar.date.advanced` channel and the `calendar.worldstate.changed`
 * channel (both can announce the same move during the deprecation window).
 * Date-only on purpose: hour/minute differ between the two payloads.
 */
export function worldstateDateKey(d) {
  if (!d || d.year === undefined || d.month === undefined || d.day === undefined) return null;
  return `${d.year}-${d.month}-${d.day}`;
}

/**
 * Time-of-day key companion to worldstateDateKey; null when the payload
 * carries no time (the legacy AdvanceDate broadcast is date-only).
 */
export function worldstateTimeKey(d) {
  if (!d || d.hour === undefined || d.hour === null) return null;
  return `${d.hour}:${d.minute ?? 0}`;
}

/**
 * Build the {date, time} record the date echo guards store for a payload.
 * Returns null for payloads without a full date.
 */
export function dateRecordFor(d) {
  const date = worldstateDateKey(d);
  if (!date) return null;
  return { date, time: worldstateTimeKey(d) };
}

/**
 * Date variant of the echo guard. Matching is time-AWARE: the date parts
 * must match exactly, and the time parts must match unless either side
 * lacks a time (date-only payloads dedupe by date alone). This keeps a
 * same-day TIME change (08:00 → 20:00) from being swallowed as an "echo"
 * of an earlier same-day apply — the review's date-key finding — while
 * date-only channels still dedupe.
 */
export function isDateEchoWithinWindow(rec, recAt, d, now, windowMs = WORLDSTATE_ECHO_WINDOW_MS) {
  if (!rec) return false;
  if ((now - recAt) >= windowMs) return false;
  const dk = worldstateDateKey(d);
  if (!dk || rec.date !== dk) return false;
  const tk = worldstateTimeKey(d);
  return rec.time === null || tk === null || rec.time === tk;
}

/**
 * Machine marker embedded in the content of every Calendaria note this
 * module projects from a Chronicle celestial event. It is the load-bearing
 * identity signal: the projection diffs by it (one note per type per day)
 * and the note-sync handlers SKIP any note carrying it so a projection can
 * never bounce back into Chronicle as a calendar event.
 */
export const CHRONICLE_CELESTIAL_MARKER_RE = /<!--chronicle-celestial:([a-z0-9_-]+)-->/;

/** Build the marker comment for a celestial event type. */
export function celestialMarkerFor(type) {
  return `<!--chronicle-celestial:${type}-->`;
}

/**
 * Extract the Chronicle celestial type from a projected note (or note
 * stub), reading content wherever the hook/API surface puts it. Returns
 * null for anything that isn't ours.
 */
export function celestialTypeFromNote(note) {
  if (!note || typeof note !== 'object') return null;
  const content = note.content ?? note.flagData?.content ?? note.description ?? '';
  const m = CHRONICLE_CELESTIAL_MARKER_RE.exec(String(content));
  return m ? m[1] : null;
}

/** Is this note one of our projected Chronicle celestial notes? */
export function isChronicleCelestialNote(note) {
  return celestialTypeFromNote(note) !== null;
}

/**
 * Map a seed event's visibility onto Calendaria's NOTE_VISIBILITY enum:
 * Chronicle `dm_only` → `secret` (GM-only in Calendaria), everything else
 * → `visible`. The Bearer-token seed includes dm_only events (GM-level
 * sync visibility), so the projection must carry the restriction through.
 */
export function celestialNoteVisibility(seedEvent) {
  return seedEvent?.visibility === 'dm_only' ? 'secret' : 'visible';
}

/**
 * Diff the day's existing projected notes against the seed's celestial
 * events: ONE note per event type per day — update in place, create the
 * missing, delete the cleared. Pure; both inputs may be null/empty.
 *
 * @param {Array} existingNotes - the day's notes ALREADY filtered to ours
 *   (isChronicleCelestialNote).
 * @param {Array} seedEvents - WorldStateSeed.events for the day.
 * @returns {{creates: Array, updates: Array<{note, event}>, deletes: Array}}
 */
export function planCelestialProjection(existingNotes, seedEvents) {
  // First marker note per type is the canonical one; SURPLUS notes of the
  // same type (concurrent-refresh or user-duplication artifacts) go to
  // deletes so the one-note-per-type-per-day invariant self-heals instead
  // of duplicates lingering forever (review finding).
  const existingByType = new Map();
  const surplus = [];
  for (const n of existingNotes || []) {
    const t = celestialTypeFromNote(n);
    if (!t) continue;
    if (existingByType.has(t)) surplus.push(n);
    else existingByType.set(t, n);
  }
  const wantByType = new Map();
  for (const e of seedEvents || []) {
    if (e && e.type && !wantByType.has(e.type)) wantByType.set(e.type, e);
  }
  const creates = [];
  const updates = [];
  const deletes = [...surplus];
  for (const [t, ev] of wantByType) {
    const existing = existingByType.get(t);
    if (existing) updates.push({ note: existing, event: ev });
    else creates.push(ev);
  }
  for (const [t, n] of existingByType) {
    if (!wantByType.has(t)) deletes.push(n);
  }
  return { creates, updates, deletes };
}

/**
 * CalendarSync handles calendar ↔ Foundry calendar module synchronization.
 */
export class CalendarSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    this._syncing = false;

    /** @type {'calendaria'|'simple-calendar'|null} */
    this._calendarModule = null;

    /** @type {object|null} Cached Chronicle calendar structure. */
    this._chronicleCalendar = null;

    /** @type {boolean} Whether modern Calendaria API (CALENDARIA.api) is available. */
    this._hasModernCalendariaApi = false;

    // Bound hook handlers for cleanup.
    this._boundHandlers = {};

    /**
     * Worldstate-bridge echo guards (cordinator#34 W5): value+time-window
     * records of the last date/weather we APPLIED locally vs PUSHED to
     * Chronicle, so a change never loops (Chronicle → Calendaria →
     * weatherChange hook → Chronicle …) even when async hook timing slips
     * past the _syncing flag.
     *
     * INVARIANT (revert correctness): every successful apply CLEARS the
     * pushed record and vice versa. State only ever moves via one side at
     * a time, so the "other side's" stale record must not suppress a
     * legitimate flip-back to an earlier value within the window (the
     * review's revert-suppression finding). Date records are {date, time}
     * objects (dateRecordFor); weather records are preset-id strings.
     * lastCustomApplyAt one-shots the setCustomWeather fallback, whose
     * resulting weatherChange hook reports Calendaria's own custom id —
     * a vocabulary the value guard can't match.
     */
    this._wsGuard = {
      lastAppliedDate: null, lastAppliedDateAt: 0,
      lastPushedDate: null, lastPushedDateAt: 0,
      lastAppliedWeather: null, lastAppliedWeatherAt: 0,
      lastPushedWeather: null, lastPushedWeatherAt: 0,
      lastCustomApplyAt: 0,
    };

    /**
     * Reserved celestial note-category id: undefined = never probed,
     * null = probed and unavailable (degrade to uncategorized notes).
     * @type {string|null|undefined}
     */
    this._celestialCategoryId = undefined;
  }

  /**
   * Initialize calendar sync. Detects which Foundry calendar module is
   * active and registers appropriate hooks.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncCalendar')) return;

    // Detect active calendar module.
    if (game.modules.get('calendaria')?.active) {
      this._calendarModule = 'calendaria';
      // Check for modern Calendaria API (v2+).
      this._hasModernCalendariaApi = typeof globalThis.CALENDARIA?.api?.setDateTime === 'function';
    } else if (game.modules.get('foundryvtt-simple-calendar')?.active) {
      this._calendarModule = 'simple-calendar';
    }

    if (!this._calendarModule) {
      console.debug('Chronicle: No calendar module detected (Calendaria or SimpleCalendar). Calendar sync disabled.');
      return;
    }

    this._registerHooks();
    console.debug(`Chronicle: Calendar sync initialized (${this._calendarModule} detected, modern API: ${this._hasModernCalendariaApi})`);
  }

  /**
   * Handle incoming WebSocket messages for calendar events.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncCalendar') || !this._calendarModule) return;

    switch (msg.type) {
      case 'calendar.date.advanced':
        await this._onChronicleDateAdvanced(msg.payload);
        break;
      case 'calendar.worldstate.changed':
        // The GM console's date/time/weather/celestial writes announce
        // through this message ONLY (the known dual-event gap — see
        // cordinator#34 Q5 ruling). Payload is minimal {date, moodTint};
        // the handler re-GETs authoritative state with dedup vs the
        // legacy date.advanced channel, which stays handled above during
        // its deprecation window.
        await this._onChronicleWorldstateChanged(msg.payload);
        break;
      case 'calendar.weather.changed':
        await this._onChronicleWeatherChanged(msg.payload);
        break;
      case 'calendar.event.created':
        await this._onChronicleEventCreated(msg.payload);
        break;
      case 'calendar.event.updated':
        await this._onChronicleEventUpdated(msg.payload);
        break;
      case 'calendar.event.deleted':
        await this._onChronicleEventDeleted(msg.payload);
        break;
    }
  }

  /**
   * Handle a sync mapping received during initial sync.
   * Stores calendar event mappings for later lookup.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping.chronicle_type !== 'calendar_event') return;
    if (!getSetting('syncCalendar') || !this._calendarModule) return;

    // Store the mapping so we can correlate local ↔ Chronicle events.
    if (mapping.external_id && mapping.chronicle_id) {
      await this._storeEventMapping(mapping.external_id, mapping.chronicle_id);
    }
  }

  /**
   * Perform initial calendar sync on WebSocket connect.
   * Fetches Chronicle calendar structure and syncs current date.
   */
  async onInitialSync() {
    if (!getSetting('syncCalendar') || !this._calendarModule) return;

    try {
      this._chronicleCalendar = await this._api.get('/calendar');
      if (!this._chronicleCalendar) {
        console.debug('Chronicle: No calendar configured for this campaign');
        return;
      }

      // Sync the current date from Chronicle to the Foundry calendar module.
      await this._setLocalDate({
        year: this._chronicleCalendar.current_year,
        month: this._chronicleCalendar.current_month,
        day: this._chronicleCalendar.current_day,
        hour: this._chronicleCalendar.current_hour,
        minute: this._chronicleCalendar.current_minute,
      });

      // Sync Chronicle calendar events to Calendaria notes (if using Calendaria).
      if (this._calendarModule === 'calendaria') {
        await this._syncChronicleEventsToCalendariaNotes();
      }

      // Worldstate bridge (cordinator#34 W5): the /calendar response embeds
      // current_weather (previously discarded here) — apply it, then bring
      // the celestial-note projection up to date for the current day.
      if (getSetting('syncWorldstate')) {
        if (this._chronicleCalendar.current_weather) {
          await this._applyChronicleWeather(this._chronicleCalendar.current_weather);
        }
        await this._refreshCelestialProjection();
      }

      console.debug('Chronicle: Calendar initial sync complete');
    } catch (err) {
      console.error('Chronicle: Calendar initial sync failed', err);
    }
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    this._unregisterHooks();
  }

  /**
   * Remove all registered hooks. Safe to call even if no hooks are registered.
   * @private
   */
  _unregisterHooks() {
    if (this._calendarModule === 'calendaria') {
      // Modern Calendaria hooks.
      if (this._boundHandlers.dateTimeChange) Hooks.off('calendaria.dateTimeChange', this._boundHandlers.dateTimeChange);
      if (this._boundHandlers.noteCreated) Hooks.off('calendaria.noteCreated', this._boundHandlers.noteCreated);
      if (this._boundHandlers.noteUpdated) Hooks.off('calendaria.noteUpdated', this._boundHandlers.noteUpdated);
      if (this._boundHandlers.noteDeleted) Hooks.off('calendaria.noteDeleted', this._boundHandlers.noteDeleted);
      // Worldstate bridge hooks (cordinator#34 W5).
      if (this._boundHandlers.weatherChange) Hooks.off('calendaria.weatherChange', this._boundHandlers.weatherChange);
      if (this._boundHandlers.dayChange) Hooks.off('calendaria.dayChange', this._boundHandlers.dayChange);
      // Legacy Calendaria hooks (for older versions).
      if (this._boundHandlers.dateChange) Hooks.off('calendariaDateChange', this._boundHandlers.dateChange);
      if (this._boundHandlers.eventCreate) Hooks.off('calendariaEventCreate', this._boundHandlers.eventCreate);
      if (this._boundHandlers.eventUpdate) Hooks.off('calendariaEventUpdate', this._boundHandlers.eventUpdate);
      if (this._boundHandlers.eventDelete) Hooks.off('calendariaEventDelete', this._boundHandlers.eventDelete);
    } else if (this._calendarModule === 'simple-calendar') {
      if (this._boundHandlers.dateChange) Hooks.off('simple-calendar-date-time-change', this._boundHandlers.dateChange);
      if (this._boundHandlers.noteCreate) Hooks.off('createJournalEntry', this._boundHandlers.noteCreate);
      if (this._boundHandlers.noteUpdate) Hooks.off('updateJournalEntry', this._boundHandlers.noteUpdate);
      if (this._boundHandlers.noteDelete) Hooks.off('deleteJournalEntry', this._boundHandlers.noteDelete);
    }
    this._boundHandlers = {};
  }

  // --- Hook Registration (adapter pattern) ---

  /**
   * Register hooks for the detected calendar module.
   * @private
   */
  _registerHooks() {
    // Guard against duplicate listeners if init() is called multiple times
    // (e.g., during reconnection). Remove any existing hooks first.
    this._unregisterHooks();

    if (this._calendarModule === 'calendaria') {
      // Modern Calendaria hooks (v2+): dateTimeChange includes hour/minute,
      // noteCreated/Updated/Deleted handle calendar notes.
      this._boundHandlers.dateTimeChange = this._onCalendariaDateTimeChange.bind(this);
      this._boundHandlers.noteCreated = this._onCalendariaNoteCreated.bind(this);
      this._boundHandlers.noteUpdated = this._onCalendariaNoteUpdated.bind(this);
      this._boundHandlers.noteDeleted = this._onCalendariaNoteDeleted.bind(this);

      Hooks.on('calendaria.dateTimeChange', this._boundHandlers.dateTimeChange);
      Hooks.on('calendaria.noteCreated', this._boundHandlers.noteCreated);
      Hooks.on('calendaria.noteUpdated', this._boundHandlers.noteUpdated);
      Hooks.on('calendaria.noteDeleted', this._boundHandlers.noteDeleted);

      // Worldstate bridge (cordinator#34 W5): Calendaria→Chronicle weather
      // push + the lazy day-boundary weather/celestial alignment.
      this._boundHandlers.weatherChange = this._onCalendariaWeatherChange.bind(this);
      this._boundHandlers.dayChange = this._onCalendariaDayChange.bind(this);
      Hooks.on('calendaria.weatherChange', this._boundHandlers.weatherChange);
      Hooks.on('calendaria.dayChange', this._boundHandlers.dayChange);

      // Legacy Calendaria hooks (fallback for older versions).
      this._boundHandlers.dateChange = this._onLocalDateChange.bind(this);
      this._boundHandlers.eventCreate = this._onLocalEventCreate.bind(this);
      this._boundHandlers.eventUpdate = this._onLocalEventUpdate.bind(this);
      this._boundHandlers.eventDelete = this._onLocalEventDelete.bind(this);

      Hooks.on('calendariaDateChange', this._boundHandlers.dateChange);
      Hooks.on('calendariaEventCreate', this._boundHandlers.eventCreate);
      Hooks.on('calendariaEventUpdate', this._boundHandlers.eventUpdate);
      Hooks.on('calendariaEventDelete', this._boundHandlers.eventDelete);
    } else if (this._calendarModule === 'simple-calendar') {
      this._boundHandlers.dateChange = this._onSimpleCalendarDateChange.bind(this);
      Hooks.on('simple-calendar-date-time-change', this._boundHandlers.dateChange);

      // SimpleCalendar notes are JournalEntries with SC flags. Detect CRUD
      // via standard Foundry journal hooks and check for SC flag presence.
      this._boundHandlers.noteCreate = this._onSimpleCalendarNoteCreate.bind(this);
      this._boundHandlers.noteUpdate = this._onSimpleCalendarNoteUpdate.bind(this);
      this._boundHandlers.noteDelete = this._onSimpleCalendarNoteDelete.bind(this);
      Hooks.on('createJournalEntry', this._boundHandlers.noteCreate);
      Hooks.on('updateJournalEntry', this._boundHandlers.noteUpdate);
      Hooks.on('deleteJournalEntry', this._boundHandlers.noteDelete);
    }
  }

  // --- Chronicle → Foundry ---

  /**
   * Update the local Foundry calendar date from Chronicle
   * (`calendar.date.advanced` — the legacy channel, kept during the
   * worldstate.changed deprecation window).
   *
   * Guarded two ways (W5 item 6): skip when the date matches what we just
   * PUSHED (our own PUT echoing back — the pre-existing latent date loop:
   * _setLocalDate clears _syncing in its finally, and Calendaria can fire
   * dateTimeChange after that) and when it matches what another channel
   * just APPLIED (worldstate.changed announcing the same move).
   * @param {object} data - { year, month, day, hour, minute }
   * @private
   */
  async _onChronicleDateAdvanced(data) {
    if (!data) return;
    const rec = dateRecordFor(data);
    const now = Date.now();
    if (isDateEchoWithinWindow(this._wsGuard.lastPushedDate, this._wsGuard.lastPushedDateAt, data, now)) return;
    if (isDateEchoWithinWindow(this._wsGuard.lastAppliedDate, this._wsGuard.lastAppliedDateAt, data, now)) return;
    if (rec) {
      this._wsGuard.lastAppliedDate = rec;
      this._wsGuard.lastAppliedDateAt = now;
      this._wsGuard.lastPushedDate = null; // state moved via apply → old push record is stale
    }
    await this._setLocalDate(data);
  }

  /**
   * `calendar.worldstate.changed` — the GM console's write signal (date
   * advances, weather sets, celestial triggers/clears, mood). The payload
   * is deliberately minimal ({date, moodTint}, no hour/minute and no
   * GM-only data), so re-GET the authoritative state and apply:
   *   1. date+time from GET /calendar/date (dedup'd against the legacy
   *      date.advanced channel and our own pushes),
   *   2. weather from the same response (rides current_weather),
   *   3. the celestial-note projection from the world-state seed.
   * Date apply is gated by syncCalendar only (it IS date sync — the GM
   * panel's advances announce nowhere else); weather + celestials
   * additionally gate on the syncWorldstate toggle.
   * @param {object} _payload - { date: {year,month,day}, moodTint }
   * @private
   */
  async _onChronicleWorldstateChanged(_payload) {
    try {
      const cur = await this._api.get('/calendar/date');
      if (cur && cur.year !== undefined) {
        const rec = dateRecordFor(cur);
        const now = Date.now();
        const pushedEcho = isDateEchoWithinWindow(this._wsGuard.lastPushedDate, this._wsGuard.lastPushedDateAt, cur, now);
        const appliedDup = isDateEchoWithinWindow(this._wsGuard.lastAppliedDate, this._wsGuard.lastAppliedDateAt, cur, now);
        if (rec && !pushedEcho && !appliedDup) {
          this._wsGuard.lastAppliedDate = rec;
          this._wsGuard.lastAppliedDateAt = now;
          this._wsGuard.lastPushedDate = null; // state moved via apply
          await this._setLocalDate(cur);
        }
        if (getSetting('syncWorldstate') && cur.current_weather) {
          await this._applyChronicleWeather(cur.current_weather);
        }
      }
    } catch (err) {
      console.warn('Chronicle: worldstate.changed date/weather refresh failed', err);
    }
    if (getSetting('syncWorldstate')) {
      await this._refreshCelestialProjection();
    }
  }

  /**
   * `calendar.weather.changed` — a weather write landed (GM console, the
   * settings tab, or our own PUT echoing back; the echo guard inside
   * _applyChronicleWeather sorts that out). Re-GET rather than trusting
   * the payload so the applied state is always the merged server truth.
   * @private
   */
  async _onChronicleWeatherChanged(_payload) {
    if (!getSetting('syncWorldstate')) return;
    await this._refreshWeatherFromChronicle();
  }

  /**
   * Create a local calendar event from Chronicle data.
   * @param {object} data - Chronicle event object.
   * @private
   */
  async _onChronicleEventCreated(data) {
    if (!data) return;
    this._syncing = true;
    try {
      await this._createLocalEvent(data);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Update a local calendar event from Chronicle data.
   * @param {object} data - Chronicle event object.
   * @private
   */
  async _onChronicleEventUpdated(data) {
    if (!data) return;
    this._syncing = true;
    try {
      await this._updateLocalEvent(data);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Delete a local calendar event from Chronicle data.
   * @param {object} data - { id: eventId }
   * @private
   */
  async _onChronicleEventDeleted(data) {
    if (!data) return;
    this._syncing = true;
    try {
      await this._deleteLocalEvent(data);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Whether the operator has opted the currently-active Calendaria calendar out
   * of Chronicle sync (toggled from the Sync Calendar editor). Push handlers
   * check this so a local-only calendar stops pushing date/note changes without
   * disabling calendar sync globally. Defensive: any lookup failure → not
   * excluded (fail open to existing behaviour). @returns {boolean} @private
   */
  _isActiveCalendarExcluded() {
    try {
      const exclusions = getCalendarSyncExclusions();
      if (!exclusions.length) return false;
      const cal = globalThis.CALENDARIA?.api?.getActiveCalendar?.();
      const id = cal?.metadata?.id || cal?.id || '';
      return !!id && exclusions.includes(id);
    } catch {
      return false;
    }
  }

  // --- Worldstate bridge: weather (cordinator#34 W5 items 1-3) ---

  /**
   * Re-GET Chronicle's current weather and apply it to Calendaria. The GET
   * hits the per-day canonical store (the unification seam), so whatever
   * the GM console or another client set is what lands here.
   * @private
   */
  async _refreshWeatherFromChronicle() {
    if (!getSetting('syncWorldstate')) return;
    try {
      const weather = await this._api.get('/calendar/weather');
      if (weather && weather.preset_id) {
        await this._applyChronicleWeather(weather);
      }
    } catch (err) {
      console.warn('Chronicle: weather refresh failed', err);
    }
  }

  /**
   * Apply a Chronicle Weather object to Calendaria: setWeather by preset id
   * (1:1 post vocabulary-parity), falling back to setCustomWeather carrying
   * the label/icon/color/description for a preset Calendaria doesn't know
   * (Chronicle-native extras, or an older Calendaria). Echo-guarded both
   * ways; no-ops on SimpleCalendar (no weather API).
   * @param {object} weather - Chronicle Weather JSON ({ preset_id, ... }).
   * @private
   */
  async _applyChronicleWeather(weather) {
    if (this._calendarModule !== 'calendaria' || !this._hasModernCalendariaApi) return;
    if (!getSetting('syncWorldstate')) return;
    // Exclusion covers worldstate BOTH directions: an excluded "local-only"
    // calendar neither pushes nor receives Chronicle weather.
    if (this._isActiveCalendarExcluded()) return;
    const presetId = weather?.preset_id;
    if (!presetId) return;

    const now = Date.now();
    // Our own PUT echoing back through the WS → already live locally.
    if (isEchoWithinWindow(this._wsGuard.lastPushedWeather, this._wsGuard.lastPushedWeatherAt, presetId, now)) return;
    // Same value applied moments ago through another channel.
    if (isEchoWithinWindow(this._wsGuard.lastAppliedWeather, this._wsGuard.lastAppliedWeatherAt, presetId, now)) return;

    const api = globalThis.CALENDARIA?.api;
    if (typeof api?.setWeather !== 'function') return;

    this._syncing = true;
    try {
      let ok = false;
      try {
        const r = await api.setWeather(presetId, { allPeriods: true });
        ok = r !== false;
      } catch {
        ok = false;
      }
      if (!ok && typeof api.setCustomWeather === 'function') {
        await api.setCustomWeather({
          label: weather.preset_label || presetId,
          icon: weather.icon || undefined,
          color: weather.color || undefined,
          description: weather.description || undefined,
        });
        // The weatherChange hook this fires reports Calendaria's own
        // custom-weather id, which the value guard can't match against
        // the Chronicle preset id — one-shot a time window instead so
        // the fallback can't bounce 'custom' back into Chronicle.
        this._wsGuard.lastCustomApplyAt = now;
      }
      this._wsGuard.lastAppliedWeather = presetId;
      this._wsGuard.lastAppliedWeatherAt = now;
      this._wsGuard.lastPushedWeather = null; // state moved via apply
    } catch (err) {
      console.warn('Chronicle: failed to apply weather to Calendaria', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Calendaria→Chronicle weather (`calendaria.weatherChange`): PUT the
   * preset onto Chronicle's /calendar/weather — which post-seam writes the
   * CURRENT day's canonical row, so the Chronicle sky band renders it.
   * @param {object} data - hook payload; preset id read defensively.
   * @private
   */
  async _onCalendariaWeatherChange(data) {
    if (this._syncing || !game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;
    if (!getSetting('syncWorldstate')) return;

    const presetId = data?.presetId || data?.id || data?.weather?.presetId || data?.weather?.id || null;
    if (!presetId) return;

    const now = Date.now();
    // One-shot after a setCustomWeather fallback: the hook reports
    // Calendaria's own custom id (not the Chronicle preset), so the value
    // guards below can't match it — suppress by time instead. Costs at
    // most one real GM change inside the window right after a custom
    // apply; without it the fallback clobbers Chronicle's canonical
    // weather with 'custom'.
    if ((now - this._wsGuard.lastCustomApplyAt) < WORLDSTATE_ECHO_WINDOW_MS) return;
    // A weatherChange fired by our own setWeather apply → not a GM change.
    if (isEchoWithinWindow(this._wsGuard.lastAppliedWeather, this._wsGuard.lastAppliedWeatherAt, presetId, now)) return;
    if (isEchoWithinWindow(this._wsGuard.lastPushedWeather, this._wsGuard.lastPushedWeatherAt, presetId, now)) return;

    const label = data?.label || data?.weather?.label;
    try {
      await this._api.put('/calendar/weather', {
        preset_id: presetId,
        ...(label ? { preset_label: label } : {}),
      });
      this._wsGuard.lastPushedWeather = presetId;
      this._wsGuard.lastPushedWeatherAt = now;
      this._wsGuard.lastAppliedWeather = null; // state moved via push
    } catch (err) {
      console.error('Chronicle: failed to push Calendaria weather to Chronicle', err);
    }
  }

  /**
   * Calendaria day boundary (`calendaria.dayChange`): the date push rides
   * the dateTimeChange hook as before; here we lazily align the NEW day's
   * weather (Chronicle's stored per-day weather wins — Calendaria has no
   * dated setter, so day boundaries are where authored future weather
   * lands) and refresh the celestial-note projection. Also self-heals
   * offline drift per the locked design.
   *
   * Every read is PINNED to Calendaria's new local date: the sibling
   * dateTimeChange handler's PUT /calendar/date races these GETs, so an
   * un-pinned "current day" read can return the OLD day's state (review
   * finding) — yesterday's weather applied to the new day and the new
   * day's celestials never projected.
   * @param {object} data - hook payload (date fields when provided).
   * @private
   */
  async _onCalendariaDayChange(data) {
    if (this._syncing || !game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;
    if (!getSetting('syncWorldstate')) return;

    const d = (data && data.year !== undefined) ? data
      : globalThis.CALENDARIA?.api?.getCurrentDateTime?.();
    if (!d || d.year === undefined) return;
    const pinned = { year: d.year, month: d.month, day: d.day ?? d.dayOfMonth };

    try {
      const seed = await this._api.get(
        `/calendar/world-state?year=${pinned.year}&month=${pinned.month}&day=${pinned.day}`);
      if (!seed || !seed.date) return;
      // The pinned seed's weather IS the day's canonical store projection.
      // 'clear' is ambiguous (authored-clear vs the no-row default), so the
      // day-boundary sync applies only real conditions — an actively-set
      // 'clear' still arrives via weather.changed/worldstate.changed.
      const t = seed.weather?.type;
      if (t && t !== 'clear') {
        await this._applyChronicleWeather({ preset_id: t });
      }
      await this._projectCelestialsFromSeed(seed);
    } catch (err) {
      console.warn('Chronicle: day-change worldstate refresh failed', err);
    }
  }

  // --- Foundry → Chronicle (Calendaria Modern Hooks) ---

  /**
   * Push date/time change from modern Calendaria (dateTimeChange hook) to Chronicle.
   * This hook fires on every world time change and includes full date+time.
   * @param {object} data - { year, month, dayOfMonth, hour, minute, second, ... }
   * @private
   */
  async _onCalendariaDateTimeChange(data) {
    if (this._syncing) return;
    if (!game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;

    const body = {
      year: data.year,
      month: data.month,
      day: data.dayOfMonth ?? data.day,
      hour: data.hour ?? 0,
      minute: data.minute ?? 0,
    };
    const rec = dateRecordFor(body);
    const now = Date.now();
    // A dateTimeChange fired late by our OWN _setLocalDate (after its
    // finally cleared _syncing) must not PUT the same date back — that was
    // the latent date-echo loop (W5 item 6). Time-aware: a genuine
    // same-day TIME move within the window still pushes.
    if (isDateEchoWithinWindow(this._wsGuard.lastAppliedDate, this._wsGuard.lastAppliedDateAt, body, now)) return;

    try {
      await this._api.put('/calendar/date', body);
      if (rec) {
        this._wsGuard.lastPushedDate = rec;
        this._wsGuard.lastPushedDateAt = now;
        this._wsGuard.lastAppliedDate = null; // state moved via push
      }
    } catch (err) {
      console.error('Chronicle: Failed to push Calendaria date/time to Chronicle', err);
    }
  }

  /**
   * Push new Calendaria note to Chronicle as a calendar event.
   * @param {object} noteData - Calendaria note data from the hook.
   * @private
   */
  async _onCalendariaNoteCreated(noteData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;
    // Our own projected celestial notes must NEVER bounce back into
    // Chronicle as calendar events (W5 echo prevention).
    if (isChronicleCelestialNote(noteData)) return;

    const eventPayload = this._calendariaNoteToChronicleEvent(noteData);
    if (!eventPayload) return;

    try {
      const result = await this._api.post('/calendar/events', eventPayload);
      if (result?.id && noteData.id) {
        await this._storeEventMapping(noteData.id, result.id);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push Calendaria note to Chronicle', err);
    }
  }

  /**
   * Push Calendaria note update to Chronicle.
   * @param {object} noteData - Calendaria note data from the hook.
   * @private
   */
  async _onCalendariaNoteUpdated(noteData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;
    // Projected celestial notes are Chronicle-owned; edits don't sync back.
    if (isChronicleCelestialNote(noteData)) return;

    const chronicleId = this._getChronicleEventId(noteData.id);
    if (!chronicleId) {
      // Note exists in Calendaria but not in Chronicle — create it.
      await this._onCalendariaNoteCreated(noteData);
      return;
    }

    const eventPayload = this._calendariaNoteToChronicleEvent(noteData);
    if (!eventPayload) return;

    try {
      await this._api.put(`/calendar/events/${chronicleId}`, eventPayload);
    } catch (err) {
      console.error('Chronicle: Failed to update Calendaria note in Chronicle', err);
    }
  }

  /**
   * Push Calendaria note deletion to Chronicle.
   * @param {object} noteData - Calendaria note data (at minimum { id }).
   * @private
   */
  async _onCalendariaNoteDeleted(noteData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;
    if (this._isActiveCalendarExcluded()) return;
    // A GM deleting a projected celestial note is a local tidy-up, not a
    // Chronicle event deletion (the projection recreates on next refresh
    // while the Chronicle event stands — clear it in Chronicle to remove).
    if (isChronicleCelestialNote(noteData)) return;

    const noteId = noteData?.id || noteData?.pageId;
    if (!noteId) return;

    const chronicleId = this._getChronicleEventId(noteId);
    if (!chronicleId) return;

    try {
      await this._api.delete(`/calendar/events/${chronicleId}`);
      await this._removeEventMapping(noteId);
    } catch (err) {
      console.warn('Chronicle: Failed to delete Calendaria note from Chronicle', err);
    }
  }

  /**
   * Convert a Calendaria note object to a Chronicle calendar event payload.
   * @param {object} noteData - Calendaria note data.
   * @returns {object|null} Chronicle event body, or null if invalid.
   * @private
   */
  _calendariaNoteToChronicleEvent(noteData) {
    if (!noteData) return null;

    // Calendaria notes store date in flagData or startDate.
    const flagData = noteData.flagData || noteData;
    const startDate = flagData.startDate || flagData;

    // Validate we have date info.
    if (startDate.year === undefined && startDate.month === undefined) {
      // Try getting the date from the note's page document via API.
      if (this._hasModernCalendariaApi && noteData.id) {
        try {
          const note = CALENDARIA.api.getNote(noteData.id);
          if (note?.flagData?.startDate) {
            return this._calendariaNoteToChronicleEvent({
              ...noteData,
              flagData: note.flagData,
              name: note.name || noteData.name,
            });
          }
        } catch { /* fall through */ }
      }
      return null;
    }

    // Calendaria uses 1-indexed months (same as Chronicle).
    // Optional parity fields (color/icon/all_day/start_hour+minute) ride
    // along when the note carries them — Chronicle's POST/PUT accepts them
    // per API-CONTRACT.md, and dropping them lost styled/timed-note
    // fidelity crossing to Chronicle. Recurrence (conditionTree) mapping
    // remains a known future item (see .ai.md).
    const color = noteData.color ?? flagData.color;
    const icon = noteData.icon ?? flagData.icon;
    const allDay = noteData.allDay ?? flagData.allDay;
    return {
      name: noteData.name || noteData.title || 'Untitled Note',
      year: startDate.year,
      month: startDate.month,
      day: startDate.day ?? startDate.dayOfMonth ?? 1,
      description: noteData.content || noteData.description || flagData.content || '',
      // Wire visibility is kebab-case per the wire contract
      // (cordinator/decisions/2026-05-17-calendar-sync-wire-contract.md).
      // Chronicle's internal storage uses underscore; chronicle#316's
      // translation layer bridges the two. Foundry MUST emit kebab on
      // the wire — emitting underscore was masked by the translation
      // layer in PR 1 but counts as drift. See `chronicleVisibilityFromCalendariaNote`
      // for the pure helper this delegates to (used by unit tests).
      visibility: chronicleVisibilityFromCalendariaNote(noteData),
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      ...(allDay !== undefined ? { all_day: !!allDay } : {}),
      ...(allDay === false && startDate.hour !== undefined
        ? { start_hour: startDate.hour, start_minute: startDate.minute ?? 0 }
        : {}),
    };
  }

  // --- Foundry → Chronicle (Legacy Calendaria Hooks) ---

  /**
   * Push date change from legacy Calendaria to Chronicle.
   * @param {object} dateData - { year, month, day }
   * @private
   */
  async _onLocalDateChange(dateData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;

    try {
      await this._api.put('/calendar/date', {
        year: dateData.year,
        month: dateData.month,
        day: dateData.day,
        hour: dateData.hour || 0,
        minute: dateData.minute || 0,
      });
    } catch (err) {
      console.error('Chronicle: Failed to push date to Chronicle', err);
    }
  }

  /**
   * Push date change from SimpleCalendar to Chronicle.
   * SimpleCalendar provides a different hook payload format.
   * @param {object} data - SimpleCalendar date-time-change hook data.
   * @private
   */
  async _onSimpleCalendarDateChange(data) {
    if (this._syncing) return;
    if (!game.user.isGM) return;

    // SimpleCalendar uses different data shape depending on version.
    // The hook provides { date: { year, month, day, ... }, diff: N, ... }
    const date = data?.date || data;
    if (!date) return;

    try {
      await this._api.put('/calendar/date', {
        year: date.year,
        // SimpleCalendar months are 0-indexed; Chronicle is 1-indexed.
        month: (date.month ?? 0) + 1,
        day: (date.day ?? 0) + 1,
        hour: date.hour || 0,
        minute: date.minute || 0,
      });
    } catch (err) {
      console.error('Chronicle: Failed to push SimpleCalendar date to Chronicle', err);
    }
  }

  /**
   * Push new event from legacy Calendaria to Chronicle.
   * @param {object} eventData
   * @private
   */
  async _onLocalEventCreate(eventData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;

    try {
      const result = await this._api.post('/calendar/events', {
        name: eventData.name || 'Untitled Event',
        year: eventData.year,
        month: eventData.month,
        day: eventData.day,
        description: eventData.description || '',
        visibility: 'everyone',
      });

      // Store the Chronicle event ID in the local module's data for later sync.
      if (result?.id && eventData.id) {
        await this._storeEventMapping(eventData.id, result.id);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push calendar event', err);
    }
  }

  /**
   * Push event update from legacy Calendaria to Chronicle.
   * @param {object} eventData
   * @private
   */
  async _onLocalEventUpdate(eventData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;

    const chronicleId = this._getChronicleEventId(eventData.id);
    if (!chronicleId) {
      // Event was created outside Chronicle; create it instead.
      await this._onLocalEventCreate(eventData);
      return;
    }

    try {
      await this._api.put(`/calendar/events/${chronicleId}`, {
        name: eventData.name || 'Untitled Event',
        year: eventData.year,
        month: eventData.month,
        day: eventData.day,
        description: eventData.description || '',
      });
    } catch (err) {
      console.error('Chronicle: Failed to update calendar event', err);
    }
  }

  /**
   * Push event delete from legacy Calendaria to Chronicle.
   * @param {object} eventData
   * @private
   */
  async _onLocalEventDelete(eventData) {
    if (this._syncing) return;
    if (!game.user.isGM) return;

    const chronicleId = this._getChronicleEventId(eventData.id);
    if (!chronicleId) return;

    try {
      await this._api.delete(`/calendar/events/${chronicleId}`);
      await this._removeEventMapping(eventData.id);
    } catch (err) {
      console.warn('Chronicle: Failed to delete calendar event', err);
    }
  }

  // --- SimpleCalendar Note CRUD (Foundry → Chronicle) ---
  // SimpleCalendar notes are JournalEntries with SC flags. We detect note
  // changes via standard Foundry journal hooks and check for flag presence.

  /**
   * Handle creation of a JournalEntry that may be a SimpleCalendar note.
   * Pushes new calendar events to Chronicle.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _onSimpleCalendarNoteCreate(journal, options, userId) {
    if (this._syncing || !game.user.isGM) return;
    if (userId !== game.user.id) return;

    const scData = this._extractSimpleCalendarData(journal);
    if (!scData) return;

    try {
      const result = await this._api.post('/calendar/events', {
        name: scData.name,
        year: scData.year,
        month: scData.month,
        day: scData.day,
        description: scData.description,
        visibility: 'everyone',
      });

      if (result?.id) {
        await this._storeEventMapping(journal.id, result.id);
        await journal.setFlag(FLAG_SCOPE, 'calendarEventId', result.id);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push SimpleCalendar note to Chronicle', err);
    }
  }

  /**
   * Handle update of a JournalEntry that may be a SimpleCalendar note.
   * Pushes event changes to Chronicle.
   * @param {JournalEntry} journal
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _onSimpleCalendarNoteUpdate(journal, change, options, userId) {
    if (this._syncing || !game.user.isGM) return;
    if (userId !== game.user.id) return;

    const scData = this._extractSimpleCalendarData(journal);
    if (!scData) return;

    const chronicleId = this._getChronicleEventId(journal.id)
      || journal.getFlag(FLAG_SCOPE, 'calendarEventId');

    if (!chronicleId) {
      // Note exists in SC but not in Chronicle — create it.
      await this._onSimpleCalendarNoteCreate(journal, options, userId);
      return;
    }

    try {
      await this._api.put(`/calendar/events/${chronicleId}`, {
        name: scData.name,
        year: scData.year,
        month: scData.month,
        day: scData.day,
        description: scData.description,
      });
    } catch (err) {
      console.error('Chronicle: Failed to update SimpleCalendar note in Chronicle', err);
    }
  }

  /**
   * Handle deletion of a JournalEntry that may be a SimpleCalendar note.
   * Removes the corresponding Chronicle calendar event.
   * @param {JournalEntry} journal
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _onSimpleCalendarNoteDelete(journal, options, userId) {
    if (this._syncing || !game.user.isGM) return;
    if (userId !== game.user.id) return;

    // Check if this was a SC note we know about.
    const chronicleId = this._getChronicleEventId(journal.id)
      || journal.getFlag(FLAG_SCOPE, 'calendarEventId');
    if (!chronicleId) return;

    try {
      await this._api.delete(`/calendar/events/${chronicleId}`);
      await this._removeEventMapping(journal.id);
    } catch (err) {
      console.warn('Chronicle: Failed to delete SimpleCalendar note from Chronicle', err);
    }
  }

  /**
   * Extract calendar event data from a SimpleCalendar note JournalEntry.
   * Returns null if the journal is not a SC note.
   * @param {JournalEntry} journal
   * @returns {object|null} - { name, year, month, day, description }
   * @private
   */
  _extractSimpleCalendarData(journal) {
    // SimpleCalendar stores note data under its module flag namespace.
    const scFlags = journal.flags?.['foundryvtt-simple-calendar']
      || journal.flags?.['simple-calendar'];
    if (!scFlags) return null;

    // SC note data includes noteData with startDate.
    const noteData = scFlags.noteData || scFlags;
    const startDate = noteData.startDate || noteData;

    // Validate that we have date fields.
    if (startDate.year === undefined && startDate.month === undefined) return null;

    return {
      name: journal.name || 'Untitled Event',
      // SC uses 0-indexed months/days; Chronicle uses 1-indexed.
      year: startDate.year ?? 0,
      month: (startDate.month ?? 0) + 1,
      day: (startDate.day ?? 0) + 1,
      description: noteData.content || noteData.description || '',
    };
  }

  // --- Worldstate bridge: celestial-note projection (W5 item 4) ---
  // Chronicle celestial events (meteor shower, eclipse, blood moon, …)
  // have no Calendaria equivalent, so they project as dated notes under a
  // reserved "Chronicle — Celestial" category: ONE note per event type per
  // day, updated in place, deleted when the GM clears the event. Chronicle
  // is the source of truth; the notes are a projection (locked ruling on
  // cordinator#34). dm_only → Calendaria 'secret'.

  /**
   * Rebuild the projection for the calendar's current day from the
   * world-state seed (token-surface GET /calendar/world-state).
   * @private
   */
  async _refreshCelestialProjection() {
    if (this._calendarModule !== 'calendaria' || !this._hasModernCalendariaApi) return;
    if (!getSetting('syncWorldstate')) return;
    if (this._isActiveCalendarExcluded()) return;
    try {
      const seed = await this._api.get('/calendar/world-state');
      await this._projectCelestialsFromSeed(seed);
    } catch (err) {
      console.warn('Chronicle: celestial projection refresh failed', err);
    }
  }

  /**
   * Diff+apply the projection for an already-fetched seed (shared by the
   * current-day refresh and the date-pinned day-change path).
   * @param {object} seed - world-state seed ({date, events, ...}).
   * @private
   */
  async _projectCelestialsFromSeed(seed) {
    if (this._calendarModule !== 'calendaria' || !this._hasModernCalendariaApi) return;
    if (!getSetting('syncWorldstate')) return;
    if (this._isActiveCalendarExcluded()) return;
    const api = globalThis.CALENDARIA?.api;
    if (typeof api?.getNotesForDate !== 'function' || typeof api?.createNote !== 'function') return;

    const date = seed?.date;
    if (!date || date.year === undefined) return;

    const all = api.getNotesForDate(date.year, date.month, date.day);
    const ours = (Array.isArray(all) ? all : []).filter(isChronicleCelestialNote);
    const plan = planCelestialProjection(ours, seed.events);
    await this._applyCelestialPlan(plan, date);
  }

  /**
   * Execute a projection plan against Calendaria's note API. Runs under
   * _syncing so the note hooks we trigger don't bounce into the note-sync
   * path (belt); the marker-based skip in those handlers is the suspenders.
   * @param {{creates,updates,deletes}} plan
   * @param {{year,month,day}} date
   * @private
   */
  async _applyCelestialPlan(plan, date) {
    const api = globalThis.CALENDARIA?.api;
    if (!api) return;
    const categoryId = await this._ensureCelestialCategory();

    this._syncing = true;
    try {
      for (const ev of plan.creates) {
        const vis = celestialNoteVisibility(ev);
        await api.createNote({
          name: ev.name || ev.type,
          content: celestialMarkerFor(ev.type) + (ev.name || ev.type),
          startDate: { year: date.year, month: date.month, day: date.day },
          allDay: true,
          // Both spellings: gmOnly is the documented createNote field;
          // visibility is the NOTE_VISIBILITY enum newer Calendaria takes.
          gmOnly: vis === 'secret',
          visibility: vis,
          ...(categoryId ? { categoryId } : {}),
          openSheet: false,
        });
      }
      for (const { note, event } of plan.updates) {
        if (!note.id) continue;
        const vis = celestialNoteVisibility(event);
        await api.updateNote(note.id, {
          name: event.name || event.type,
          content: celestialMarkerFor(event.type) + (event.name || event.type),
          gmOnly: vis === 'secret',
          visibility: vis,
        });
      }
      for (const note of plan.deletes) {
        if (!note.id) continue;
        await api.deleteNote(note.id);
      }
    } catch (err) {
      console.warn('Chronicle: celestial projection apply failed', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Best-effort create-once of the reserved note category. The category is
   * cosmetic grouping — the content marker is the identity signal — so any
   * missing/renamed category API degrades to uncategorized notes rather
   * than blocking the projection. Caches the resolved id per session.
   * @returns {Promise<string|null>}
   * @private
   */
  async _ensureCelestialCategory() {
    // undefined = never probed; null = probed, category API unavailable.
    if (this._celestialCategoryId !== undefined) return this._celestialCategoryId;
    const api = globalThis.CALENDARIA?.api;
    const LABEL = 'Chronicle — Celestial';
    try {
      // Probe whatever category listing the running Calendaria exposes.
      const lists = [api?.getNoteCategories, api?.getCategories, api?.getPresets];
      for (const fn of lists) {
        if (typeof fn !== 'function') continue;
        const cats = await fn.call(api);
        const found = (Array.isArray(cats) ? cats : []).find((c) => c?.label === LABEL || c?.name === LABEL);
        if (found?.id) {
          this._celestialCategoryId = found.id;
          return found.id;
        }
      }
      if (typeof api?.addPreset === 'function') {
        const created = await api.addPreset({ label: LABEL });
        if (created?.id) {
          this._celestialCategoryId = created.id;
          return created.id;
        }
      }
    } catch {
      /* degrade to uncategorized */
    }
    this._celestialCategoryId = null;
    return null;
  }

  // --- Adapter Methods (abstract over Calendaria vs SimpleCalendar) ---

  /**
   * Set the date on the active Foundry calendar module.
   * Uses CALENDARIA.api.setDateTime() when available for full hour/minute support.
   * @param {object} data - { year, month, day, hour, minute }
   * @private
   */
  async _setLocalDate(data) {
    this._syncing = true;
    try {
      if (this._calendarModule === 'calendaria') {
        if (this._hasModernCalendariaApi) {
          // Modern Calendaria: setDateTime supports full date + time.
          await CALENDARIA.api.setDateTime({
            year: data.year,
            month: data.month,
            day: data.day,
            hour: data.hour ?? 0,
            minute: data.minute ?? 0,
          });
        } else if (game.Calendaria?.setDate) {
          // Legacy Calendaria: setDate only supports date (no time).
          await game.Calendaria.setDate({
            year: data.year,
            month: data.month,
            day: data.day,
          });
        }
      } else if (this._calendarModule === 'simple-calendar') {
        const sc = SimpleCalendar?.api;
        if (sc?.setDate) {
          sc.setDate({
            year: data.year,
            // SimpleCalendar months are 0-indexed.
            month: (data.month || 1) - 1,
            day: (data.day || 1) - 1,
            hour: data.hour || 0,
            minute: data.minute || 0,
            seconds: 0,
          });
        }
      }
    } catch (err) {
      console.error('Chronicle: Failed to set local calendar date', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Create a calendar event in the active Foundry calendar module.
   * For Calendaria, creates a note via CALENDARIA.api.createNote() (modern)
   * or game.Calendaria.createEvent() (legacy).
   * @param {object} data - Chronicle event data.
   * @private
   */
  async _createLocalEvent(data) {
    if (this._calendarModule === 'calendaria') {
      if (this._hasModernCalendariaApi) {
        // Modern Calendaria: create a note (notes are the primary event type).
        try {
          const note = await CALENDARIA.api.createNote({
            name: data.name || 'Event',
            content: data.description || '',
            startDate: {
              year: data.year,
              month: data.month,
              day: data.day,
            },
            allDay: true,
            // Wire visibility is kebab `'gm-only'`. The pure helper
            // `isWireVisibilityGmOnly` accepts either kebab or the legacy
            // underscore form so this code keeps working if a Chronicle
            // event lands here with stale storage-side data (e.g. from a
            // mis-translated WS payload).
            gmOnly: isWireVisibilityGmOnly(data.visibility),
            openSheet: false,
          });
          if (note?.id) {
            await this._storeEventMapping(note.id, data.id);
          }
        } catch (err) {
          console.error('Chronicle: Failed to create Calendaria note from Chronicle event', err);
        }
      } else if (game.Calendaria?.createEvent) {
        // Legacy Calendaria.
        const localEvent = await game.Calendaria.createEvent({
          name: data.name,
          year: data.year,
          month: data.month,
          day: data.day,
          description: data.description || '',
        });
        if (localEvent?.id) {
          await this._storeEventMapping(localEvent.id, data.id);
        }
      } else {
        console.debug('Chronicle: Calendaria createEvent/createNote API not available');
      }
    } else if (this._calendarModule === 'simple-calendar') {
      // SimpleCalendar events are journal entries with note flags.
      const sc = SimpleCalendar?.api;
      if (sc?.addNote) {
        const note = await sc.addNote(
          data.name || 'Event',
          data.description || '',
          {
            year: data.year,
            month: (data.month || 1) - 1,
            day: (data.day || 1) - 1,
            hour: 0,
            minute: 0,
            seconds: 0,
          },
          {
            year: data.end_year || data.year,
            month: ((data.end_month || data.month) || 1) - 1,
            day: ((data.end_day || data.day) || 1) - 1,
            hour: 0,
            minute: 0,
            seconds: 0,
          },
          true, // allDay
          0,    // repeats (none)
        );
        if (note?.id) {
          await this._storeEventMapping(note.id, data.id);
          // Store Chronicle event ID on the journal entry.
          const journal = game.journal.get(note.id);
          if (journal) {
            await journal.setFlag(FLAG_SCOPE, 'calendarEventId', data.id);
          }
        }
      }
    }
  }

  /**
   * Update a calendar event in the active Foundry calendar module.
   * @param {object} data - Chronicle event data with id.
   * @private
   */
  async _updateLocalEvent(data) {
    if (this._calendarModule === 'calendaria') {
      const localId = this._getLocalEventId(data.id);
      if (!localId) return;

      if (this._hasModernCalendariaApi) {
        try {
          await CALENDARIA.api.updateNote(localId, {
            name: data.name,
            content: data.description || '',
            startDate: {
              year: data.year,
              month: data.month,
              day: data.day,
            },
          });
        } catch (err) {
          console.error('Chronicle: Failed to update Calendaria note', err);
        }
      } else if (game.Calendaria?.updateEvent) {
        await game.Calendaria.updateEvent(localId, {
          name: data.name,
          year: data.year,
          month: data.month,
          day: data.day,
          description: data.description || '',
        });
      }
    } else if (this._calendarModule === 'simple-calendar') {
      // SimpleCalendar notes are journal entries — update name/content.
      const localId = this._getLocalEventId(data.id);
      if (localId) {
        const journal = game.journal.get(localId);
        if (journal) {
          await journal.update({ name: data.name || journal.name });
        }
      }
    }
  }

  /**
   * Delete a calendar event from the active Foundry calendar module.
   * @param {object} data - { id: chronicleEventId }
   * @private
   */
  async _deleteLocalEvent(data) {
    const localId = this._getLocalEventId(data.id);
    if (!localId) return;

    if (this._calendarModule === 'calendaria') {
      if (this._hasModernCalendariaApi) {
        try {
          await CALENDARIA.api.deleteNote(localId);
        } catch (err) {
          console.error('Chronicle: Failed to delete Calendaria note', err);
        }
      } else if (game.Calendaria?.deleteEvent) {
        await game.Calendaria.deleteEvent(localId);
      }
    } else if (this._calendarModule === 'simple-calendar') {
      // Delete the journal entry that represents this note.
      const journal = game.journal.get(localId);
      if (journal) {
        await journal.delete();
      }
    }

    await this._removeEventMapping(localId);
  }

  // --- Initial Sync: Chronicle Events → Calendaria Notes ---

  /**
   * Fetch all Chronicle calendar events and create corresponding Calendaria
   * notes for any that don't already have local mappings.
   * @private
   */
  async _syncChronicleEventsToCalendariaNotes() {
    if (!this._hasModernCalendariaApi && !game.Calendaria?.createEvent) return;

    try {
      const events = await this._api.get('/calendar/events');
      if (!Array.isArray(events)) return;

      for (const event of events) {
        const localId = this._getLocalEventId(event.id);
        if (localId) continue; // Already synced.

        await this._createLocalEvent(event);
      }
    } catch (err) {
      // Calendar events endpoint may not exist yet; not critical.
      console.debug('Chronicle: Could not fetch calendar events for initial sync', err.message);
    }
  }

  // --- Event Mapping Helpers ---
  // Stores bidirectional mapping between local (Foundry) event IDs and
  // Chronicle event IDs using the GM's user flags for persistence.

  /**
   * Store a mapping between a local event ID and a Chronicle event ID.
   * @param {string} localId
   * @param {string} chronicleId
   * @private
   */
  async _storeEventMapping(localId, chronicleId) {
    const mappings = this._getEventMappings();
    mappings[localId] = chronicleId;
    mappings[`_rev_${chronicleId}`] = localId;
    await game.user.setFlag(FLAG_SCOPE, 'calendarEventMappings', mappings);
  }

  /**
   * Get the Chronicle event ID for a local event.
   * @param {string} localId
   * @returns {string|null}
   * @private
   */
  _getChronicleEventId(localId) {
    return this._getEventMappings()[localId] || null;
  }

  /**
   * Get the local event ID for a Chronicle event.
   * @param {string} chronicleId
   * @returns {string|null}
   * @private
   */
  _getLocalEventId(chronicleId) {
    return this._getEventMappings()[`_rev_${chronicleId}`] || null;
  }

  /**
   * Remove an event mapping.
   * @param {string} localId
   * @private
   */
  async _removeEventMapping(localId) {
    const mappings = this._getEventMappings();
    const chronicleId = mappings[localId];
    delete mappings[localId];
    if (chronicleId) {
      delete mappings[`_rev_${chronicleId}`];
    }
    await game.user.setFlag(FLAG_SCOPE, 'calendarEventMappings', mappings);
  }

  /**
   * Get all event mappings from user flags.
   * @returns {object}
   * @private
   */
  _getEventMappings() {
    return game.user.getFlag(FLAG_SCOPE, 'calendarEventMappings') || {};
  }
}
