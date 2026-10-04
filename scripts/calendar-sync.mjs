/**
 * Chronicle Sync - Calendar
 *
 * Pulls Chronicle's calendar (current date, events, weather, season, era,
 * moon phases) over REST and the WebSocket and exposes it to the dashboard.
 * No Foundry calendar module is integrated, so nothing here writes a date or
 * a note into Foundry. The guarded date push (`pushDate`) and the
 * `calendar.*` message routing are what the built-in calendar plugs into.
 * TODO(#95): apply Chronicle's date and events to the built-in calendar and
 * call `pushDate` from its date-change hook.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { shouldSkipDatePush, isRealTimeRejection, notifyRealTimePushPaused } from './_realtime-date-guard.mjs';
import { calendarBlackoutActive, handleIfCalendarRebuilding, noteCalendarAnswerOk } from './_calendar-blackout-guard.mjs';
import { datePushPaused, handleDatePushRefusal, resumeDatePush } from './_date-push-rejection.mjs';
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
 * Pure helper: may this Chronicle event be shown to every player in Foundry?
 * False for a GM-only event, and also for an `everyone` event that carries
 * `visibility_rules` (an allow- or deny-list of players): Foundry notes can't
 * express "only these players", so those stay GM-only. Fails closed: an
 * unknown visibility value or unreadable rules count as restricted.
 *
 * Exported for unit testing.
 *
 * @param {object|null} event - Chronicle event as served by the sync API.
 * @returns {boolean}
 */
export function isChronicleEventPublic(event) {
  if (!event || typeof event !== 'object') return false;
  const v = event.visibility;
  // Absent visibility: servers older than the wire contract only sent public events.
  if (v !== undefined && v !== null && v !== WIRE_VISIBILITY.EVERYONE) return false;
  return !hasVisibilityRules(event.visibility_rules);
}

/**
 * Does a raw `visibility_rules` value (a JSON string on the wire, or an
 * already-parsed object) name any allowed or denied users? Unparseable →
 * true, so a malformed rule never widens visibility.
 *
 * @param {string|object|null|undefined} raw
 * @returns {boolean}
 */
function hasVisibilityRules(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  let rules = raw;
  if (typeof raw === 'string') {
    try {
      rules = JSON.parse(raw);
    } catch {
      return true;
    }
  }
  if (rules === null) return false;
  if (typeof rules !== 'object' || Array.isArray(rules)) return true;
  const named = (list) => Array.isArray(list) && list.length > 0;
  return named(rules.allowed_users) || named(rules.denied_users);
}

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
 * Flag scopes third-party calendar modules put on their note journals. The
 * module no longer talks to those calendars, but a world that once used one
 * still holds its notes, and they must never be pushed as entities.
 */
const FOREIGN_CALENDAR_NOTE_FLAGS = Object.freeze({
  calendaria: (f) => f?.isCalendarNote === true || f?.isCalendarJournal === true,
  'foundryvtt-simple-calendar': (f) => !!f,
  'simple-calendar': (f) => !!f,
});

/**
 * Pure predicate: is this Foundry JournalEntry a calendar note JournalSync
 * must skip? True for one Chronicle already mirrored to a calendar event
 * (our own `calendarEventId` link flag) and for notes a third-party calendar
 * module left in the world. An unguarded POST to `/entities` with
 * `entity_type_id: 0` resolves to the campaign's first entity type, wrongly
 * surfacing the note there.
 *
 * Reads the nested `flags` object directly so it also works against plain
 * object stubs in tests.
 *
 * @param {object|null} journal - A Foundry JournalEntry (or test stub).
 * @returns {boolean}
 */
export function isCalendarNoteJournal(journal) {
  if (!journal || typeof journal !== 'object') return false;
  const flags = journal.flags || {};
  if (flags[FLAG_SCOPE]?.calendarEventId) return true;
  for (const [scope, isNote] of Object.entries(FOREIGN_CALENDAR_NOTE_FLAGS)) {
    if (isNote(flags[scope])) return true;
  }
  return false;
}

/**
 * CalendarSync keeps Chronicle's calendar state for the dashboard and routes
 * its `calendar.*` WebSocket types.
 */
export class CalendarSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {object|null} Cached Chronicle calendar (GET /calendar). */
    this._chronicleCalendar = null;

    /**
     * Last-known Chronicle sub-resource snapshot (weather / season / era /
     * moon phases), folded from the WebSocket stream by
     * `reduceSubresourceState`. The dashboard's Calendar tab renders it.
     * @type {ReturnType<typeof emptySubresourceState>}
     */
    this._subresourceState = emptySubresourceState();

    /**
     * Types already logged by the `default:` branch of `onMessage`, so an
     * unhandled `calendar.*` type produces one debug line per session, not
     * one per broadcast.
     * @type {Set<string>}
     */
    this._loggedUnhandledTypes = new Set();
  }

  /**
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;
  }

  /** Nothing is registered with Foundry, so there is nothing to release. */
  destroy() {}

  /**
   * Handle incoming WebSocket messages for calendar events.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncCalendar')) return;

    if (STRUCTURE_SIGNAL_TYPES.includes(msg?.type)) {
      await this._onChronicleStructureUpdated(msg.type);
      return;
    }

    switch (msg?.type) {
      case 'calendar.date.advanced':
        this._onChronicleDateAdvanced(msg.payload);
        break;
      case 'calendar.event.created':
        this._onChronicleEventCreated(msg.payload);
        break;
      case 'calendar.event.updated':
        this._onChronicleEventUpdated(msg.payload);
        break;
      case 'calendar.event.deleted':
        this._onChronicleEventDeleted(msg.payload);
        break;

      // --- Sub-resources ------------------------------------------------
      // Display-level only: every branch below folds the payload into
      // `_subresourceState` for the dashboard and optionally posts a GM-only
      // chat line.
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
   * Fetch Chronicle's calendar on WebSocket connect and cache it.
   * @returns {Promise<boolean>} true when a calendar was fetched.
   */
  async onInitialSync() {
    if (!getSetting('syncCalendar')) return false;
    // A reconnect or manual pull gives a refused date push another chance:
    // the GM may have fixed the calendar or the key in between.
    resumeDatePush();

    try {
      this._chronicleCalendar = await this._api.get('/calendar');
      if (!this._chronicleCalendar) {
        console.debug('Chronicle: No calendar configured for this campaign');
        return false;
      }
      noteCalendarAnswerOk();
      // TODO(#95): apply the date to the built-in calendar, then
      // confirmAppliedDate (_applied-date-confirm.mjs).
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
   * Chronicle's current date as last pulled or broadcast.
   * @returns {{year:number, month:number, day:number, hour:number, minute:number}|null}
   */
  get chronicleDate() {
    const c = this._chronicleCalendar;
    if (!c || c.current_year === undefined) return null;
    return {
      year: c.current_year,
      month: c.current_month,
      day: c.current_day,
      hour: c.current_hour ?? 0,
      minute: c.current_minute ?? 0,
    };
  }

  // --- Chronicle → Foundry ---

  /**
   * Record the date Chronicle advanced to. TODO(#95): apply it to the
   * built-in calendar and confirm it back with confirmAppliedDate.
   * @param {object} data - { year, month, day, hour, minute }
   * @private
   */
  _onChronicleDateAdvanced(data) {
    if (!data || !this._chronicleCalendar) return;
    const c = this._chronicleCalendar;
    c.current_year = data.year;
    c.current_month = data.month;
    c.current_day = data.day;
    if (data.hour !== undefined) c.current_hour = data.hour;
    if (data.minute !== undefined) c.current_minute = data.minute;
  }

  /**
   * Chronicle event created / updated / deleted. TODO(#95): mirror these into
   * the built-in calendar; until it exists there is nothing to write to.
   * @param {object} data - the Chronicle event (`{ id }` for a delete).
   * @private
   */
  _onChronicleEventCreated(data) {}
  /** @private */
  _onChronicleEventUpdated(data) {}
  /** @private */
  _onChronicleEventDeleted(data) {}

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
   * merged `WeatherInput` from `SetWeather`. The dashboard panel updates, and
   * a GM chat line follows when enabled.
   *
   * @param {object|null} payload
   * @private
   */
  async _onChronicleWeatherChanged(payload) {
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

    if (this._shouldAnnounce('calendar.weather.changed')) {
      this._announceToGM(this._subresourceState.weatherLine);
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
   * auto-creates a same-day note for celestial events: the
   * payload carries no celestial detail and no stable event id, so a
   * re-broadcast could create duplicate, undeduplicable notes.
   *
   * @param {string} type
   * @param {object|null} payload
   * @private
   */
  async _onChronicleSubresourceChanged(type, payload) {
    this._subresourceState = reduceSubresourceState(this._subresourceState, type, payload);
    if (!this._shouldAnnounce(type)) return;
    this._announceToGM(formatSubresourceLine(type, payload));
  }

  /**
   * Handle `calendar.structure.updated` and its granular siblings
   * (`calendar.cycle.changed`, `calendar.festival.changed`): refetch
   * `GET /calendar` so the cached structure is current.
   *
   * @param {string} [type] - the signal type, for the log line.
   * @private
   */
  async _onChronicleStructureUpdated(type = 'calendar.structure.updated') {
    try {
      const cal = await this._api.get('/calendar');
      if (cal) this._chronicleCalendar = cal;
    } catch (err) {
      console.debug(`Chronicle: ${type} received; could not refetch /calendar`, err?.message);
    }
  }

  // --- Foundry → Chronicle ---

  /**
   * Push a date to Chronicle (PUT /calendar/date), behind the date-push
   * guards: GM only, the rebuild blackout, a refused-push pause, and the
   * real-time-calendar signal. Refusals pause the push with one notice
   * rather than one error per tick. TODO(#95): call this from the built-in
   * calendar's date-change hook.
   * @param {{year:number, month:number, day:number, hour?:number, minute?:number}} date - 1-indexed month/day.
   */
  async pushDate(date) {
    if (!date) return;
    if (!getSetting('syncCalendar')) return;
    if (!game.user.isGM) return;

    // Check before the pre-push probe so a known blackout costs zero requests.
    if (calendarBlackoutActive() || datePushPaused()) return;

    try {
      if (await shouldSkipDatePush(this._api)) return;
      await this._api.put('/calendar/date', {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: date.hour || 0,
        minute: date.minute || 0,
      });
      noteCalendarAnswerOk();
    } catch (err) {
      // 400/403/422 refusals pause date push with one notice, not one error per tick.
      if (handleDatePushRefusal(err)) return;
      if (isRealTimeRejection(err)) { notifyRealTimePushPaused(); return; }
      // A 503 calendar_rebuilding arms the session guard and notifies once.
      if (handleIfCalendarRebuilding(err)) return;
      console.error('Chronicle: Failed to push date to Chronicle', err);
    }
  }

  /**
   * Fetch Chronicle's calendar events for the current year ±`yearSpan`,
   * month by month (GET /calendar/events is month-filtered), deduped by id.
   * Bounded, never unbounded history. TODO(#95): feed these to the built-in
   * calendar on connect.
   * @param {number} [yearSpan=1]
   * @returns {Promise<object[]>}
   */
  async fetchEvents(yearSpan = 1) {
    const coords = calendarEventFetchCoordinates(this._chronicleCalendar, yearSpan);
    // No cached structure to enumerate (e.g. /calendar returned no months) →
    // fall back to the single default (current-month) fetch rather than nothing.
    const fetches = coords.length ? coords : [null];

    const seen = new Set();
    const events = [];
    for (const coord of fetches) {
      const path = coord
        ? `/calendar/events?year=${coord.year}&month=${coord.month}`
        : '/calendar/events';
      let payload;
      try {
        payload = await this._api.get(path);
      } catch (err) {
        console.debug('Chronicle: calendar events fetch failed for', path, err.message);
        continue;
      }
      // GET /calendar/events returns an envelope { data:[...], total } —
      // accept that AND a bare array, kept local so get()'s contract for
      // other callers is unchanged.
      const page = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.data) ? payload.data : null);
      if (!page) continue;
      for (const event of page) {
        // A recurring event can surface in several month windows but maps to
        // ONE Chronicle event id.
        if (!event || event.id == null || seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    return events;
  }
}
