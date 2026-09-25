/**
 * Chronicle Sync - Calendar/Calendaria/SimpleCalendar Sync
 *
 * Bidirectional sync between Chronicle's calendar system and Foundry's
 * calendar modules (Calendaria or SimpleCalendar, via an adapter pattern;
 * a no-op when neither is active). Chronicle → Foundry arrives via
 * WebSocket and updates the active module's date/events/notes; Foundry →
 * Chronicle is detected via Hooks and pushed to the Chronicle API (PUT
 * /calendar/date, POST/PUT/DELETE /calendar/events). Calendaria notes sync
 * as Chronicle calendar events, using Calendaria's modern hook names with
 * fallbacks for older versions. On first connect, fetches Chronicle's
 * calendar structure and optionally pushes it to the active module.
 */

import { getSetting, getCalendarSyncExclusions } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { shouldSkipDatePush, isRealTimeRejection, notifyRealTimePushPaused } from './_realtime-date-guard.mjs';
import { calendarBlackoutActive, handleIfCalendarRebuilding } from './_calendar-blackout-guard.mjs';
import { confirmAppliedDate } from './_applied-date-confirm.mjs';
import {
  ROUTED_CALENDAR_TYPES,
  STRUCTURE_SIGNAL_TYPES,
  announceSettingFor,
  emptySubresourceState,
  formatSubresourceLine,
  normalizeWeather,
  reduceSubresourceState,
} from './_calendar-subresources.mjs';

/**
 * Canonical wire-visibility values per the calendar-sync wire contract
 * (cordinator/decisions/2026-05-17-calendar-sync-wire-contract.md).
 * Chronicle's internal storage uses `'gm_only'` (underscore); its API
 * handler translates to/from wire `'gm-only'` (kebab) at the boundary.
 * This module emits and consumes only the wire (kebab) form.
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
 * Candidate Calendaria weather-setter method names, probed in order by
 * `_applyWeatherToCalendaria`. Calendaria's published API exposes weather
 * reads but no documented setter (weather is generated from zone/preset
 * tables). Probing a short list and degrading to chat beats hard-coding one
 * speculative name. Mirrored into the diagnostics probe list so a build
 * that does expose one shows up in a bug report.
 */
export const CALENDARIA_WEATHER_SETTERS = Object.freeze([
  'setWeather',
  'setCurrentWeather',
  'setWeatherForDate',
]);

/**
 * Escape a plain-text line for safe interpolation into a ChatMessage body.
 * Chronicle-authored strings (weather descriptions, season names) arrive
 * over the wire and land in innerHTML-rendered chat, so they must be
 * escaped at this boundary like every other ingress in this module.
 * @param {string} s
 * @returns {string}
 */
function escapeChatHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
 * Detects Calendaria's `flags.calendaria.isCalendarNote`/`isCalendarJournal`
 * or a SimpleCalendar flag scope (SIMPLE_CALENDAR_FLAG_SCOPES), plus our
 * own `calendarEventId` link flag once CalendarSync has mirrored a note.
 * JournalSync calls this to skip these documents: an unguarded POST to
 * `/entities` with `entity_type_id: 0` resolves to the campaign's first
 * entity type, wrongly surfacing holidays there instead of as calendar
 * events.
 *
 * Reads the nested `flags` object directly when `getFlag` is unavailable,
 * so it also works against plain object stubs in tests.
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

/**
 * Normalize a Calendaria note startDate to Chronicle's 1-indexed month/day.
 *
 * Calendaria stores dates 0-indexed internally (`month`/`dayOfMonth`), but
 * its `toPublic` conversion yields 1-indexed `month`/`day` (dayOfMonth
 * deleted); realtime `calendaria.note*` hooks deliver the raw form. So the
 * correction is keyed on SHAPE, never code path: a `day` field means
 * already-public (no correction), `dayOfMonth` means raw (0-indexed → +1).
 * Year is never adjusted.
 *
 * CAUTION: a raw Foundry `game.time.components` spread carries both
 * `dayOfMonth` (0-indexed) AND a day-of-YEAR `day`, which would wrongly
 * trip the passthrough branch — extract `{year, month, dayOfMonth}` first
 * (see `_onCalendariaDateTimeChange`).
 *
 * @param {object} startDate - Calendaria startDate ({year, month, day?|dayOfMonth?}).
 * @returns {{year:number, month:number, day:number}|null} 1-indexed, or null.
 */
export function chronicleDateFromCalendariaStartDate(startDate) {
  if (!startDate || startDate.year === undefined) return null;
  const year = startDate.year; // absolute — never adjust (no yearZero math)
  // A public (toPublic) date carries a 1-indexed `day` with `dayOfMonth`
  // deleted; a raw hook/stored date carries a 0-indexed `month` + `dayOfMonth`.
  if (startDate.day !== undefined) {
    return { year, month: startDate.month, day: startDate.day };
  }
  return {
    year,
    month: (startDate.month ?? 0) + 1,
    day: (startDate.dayOfMonth ?? 0) + 1,
  };
}

/**
 * Build the (year, month) fetch coordinates for the initial event back-catalog
 * sync. Chronicle's GET /calendar/events is month-filtered (defaults to the
 * calendar's current year+month), so enumerate each month across the
 * current year ±`yearSpan` — bounded, never unbounded history.
 *
 * @param {object} calendar - Chronicle calendar ({current_year, months:[...]}).
 * @param {number} [yearSpan=1] - Years to fetch on each side of current_year.
 * @returns {Array<{year:number, month:number}>}
 */
export function calendarEventFetchCoordinates(calendar, yearSpan = 1) {
  if (!calendar) return [];
  const monthCount = Array.isArray(calendar.months) ? calendar.months.length : 0;
  if (monthCount < 1) return [];
  const current = Number(calendar.current_year);
  const baseYear = Number.isFinite(current) ? current : 0;
  const span = Number.isFinite(yearSpan) && yearSpan >= 0 ? Math.floor(yearSpan) : 1;
  const coords = [];
  for (let y = baseYear - span; y <= baseYear + span; y++) {
    for (let m = 1; m <= monthCount; m++) {
      coords.push({ year: y, month: m });
    }
  }
  return coords;
}

/**
 * Compare Chronicle's calendar structure to the active Foundry calendar's,
 * for the structure-mismatch guard. Compares month count, per-month day
 * counts, and weekday count only — moons, seasons, eras are cosmetic to
 * date coordinates and excluded.
 *
 * Weekday comparison is skipped when either side reports 0 weekdays (a real
 * calendar always has ≥1, so 0 means the list was unreadable — pausing sync
 * on an unreadable list while months match would be a false positive). Leap
 * variants are excluded too: the Foundry structure reader only surfaces
 * base per-month `days`, so leap representation isn't pinned symmetrically.
 *
 * @param {object} chronicle - Chronicle calendar ({months:[{days}], weekdays:[]}).
 * @param {object} foundry - normalized active Foundry structure
 *   ({name, monthDays:number[], weekdayCount:number}).
 * @returns {{match:boolean, detail:string}}
 */
export function compareCalendarStructures(chronicle, foundry) {
  const cMonths = Array.isArray(chronicle?.months) ? chronicle.months : [];
  const cWeekdays = Array.isArray(chronicle?.weekdays) ? chronicle.weekdays : [];
  const chronicleMonthDays = cMonths.map((m) => Number(m?.days) || 0);
  const chronicleWeekdays = cWeekdays.length;

  const fMonthDays = Array.isArray(foundry?.monthDays) ? foundry.monthDays.map((d) => Number(d) || 0) : [];
  const fWeekdays = Number(foundry?.weekdayCount) || 0;

  const reasons = [];
  if (chronicleMonthDays.length !== fMonthDays.length) {
    reasons.push(`month count (Chronicle ${chronicleMonthDays.length} vs Foundry ${fMonthDays.length})`);
  } else {
    for (let i = 0; i < chronicleMonthDays.length; i++) {
      if (chronicleMonthDays[i] !== fMonthDays[i]) {
        reasons.push(`month ${i + 1} day count (Chronicle ${chronicleMonthDays[i]} vs Foundry ${fMonthDays[i]})`);
        break; // one representative day-count difference is enough to pause
      }
    }
  }
  // Only compare weekday counts when BOTH sides expose a real count (> 0). A 0
  // on either side signals an unreadable list, not a genuine mismatch — see the
  // doc comment's ride-along note.
  if (chronicleWeekdays > 0 && fWeekdays > 0 && chronicleWeekdays !== fWeekdays) {
    reasons.push(`weekday count (Chronicle ${chronicleWeekdays} vs Foundry ${fWeekdays})`);
  }

  if (!reasons.length) return { match: true, detail: '' };
  return { match: false, detail: reasons.join('; ') };
}

/**
 * Coerce a Calendaria collection (array, or an id-keyed `{values:{...}}` object)
 * into a plain array. Mirrors sync-calendar.mjs's reader — Calendaria stores
 * months/weekdays as id-keyed maps.
 * @param {...*} sources
 * @returns {Array}
 */
function readArrayLike(...sources) {
  for (const src of sources) {
    if (Array.isArray(src)) return src;
    if (src && typeof src === 'object') return Object.values(src);
  }
  return [];
}

/**
 * CalendarSync handles calendar ↔ Foundry calendar module synchronization.
 */
export class CalendarSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    /**
     * Reentrant echo-suppression guard, backed by a depth counter (not a
     * boolean — see the `_syncing` getter). Read through `_syncing`.
     * @type {number}
     */
    this._syncDepth = 0;

    /** @type {'calendaria'|'simple-calendar'|null} */
    this._calendarModule = null;

    /** @type {object|null} Cached Chronicle calendar structure. */
    this._chronicleCalendar = null;

    /** @type {boolean} Whether modern Calendaria API (CALENDARIA.api) is available. */
    this._hasModernCalendariaApi = false;

    /**
     * Session-scoped structure-mismatch guard (B-R2). When the active
     * Foundry calendar's structure differs from Chronicle's, calendar sync
     * is paused for the session (both directions) to avoid guaranteed
     * mis-dating; journals/characters/maps are untouched.
     * @type {boolean}
     */
    this._calendarSyncDisabled = false;
    /** @type {string|null} Human-readable mismatch detail for the dashboard + diagnostics. */
    this._calendarMismatchDetail = null;

    /**
     * Last-known Chronicle sub-resource snapshot (weather / season / era /
     * moon phases), folded from the WebSocket stream by
     * `reduceSubresourceState`. The dashboard's Calendar tab renders it;
     * nothing here writes into Foundry.
     * @type {ReturnType<typeof emptySubresourceState>}
     */
    this._subresourceState = emptySubresourceState();

    /**
     * Set when a `calendar.structure.updated` (or cycle/festival) broadcast
     * arrived this session AND the re-compare found the structures still
     * compatible. Feeds the dashboard's advisory `structure-changed` badge. We
     * never auto-apply the new structure — see `_onChronicleStructureUpdated`.
     * @type {string|null}
     */
    this._structureChangedDetail = null;

    /**
     * Types already logged by the `default:` branch of `onMessage`, so an
     * unhandled `calendar.*` type produces one debug line per session, not
     * one per broadcast.
     * @type {Set<string>}
     */
    this._loggedUnhandledTypes = new Set();

    // Bound hook handlers for cleanup.
    this._boundHandlers = {};
  }

  /**
   * Reentrant echo-suppression guard. `true` whenever any sync operation is
   * in flight. Backed by the `_syncDepth` counter rather than a boolean so a
   * WebSocket handler firing mid back-catalog doesn't clear the guard the
   * still-running loop depends on: a boolean's `finally` would unmask the
   * loop, letting its `_createLocalEvent` calls fire `calendaria.noteCreated`
   * unsuppressed and re-POST just-pulled events as duplicates. `_syncDepth`
   * increments on enter, decrements in `finally`; active while `> 0`.
   * @returns {boolean}
   * @private
   */
  get _syncing() {
    return this._syncDepth > 0;
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

    // Structure signals run even while paused, ahead of the mismatch guard:
    // they're the only broadcast that can clear a structure-mismatch pause
    // (fixing the calendar in Chronicle is what emits
    // `calendar.structure.updated`), so gating them behind the guard would
    // make the pause unrecoverable without a world reload. The handler
    // itself performs no writes into Foundry (see its doc comment).
    if (STRUCTURE_SIGNAL_TYPES.includes(msg?.type)) {
      await this._onChronicleStructureUpdated(msg.type);
      return;
    }

    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): no pull

    switch (msg.type) {
      case 'calendar.date.advanced':
        await this._onChronicaleDateAdvanced(msg.payload);
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

      // --- Sub-resources ------------------------------------------------
      // Display-level only: every branch below folds the payload into
      // `_subresourceState` for the dashboard and optionally posts a GM-only
      // chat line. None of them writes a Chronicle value into the Foundry
      // calendar's stored structure.
      case 'calendar.weather.changed':
        await this._onChronicleWeatherChanged(msg.payload);
        break;
      case 'calendar.worldstate.changed':
      case 'calendar.season.changed':
      case 'calendar.era.changed':
      case 'calendar.moon.phase_changed':
        await this._onChronicleSubresourceChanged(msg.type, msg.payload);
        break;

      default:
        this._logUnhandledCalendarType(msg?.type);
        break;
    }
  }

  /**
   * Log an unhandled `calendar.*` type once per session, so nothing falls
   * off the switch silently. Non-calendar types are ignored on purpose:
   * `SyncManager._routeMessage` fans every message to every module, so
   * entity/map/note traffic reaching CalendarSync is normal.
   *
   * @param {string|undefined} type
   * @private
   */
  _logUnhandledCalendarType(type) {
    if (typeof type !== 'string' || !type.startsWith('calendar.')) return;
    if (ROUTED_CALENDAR_TYPES.includes(type)) return;
    if (this._loggedUnhandledTypes.has(type)) return;
    this._loggedUnhandledTypes.add(type);
    console.debug(
      `Chronicle: unhandled calendar WebSocket type "${type}" — dropped. `
      + 'If this carries state the table should see, wire it in calendar-sync.mjs onMessage.',
    );
  }

  /**
   * Handle a sync mapping received during initial sync.
   * Stores calendar event mappings for later lookup.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping.chronicle_type !== 'calendar_event') return;
    if (!getSetting('syncCalendar') || !this._calendarModule) return;
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2)

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
    // @returns {Promise<boolean>} true only when a date was actually applied
    // locally — the dashboard's activity feed must not log a pull that
    // didn't happen (no calendar, a mismatch pause, or a thrown error).
    if (!getSetting('syncCalendar') || !this._calendarModule) return false;
    if (this._calendarSyncDisabled) return false;

    try {
      this._chronicleCalendar = await this._api.get('/calendar');
      if (!this._chronicleCalendar) {
        console.debug('Chronicle: No calendar configured for this campaign');
        return false;
      }

      // Structure-mismatch guard (B-R2): if the active Foundry calendar's
      // structure differs from Chronicle's, date coordinates are meaningless
      // across the wire — pause calendar sync for the session (both
      // directions) rather than push a Gregorian date into a custom
      // calendar. Fails open: only a confirmed mismatch pauses; require both
      // sides readable before comparing, so a degraded /calendar response
      // (no months) doesn't report a false 0-vs-N mismatch. Covers both
      // module paths — `_readActiveFoundryStructure` dispatches per module
      // and returns null for an unreadable structure.
      if (this._chronicleCalendar.months?.length > 0) {
        const foundryStruct = this._readActiveFoundryStructure();
        if (foundryStruct) {
          const cmp = compareCalendarStructures(this._chronicleCalendar, foundryStruct);
          if (!cmp.match) {
            this._pauseCalendarSyncForMismatch(this._chronicleCalendar, foundryStruct, cmp.detail);
            return false;
          }
        }
      }

      // Sync the current date from Chronicle to the Foundry calendar module.
      // This is the "poll" apply path (GET /calendar on connect/reconnect,
      // vs the WebSocket-driven _onChronicaleDateAdvanced below) — confirm
      // back to Chronicle only when _setLocalDate reports a real apply.
      const applied = await this._setLocalDate({
        year: this._chronicleCalendar.current_year,
        month: this._chronicleCalendar.current_month,
        day: this._chronicleCalendar.current_day,
        hour: this._chronicleCalendar.current_hour,
        minute: this._chronicleCalendar.current_minute,
      });
      if (applied) {
        await confirmAppliedDate(this._api, {
          year: this._chronicleCalendar.current_year,
          month: this._chronicleCalendar.current_month,
          day: this._chronicleCalendar.current_day,
        });
      }

      // Sync Chronicle calendar events to Calendaria notes (if using Calendaria).
      if (this._calendarModule === 'calendaria') {
        await this._syncChronicleEventsToCalendariaNotes();
      }

      console.debug('Chronicle: Calendar initial sync complete');
      return true;
    } catch (err) {
      // The blackout is expected, not a fault: arm the session guard and say so
      // once, rather than printing a red stack on every reconnect.
      if (handleIfCalendarRebuilding(err)) return false;
      console.error('Chronicle: Calendar initial sync failed', err);
      return false;
    }
  }

  /**
   * Read the active Calendaria calendar's structure (per-month day counts +
   * weekday count) for the mismatch guard. Calendaria stores months/weekdays as
   * id-keyed `{values:{...}}` maps and calls weekdays "days" (`cal.days`).
   * Returns null when the structure can't be read — the guard then fails OPEN
   * (sync is only paused on a CONFIRMED mismatch, never on inability to compare).
   * @returns {{name:string, monthDays:number[], weekdayCount:number}|null}
   * @private
   */
  _readActiveCalendariaStructure() {
    try {
      const api = globalThis.CALENDARIA?.api;
      const cal = api?.getActiveCalendar?.();
      if (!cal) return null;
      const months = readArrayLike(cal.monthsArray, cal.months?.values, cal.months);
      const weekdays = readArrayLike(cal.weekdaysArray, cal.days?.values, cal.days);
      if (!months.length) return null;
      return {
        name: cal.name || cal.metadata?.name || 'active Foundry calendar',
        monthDays: months.map((m) => Number(m?.days ?? 0)),
        weekdayCount: weekdays.length,
      };
    } catch (err) {
      console.debug('Chronicle: could not read active Calendaria structure', err?.message);
      return null;
    }
  }

  /**
   * Read the active SimpleCalendar calendar's structure (per-month day
   * counts + weekday count) for the mismatch guard — the SimpleCalendar
   * sibling of `_readActiveCalendariaStructure`.
   *
   * Exposes months via `numberOfDays` (base year; `numberOfLeapYearDays` is
   * excluded, mirroring the Calendaria reader — see
   * `compareCalendarStructures`). Prefers `getCurrentCalendar()`, falling
   * back to `getAllMonths()`/`getAllWeekdays()`. Returns null when the
   * structure can't be read — the guard then fails open (sync is only
   * paused on a confirmed mismatch, never on inability to compare).
   * @returns {{name:string, monthDays:number[], weekdayCount:number}|null}
   * @private
   */
  _readActiveSimpleCalendarStructure() {
    try {
      const sc = globalThis.SimpleCalendar?.api;
      if (!sc) return null;
      let months = [];
      let weekdays = [];
      let name = 'active Foundry calendar';
      const cal = typeof sc.getCurrentCalendar === 'function' ? sc.getCurrentCalendar() : null;
      if (cal) {
        months = readArrayLike(cal.months);
        weekdays = readArrayLike(cal.weekdays);
        name = cal.name || cal.id || name;
      }
      if (!months.length && typeof sc.getAllMonths === 'function') {
        months = readArrayLike(sc.getAllMonths());
      }
      if (!weekdays.length && typeof sc.getAllWeekdays === 'function') {
        weekdays = readArrayLike(sc.getAllWeekdays());
      }
      if (!months.length) return null;
      return {
        name,
        monthDays: months.map((m) => Number(m?.numberOfDays ?? m?.days ?? 0)),
        weekdayCount: weekdays.length,
      };
    } catch (err) {
      console.debug('Chronicle: could not read active SimpleCalendar structure', err?.message);
      return null;
    }
  }

  /**
   * Read the active Foundry calendar's structure for the mismatch guard,
   * dispatching to the per-module reader. Returns null for an unknown
   * module or an unreadable structure (guard fails open).
   * @returns {{name:string, monthDays:number[], weekdayCount:number}|null}
   * @private
   */
  _readActiveFoundryStructure() {
    if (this._calendarModule === 'calendaria') return this._readActiveCalendariaStructure();
    if (this._calendarModule === 'simple-calendar') return this._readActiveSimpleCalendarStructure();
    return null;
  }

  /**
   * Pause calendar sync for the session on a structure mismatch (B-R2): set the
   * guard flag + detail (which suppresses both push and pull), log, and emit ONE
   * persistent ui.notifications.warn. The dashboard surfaces the same state.
   * @param {object} chronicleCal - Chronicle calendar ({name, months, weekdays}).
   * @param {{name:string, monthDays:number[], weekdayCount:number}} foundryStruct
   * @param {string} detail - the specific mismatch (from compareCalendarStructures).
   * @private
   */
  _pauseCalendarSyncForMismatch(chronicleCal, foundryStruct, detail) {
    this._calendarSyncDisabled = true;
    const chronicleName = chronicleCal?.name || 'Chronicle calendar';
    const chronicleShape = `${(chronicleCal?.months || []).length}mo/${(chronicleCal?.weekdays || []).length}wd`;
    const foundryName = foundryStruct?.name || 'active Foundry calendar';
    const foundryShape = `${(foundryStruct?.monthDays || []).length}mo/${foundryStruct?.weekdayCount ?? 0}wd`;
    this._calendarMismatchDetail =
      `Chronicle: ${chronicleName} ${chronicleShape} · Foundry: ${foundryName} ${foundryShape} — ${detail}`;
    // The remedy must be "edit either calendar", never "import" or "author a
    // new one" — Chronicle rejects importing a second calendar (409) and has
    // no route to make an authored one the served default, so both would be
    // unreachable advice. TODO(#95): once Chronicle lets a campaign choose
    // which calendar is served, offer pointing this module at a different
    // one. Pinned by tools/test-calendar-mismatch-remedy.mjs against this
    // string and the dashboard's two banners.
    const msg = `Chronicle Sync: calendar structures differ (${this._calendarMismatchDetail}). `
      + 'Calendar sync is paused for this session — edit either calendar so the two agree '
      + '(Chronicle: Calendar Settings → Months / Weekdays; Foundry: your calendar module), '
      + 'then reload the world. '
      + '(Journals, characters, and maps still sync.)';
    console.warn(msg);
    try { globalThis.ui?.notifications?.warn(msg, { permanent: true }); } catch { /* headless */ }
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
   * Update the local Foundry calendar date from Chronicle. This is the
   * WebSocket-driven apply path (`calendar.date.advanced`) — confirm back to
   * Chronicle only when `_setLocalDate` reports a real apply.
   * @param {object} data - { year, month, day, hour, minute }
   * @private
   */
  async _onChronicaleDateAdvanced(data) {
    if (!data) return;
    const applied = await this._setLocalDate(data);
    if (applied) {
      await confirmAppliedDate(this._api, { year: data.year, month: data.month, day: data.day });
    }
  }

  // --- Chronicle → Foundry: sub-resources -----------------------------

  /**
   * Whisper one line to the GMs. This is the only chat surface for
   * sub-resource announcements — always whisper, never broadcast: Chronicle's
   * WS hub gates dm_only traffic server-side, so a payload reaching this
   * module is cleared for the GM but not necessarily for the table (weather
   * zones and world state can encode information the DM is holding back).
   * Re-broadcasting to public chat would launder that server-side permission
   * decision into a player-visible one. The GM decides what to share; the
   * module never decides for them.
   *
   * @param {string|null} line
   * @private
   */
  _announceToGM(line) {
    if (!line) return;
    try {
      const gmIds = globalThis.ChatMessage?.getWhisperRecipients?.('GM')?.map((u) => u.id) ?? [];
      globalThis.ChatMessage?.create?.({
        content: `<p>${escapeChatHtml(line)}</p>`,
        whisper: gmIds,
        speaker: { alias: 'Chronicle' },
      });
    } catch (err) {
      // Chat is a courtesy surface — never let it break message routing.
      console.debug('Chronicle: sub-resource chat announcement failed', err?.message);
    }
  }

  /**
   * Should this sub-resource type announce in chat right now? Reads the
   * per-type world setting (`announceSettingFor`). Unknown settings fail
   * CLOSED (no announcement) rather than spamming a world whose settings
   * predate this release.
   * @param {string} type
   * @returns {boolean}
   * @private
   */
  _shouldAnnounce(type) {
    const key = announceSettingFor(type);
    if (!key) return false;
    try {
      return getSetting(key) === true;
    } catch {
      return false;
    }
  }

  /**
   * Handle `calendar.weather.changed`. A `null` payload is a "refetch me"
   * ping from the weather-zone paths, so it triggers one `GET
   * /calendar/weather` instead of being discarded; otherwise it's the
   * merged `WeatherInput` from `SetWeather`.
   *
   * Applies to Calendaria's weather setter when the active build exposes
   * one (see `_applyWeatherToCalendaria`); otherwise (SimpleCalendar, or
   * read-only Calendaria weather) falls back to the GM chat line. The
   * dashboard panel updates either way.
   *
   * @param {object|null} payload
   * @private
   */
  async _onChronicleWeatherChanged(payload) {
    this._syncDepth++;
    try {
      let raw = payload;
      if (!raw) {
        // Zone-change ping: the type fired with no body. Refetch the reading.
        try {
          raw = await this._api.get('/calendar/weather');
        } catch (err) {
          console.debug('Chronicle: weather refetch after zone change failed', err?.message);
        }
      }
      const weather = normalizeWeather(raw);
      if (!weather) return;

      this._subresourceState = reduceSubresourceState(
        this._subresourceState, 'calendar.weather.changed', raw,
      );

      const appliedToModule = await this._applyWeatherToCalendaria(weather);
      if (!appliedToModule && this._shouldAnnounce('calendar.weather.changed')) {
        this._announceToGM(this._subresourceState.weatherLine);
      }
    } finally {
      this._syncDepth--;
    }
  }

  /**
   * Push a weather reading into Calendaria when — and only when — its API
   * exposes a setter. No known Calendaria build documents a weather setter
   * (its weather is generated from zone/preset tables), so this probes the
   * plausible names (`CALENDARIA_WEATHER_SETTERS`) and no-ops when none is
   * present, returning false so the caller falls back to chat.
   *
   * @param {ReturnType<typeof normalizeWeather>} weather
   * @returns {Promise<boolean>} true when the reading was handed to Calendaria
   * @private
   */
  async _applyWeatherToCalendaria(weather) {
    if (this._calendarModule !== 'calendaria' || !weather) return false;
    try {
      const api = globalThis.CALENDARIA?.api;
      if (!api) return false;
      const setter = CALENDARIA_WEATHER_SETTERS.find((n) => typeof api[n] === 'function');
      if (!setter) return false;
      await api[setter]({
        label:         weather.presetLabel,
        temperature:   weather.temperatureC,
        windTier:      weather.windTier,
        windSpeed:     weather.windSpeedKph,
        windDirection: weather.windDirection,
        precipitation: weather.precipType,
        intensity:     weather.precipIntensity,
        zone:          weather.zoneName,
        description:   weather.description,
      });
      console.debug(`Chronicle: applied Chronicle weather via CALENDARIA.api.${setter}`);
      return true;
    } catch (err) {
      // A failed apply must degrade to the chat line, not swallow the update.
      console.debug('Chronicle: Calendaria weather apply failed, falling back to chat', err?.message);
      return false;
    }
  }

  /**
   * Handle the display-only sub-resource types: world state, season, era and
   * moon phase. Each folds into `_subresourceState` (which the dashboard's
   * Calendar tab renders) and optionally posts a GM-only chat line, gated by
   * that type's world setting.
   *
   * **No writes into Foundry.** Nothing here creates a note, mutates a
   * calendar, or touches a document. The world-state branch never
   * auto-creates a same-day Calendaria note for celestial events: the
   * payload carries no celestial detail and no stable event id, so a
   * re-broadcast could create duplicate, undeduplicable notes.
   *
   * @param {string} type
   * @param {object|null} payload
   * @private
   */
  async _onChronicleSubresourceChanged(type, payload) {
    this._syncDepth++;
    try {
      this._subresourceState = reduceSubresourceState(this._subresourceState, type, payload);
      if (!this._shouldAnnounce(type)) return;
      this._announceToGM(formatSubresourceLine(type, payload));
    } finally {
      this._syncDepth--;
    }
  }

  /**
   * Handle `calendar.structure.updated` and its granular siblings
   * (`calendar.cycle.changed`, `calendar.festival.changed`).
   *
   * **Deliberately does NOT auto-apply the new structure**: Calendaria
   * stores notes against month/day coordinates, so re-shaping the calendar
   * underneath them would silently re-date every note in the world.
   * Instead: refetch `GET /calendar`, re-run the same fail-open comparison
   * `onInitialSync` runs (an unreadable structure on either side never
   * pauses anything), then pause on incompatible or record the advisory
   * `structure-changed` badge on still-compatible. Compatible AND
   * previously paused for a mismatch clears the pause — this is the only
   * recovery path that doesn't need a world reload.
   *
   * Runs even while paused — it's the one handler that must (see `onMessage`).
   *
   * @param {string} [type] - the signal type, for the log line.
   * @private
   */
  async _onChronicleStructureUpdated(type = 'calendar.structure.updated') {
    this._syncDepth++;
    try {
      let cal = null;
      try {
        cal = await this._api.get('/calendar');
      } catch (err) {
        console.debug('Chronicle: structure re-compare could not refetch /calendar', err?.message);
      }
      if (cal) this._chronicleCalendar = cal;

      const chronicleCal = this._chronicleCalendar;
      // Fail open, exactly as onInitialSync does: no readable structure on
      // either side means no verdict, so we neither pause nor un-pause.
      if (!(chronicleCal?.months?.length > 0)) {
        console.debug(`Chronicle: ${type} received; Chronicle structure unreadable — no re-compare.`);
        return;
      }
      const foundryStruct = this._readActiveFoundryStructure();
      if (!foundryStruct) {
        console.debug(`Chronicle: ${type} received; Foundry structure unreadable — no re-compare.`);
        return;
      }

      const cmp = compareCalendarStructures(chronicleCal, foundryStruct);
      if (!cmp.match) {
        this._structureChangedDetail = null;
        if (!this._calendarSyncDisabled) {
          this._pauseCalendarSyncForMismatch(chronicleCal, foundryStruct, cmp.detail);
        }
        return;
      }

      // Compatible. Recover from a prior mismatch pause if there was one.
      if (this._calendarSyncDisabled) {
        this._calendarSyncDisabled = false;
        this._calendarMismatchDetail = null;
        const msg = 'Chronicle Sync: the Chronicle calendar structure now matches the active '
          + 'Foundry calendar — calendar sync resumed for this session.';
        console.warn(msg);
        try { globalThis.ui?.notifications?.info(msg); } catch { /* headless */ }
      }

      const chronicleShape = `${(chronicleCal.months || []).length}mo/${(chronicleCal.weekdays || []).length}wd`;
      const foundryShape = `${(foundryStruct.monthDays || []).length}mo/${foundryStruct.weekdayCount ?? 0}wd`;
      this._structureChangedDetail =
        `Chronicle's calendar structure changed (${type}). Re-compared: still compatible `
        + `(Chronicle ${chronicleShape} vs Foundry ${foundryShape}). Month names, cycles, festivals `
        + 'and era boundaries are outside this comparison — re-check the calendar. '
        + 'The Foundry calendar was NOT modified.';
      console.debug(`Chronicle: ${this._structureChangedDetail}`);
    } finally {
      this._syncDepth--;
    }
  }

  /**
   * Create a local calendar event from Chronicle data.
   * @param {object} data - Chronicle event object.
   * @private
   */
  async _onChronicleEventCreated(data) {
    if (!data) return;
    this._syncDepth++;
    try {
      await this._createLocalEvent(data);
    } finally {
      this._syncDepth--;
    }
  }

  /**
   * Update a local calendar event from Chronicle data.
   * @param {object} data - Chronicle event object.
   * @private
   */
  async _onChronicleEventUpdated(data) {
    if (!data) return;
    this._syncDepth++;
    try {
      await this._updateLocalEvent(data);
    } finally {
      this._syncDepth--;
    }
  }

  /**
   * Delete a local calendar event from Chronicle data.
   * @param {object} data - { id: eventId }
   * @private
   */
  async _onChronicleEventDeleted(data) {
    if (!data) return;
    this._syncDepth++;
    try {
      await this._deleteLocalEvent(data);
    } finally {
      this._syncDepth--;
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs
    if (this._isActiveCalendarExcluded()) return;

    // Calendaria's dateTimeChange payload nests the raw date components under
    // `.current` (a spread of game.time.components), 0-indexed month/dayOfMonth
    // with an already-adjusted year. `.current` also carries a day-of-YEAR
    // `day` sibling that would wrongly trip chronicleDateFromCalendariaStartDate's
    // "has `day` → already public" branch, so build a clean {year, month,
    // dayOfMonth} stub when dayOfMonth is present and pass the source through
    // otherwise, keeping the 0→1 correction in that one helper.
    const src = (data && data.current) ? data.current : data;
    if (!src) return;
    const startDate = (src.dayOfMonth !== undefined)
      ? { year: src.year, month: src.month, dayOfMonth: src.dayOfMonth }
      : src;
    const date = chronicleDateFromCalendariaStartDate(startDate);
    if (!date) return;

    // Check before the pre-push probe so a known blackout costs zero requests.
    if (calendarBlackoutActive()) return;

    try {
      if (await shouldSkipDatePush(this._api)) return;
      await this._api.put('/calendar/date', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: src.hour ?? 0,
        minute: src.minute ?? 0,
      });
    } catch (err) {
      if (isRealTimeRejection(err)) { notifyRealTimePushPaused(); return; }
      // A 503 calendar_rebuilding arms the session guard and notifies once,
      // rather than logging an error on every world-time tick.
      if (handleIfCalendarRebuilding(err)) return;
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs
    if (this._isActiveCalendarExcluded()) return;

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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs
    if (this._isActiveCalendarExcluded()) return;

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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs
    if (this._isActiveCalendarExcluded()) return;

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

    // Prefer the authoritative note from the modern Calendaria API: getNote()
    // returns toPublic (1-indexed) dates, the source of truth. The realtime
    // note* hook payload instead carries raw 0-indexed dates; both shapes are
    // normalized by chronicleDateFromCalendariaStartDate, keyed on the date
    // SHAPE (dayOfMonth vs day) so there is no double-correction.
    let flagData = noteData.flagData || noteData;
    let name = noteData.name || noteData.title;
    if (this._hasModernCalendariaApi && noteData.id && typeof globalThis.CALENDARIA?.api?.getNote === 'function') {
      try {
        const note = CALENDARIA.api.getNote(noteData.id);
        if (note?.flagData?.startDate) {
          flagData = note.flagData;
          name = note.name || name;
        }
      } catch { /* fall through to the raw hook payload */ }
    }

    const startDate = flagData.startDate || flagData;
    const date = chronicleDateFromCalendariaStartDate(startDate);
    if (!date) return null;

    // Six keys, no more. PUT /calendar/events/:id is a partial update —
    // absent preserves, explicit null clears, a value replaces (see
    // API-CONTRACT.md). Do not widen this to echo other fields back: an
    // echo re-arms the endpoint for the next writer and goes stale.
    return {
      name: name || 'Untitled Note',
      year: date.year,
      month: date.month,
      day: date.day,
      description: noteData.content || noteData.description || flagData.content || '',
      // Must emit kebab-case ('gm-only') on the wire, per WIRE_VISIBILITY.
      visibility: chronicleVisibilityFromCalendariaNote(noteData),
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs

    // Check before the pre-push probe so a known blackout costs zero requests.
    if (calendarBlackoutActive()) return;

    try {
      if (await shouldSkipDatePush(this._api)) return;
      await this._api.put('/calendar/date', {
        year: dateData.year,
        month: dateData.month,
        day: dateData.day,
        hour: dateData.hour || 0,
        minute: dateData.minute || 0,
      });
    } catch (err) {
      if (isRealTimeRejection(err)) { notifyRealTimePushPaused(); return; }
      // A 503 calendar_rebuilding arms the session guard and notifies once,
      // rather than logging an error on every world-time tick.
      if (handleIfCalendarRebuilding(err)) return;
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs

    // SimpleCalendar uses different data shape depending on version.
    // The hook provides { date: { year, month, day, ... }, diff: N, ... }
    const date = data?.date || data;
    if (!date) return;

    // Check before the pre-push probe so a known blackout costs zero requests.
    if (calendarBlackoutActive()) return;

    try {
      if (await shouldSkipDatePush(this._api)) return;
      await this._api.put('/calendar/date', {
        year: date.year,
        // SimpleCalendar months are 0-indexed; Chronicle is 1-indexed.
        month: (date.month ?? 0) + 1,
        day: (date.day ?? 0) + 1,
        hour: date.hour || 0,
        minute: date.minute || 0,
      });
    } catch (err) {
      if (isRealTimeRejection(err)) { notifyRealTimePushPaused(); return; }
      // A 503 calendar_rebuilding arms the session guard and notifies once,
      // rather than logging an error on every world-time tick.
      if (handleIfCalendarRebuilding(err)) return;
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs

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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs

    const chronicleId = this._getChronicleEventId(eventData.id);
    if (!chronicleId) {
      // Event was created outside Chronicle; create it instead.
      await this._onLocalEventCreate(eventData);
      return;
    }

    try {
      // Narrow body on purpose: PUT /calendar/events/:id is a partial update
      // (absent preserves, null clears, a value replaces — API-CONTRACT.md).
      // Do not widen this to echo other fields back.
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
    if (this._calendarSyncDisabled) return; // structure-mismatch guard (B-R2): pause push both dirs

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
      // Narrow body ON PURPOSE — see _onLocalEventUpdate for why this stays
      // five keys and must not grow an echo of the event's other columns.
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

  // --- Adapter Methods (abstract over Calendaria vs SimpleCalendar) ---

  /**
   * Set the date on the active Foundry calendar module.
   * Uses CALENDARIA.api.setDateTime() when available for full hour/minute support.
   *
   * The return value is a best-effort signal, not a real ack: neither
   * Calendaria's setDateTime/setDate nor SimpleCalendar's setDate reports
   * success. `true` means a setter for the detected module was invoked
   * without throwing; `false` means no setter was available or it threw.
   * @param {object} data - { year, month, day, hour, minute }
   * @returns {Promise<boolean>} true if a local setter was invoked and did not throw.
   * @private
   */
  async _setLocalDate(data) {
    this._syncDepth++;
    let applied = false;
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
          applied = true;
        } else if (game.Calendaria?.setDate) {
          // Legacy Calendaria: setDate only supports date (no time).
          await game.Calendaria.setDate({
            year: data.year,
            month: data.month,
            day: data.day,
          });
          applied = true;
        }
      } else if (this._calendarModule === 'simple-calendar') {
        const sc = SimpleCalendar?.api;
        if (sc?.setDate) {
          // Awaited so a promise-returning setDate is settled before this
          // method reports success to its callers.
          await sc.setDate({
            year: data.year,
            // SimpleCalendar months are 0-indexed.
            month: (data.month || 1) - 1,
            day: (data.day || 1) - 1,
            hour: data.hour || 0,
            minute: data.minute || 0,
            seconds: 0,
          });
          applied = true;
        }
      }
    } catch (err) {
      console.error('Chronicle: Failed to set local calendar date', err);
      applied = false;
    } finally {
      this._syncDepth--;
    }
    return applied;
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
            // isWireVisibilityGmOnly accepts kebab or the legacy underscore
            // form, so stale storage-side data still resolves correctly.
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

    // GET /calendar/events is month-filtered (defaults to the calendar's
    // current year+month), so enumerate each month across the current year
    // ±1 from the cached Chronicle structure — bounded, never unbounded.
    const coords = calendarEventFetchCoordinates(this._chronicleCalendar, 1);
    // No cached structure to enumerate (e.g. /calendar returned no months) →
    // fall back to the single default (current-month) fetch rather than nothing.
    const fetches = coords.length ? coords : [null];

    const seen = new Set();
    let created = 0;
    // _createLocalEvent → CALENDARIA.api.createNote fires the synchronous
    // calendaria.noteCreated hook synchronously, which would otherwise re-POST
    // the just-pulled event back to Chronicle as a duplicate; hold _syncing
    // across the loop, as _onChronicleEventCreated does for the WS pull path.
    this._syncDepth++;
    try {
      for (const coord of fetches) {
        const path = coord
          ? `/calendar/events?year=${coord.year}&month=${coord.month}`
          : '/calendar/events';
        let payload;
        try {
          payload = await this._api.get(path);
        } catch (err) {
          console.debug('Chronicle: back-catalog fetch failed for', path, err.message);
          continue;
        }
        // GET /calendar/events returns an envelope { data:[...], total } like
        // getNotes() unwraps elsewhere — accept that AND a bare array here,
        // kept local so get()'s contract for other callers is unchanged.
        const events = Array.isArray(payload)
          ? payload
          : (payload && Array.isArray(payload.data) ? payload.data : null);
        if (!events) continue;
        for (const event of events) {
          // Dedupe across months: a recurring event can surface in several
          // month windows, but maps to ONE Chronicle event id.
          if (!event || event.id == null || seen.has(event.id)) continue;
          seen.add(event.id);
          if (this._getLocalEventId(event.id)) continue; // already synced
          await this._createLocalEvent(event);
          created++;
        }
      }
      const bound = coords.length
        ? `years ${this._chronicleCalendar.current_year - 1}–${this._chronicleCalendar.current_year + 1}, ${fetches.length} month-window(s)`
        : 'current month only (no calendar structure cached)';
      console.debug(`Chronicle: back-catalog event sync complete — scanned ${bound}; created ${created} local note(s).`);
    } catch (err) {
      // Calendar events endpoint may not exist yet; not critical.
      console.debug('Chronicle: Could not sync calendar events back-catalog', err.message);
    } finally {
      this._syncDepth--;
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
