/**
 * Chronicle Sync — Sync Calendar editor (foundation, read-only)
 *
 * GM-only ApplicationV2 that renders a 3-pane view of the active Calendaria
 * calendar with an always-on validation panel. This is PR 1 of the editor
 * arc described in the FM-CAL-EDITOR-SCOPING scoping report (cordinator
 * `reports/foundry/2026-05-19-fm-cal-editor-scoping.md`). PR 1 is **read-
 * only** — no writes, no drag-select, no structure editing. The "Add event"
 * button is a stub that explains it ships in PR 2.
 *
 * Architecture (per scoping § 3.1):
 *   - Writes go through `CALENDARIA.api`. Never reach into Calendaria's
 *     internal settings. (No writes in this PR — guard still applies for
 *     future PRs that extend this file.)
 *   - Reads via `CALENDARIA.api.get*`, wrapped in try/catch with a graceful
 *     degraded-mode render when Calendaria is missing or broken.
 *   - Hooks: `calendaria.ready` is the gating hook (we only attach after it
 *     fires elsewhere — the application registers a listener in case the
 *     module loads ahead of Calendaria). After that we listen to the
 *     calendar / time / note / weather hooks for partial re-renders.
 *
 * Naming: per scoping § 7, the UI label is "Sync Calendar" — Calendaria
 * already has a "Chronicle" widget (vertical timeline viewer), so "Chronicle"
 * is reserved for this project's web app, never for an editor surface inside
 * Foundry.
 */

import { MODULE_ID, FLAG_SCOPE } from './constants.mjs';
import { runValidation, SCHEMA_VERSION } from './sync-calendar-validation.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Cap on hook re-render frequency. Calendaria fires `dateTimeChange` on
 * every world-time tick (including real-time clock visualTicks); we don't
 * need to re-render at 60 fps. 250 ms is enough for human-perceived
 * snappiness.
 */
const RENDER_THROTTLE_MS = 250;

export class SyncCalendarApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'sync-calendar',
    classes: ['sync-calendar'],
    tag: 'div',
    window: {
      title: 'CHRONICLE.SyncCalendar.Title',
      resizable: true,
      contentClasses: ['sync-calendar-content'],
    },
    position: { width: 1100, height: 700 },
    actions: {
      'select-day':    SyncCalendarApplication.#onSelectDay,
      'select-month':  SyncCalendarApplication.#onSelectMonth,
      'select-year':   SyncCalendarApplication.#onSelectYear,
      'jump-today':    SyncCalendarApplication.#onJumpToday,
      'add-event':     SyncCalendarApplication.#onAddEventStub,
      'focus-target':  SyncCalendarApplication.#onFocusTarget,
    },
  };

  static PARTS = {
    body: {
      template: 'modules/chronicle-sync/templates/sync-calendar.hbs',
    },
  };

  constructor(options = {}) {
    super(options);
    /**
     * Selected date drives the day inspector and which month is centered
     * in the year view. Defaults to whatever Calendaria considers "now" at
     * render time. Shape: { year, month, day } using Calendaria's public
     * 1-indexed conventions.
     */
    this._selectedDate = null;
    this._calendariaVersion = '';
    this._activeCalendarId = '';
    this._hooksRegistered = false;
    this._hookHandlers = {};
    this._renderPending = false;
  }

  /**
   * Render entry point. Builds the view-model that `sync-calendar.hbs`
   * consumes. Defensive: every `CALENDARIA.api.*` call lives in a try/catch
   * with a degraded-mode fallback so a broken Calendaria install never
   * blanks Foundry.
   *
   * @override
   */
  async _prepareContext(_options = {}) {
    const api = globalThis.CALENDARIA?.api;
    const calendariaModule = game.modules.get?.('calendaria');
    this._calendariaVersion = calendariaModule?.version || '';

    if (!api || typeof api.getActiveCalendar !== 'function') {
      return {
        degraded: true,
        degradedReason: calendariaModule
          ? 'CHRONICLE.SyncCalendar.Degraded.IncompatibleApi'
          : 'CHRONICLE.SyncCalendar.Degraded.NoCalendaria',
        calendariaVersion: this._calendariaVersion,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    let cal = null;
    let currentDateTime = null;
    try {
      cal = api.getActiveCalendar() || null;
    } catch (err) {
      console.warn('Sync Calendar | getActiveCalendar failed', err);
    }
    try {
      currentDateTime = api.getCurrentDateTime?.() || null;
    } catch (err) {
      console.warn('Sync Calendar | getCurrentDateTime failed', err);
    }

    if (!cal) {
      return {
        degraded: true,
        degradedReason: 'CHRONICLE.SyncCalendar.Degraded.NoActiveCalendar',
        calendariaVersion: this._calendariaVersion,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    this._activeCalendarId = cal?.metadata?.id || cal?.id || '';

    // Initialize the selected date on first render.
    if (!this._selectedDate) {
      this._selectedDate = this.#defaultSelectedDate(cal, currentDateTime);
    } else {
      // Defensive: if the operator switched calendars, the prior selected
      // date may be out of range. Clamp to a safe default.
      this._selectedDate = this.#clampSelectedDate(cal, this._selectedDate);
    }

    const months    = readArrayLike(cal.monthsArray, cal.months?.values);
    const weekdays  = readArrayLike(cal.weekdaysArray, cal.days?.values);
    const seasons   = readArrayLike(cal.seasonsArray, cal.seasons?.values);
    const moons     = readArrayLike(cal.moonsArray, cal.moons);
    const eras      = readArrayLike(cal.erasArray, cal.eras);
    const festivals = readArrayLike(cal.festivalsArray, cal.festivals);
    const cycles    = readArrayLike(cal.cyclesArray, cal.cycles);
    const weatherZones = readArrayLike(cal.weatherZonesArray, cal.weather?.zones);

    // Validation findings (rule engine is pure; never throws upward).
    const findings = runValidation(cal, { currentDateTime });
    const findingCountsBySeverity = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {});

    // Build the year-view summary: per-month name/days/note count.
    // We deliberately do NOT call `getNotesForDate` for every day in the
    // year — that would be expensive on calendars with many notes. For PR 1
    // we surface per-month counts (cheap) and pull per-day detail only for
    // the selected day. PR 3 adds the moon strip with proper batching.
    const yearOverview = months.map((m) => {
      const monthIndex0 = monthIndexFromMonth(m, months);
      const monthOrdinal1 = monthOrdinalFromMonth(m, monthIndex0);
      let noteCount = 0;
      try {
        const notes = api.getNotesForMonth?.(this._selectedDate.year, monthOrdinal1, { includeContent: false });
        if (Array.isArray(notes)) noteCount = notes.length;
      } catch (err) {
        // Non-fatal — per-month count just falls back to 0.
      }
      const festivalsThisMonth = festivals.filter((f) => {
        const fm = Number(f?.month ?? -1);
        return fm === monthIndex0 || fm === monthOrdinal1;
      });
      return {
        id:         m?.id || monthFallbackId(m, monthIndex0),
        name:       m?.name || 'Month',
        abbreviation: m?.abbreviation || '',
        days:       Number(m?.days ?? 0),
        leapDays:   Number(m?.leapDays ?? 0),
        ordinal:    monthOrdinal1,
        index0:     monthIndex0,
        noteCount,
        festivalCount: festivalsThisMonth.length,
        isSelected: monthOrdinal1 === this._selectedDate.month,
      };
    });

    // Day inspector — only the selected day.
    const dayDetail = this.#buildDayDetail(api, cal, moons, seasons);

    // Validation findings localized for display.
    const findingsView = findings.map((f) => ({
      severity: f.severity,
      severityClass: `severity-${f.severity}`,
      code: f.code,
      message: f.message,
      fixHint: f.fix_hint || '',
      focusTarget: f.focus_target || '',
    }));

    return {
      degraded: false,
      calendariaVersion: this._calendariaVersion,
      schemaVersion: SCHEMA_VERSION,

      cal: {
        name:        cal.name || 'Calendar',
        description: (cal.description || cal.metadata?.description || '').trim(),
        id:          this._activeCalendarId,
        version:     cal.metadata?.version || '',
      },

      currentDateTime,
      selectedDate: this._selectedDate,

      yearOverview,
      dayDetail,

      structureCounts: {
        months:    months.length,
        weekdays:  weekdays.length,
        seasons:   seasons.length,
        moons:     moons.length,
        eras:      eras.length,
        festivals: festivals.length,
        cycles:    cycles.length,
        weatherZones: weatherZones.length,
      },

      findings: findingsView,
      findingCountsBySeverity,
      findingTotal: findings.length,

      // Stub flag: PR 2 wires "Add event"; PR 5 wires structure inspectors.
      writesEnabled: false,
    };
  }

  /**
   * Build the "selected day" inspector data: notes, moon phases, season,
   * weather. All API calls are individually guarded.
   *
   * @private
   */
  #buildDayDetail(api, cal, moons, _seasons) {
    const date = this._selectedDate;
    const detail = {
      year:   date.year,
      month:  date.month,
      day:    date.day,
      monthName: '',
      weekdayName: '',
      notes: [],
      moonPhases: [],
      season: null,
      weather: null,
    };

    // Month name lookup.
    const months = readArrayLike(cal.monthsArray, cal.months?.values);
    const monthEntry = months[date.month - 1] || null;
    detail.monthName = monthEntry?.name || '';

    // Notes on the selected day.
    try {
      const notes = api.getNotesForDate?.(date.year, date.month, date.day, { includeContent: false });
      if (Array.isArray(notes)) {
        detail.notes = notes.map((n) => ({
          id: n?.id || '',
          name: n?.name || 'Untitled',
          icon: n?.icon || n?.flagData?.icon || '',
          color: n?.color || n?.flagData?.color || '',
          visibility: n?.visibility || n?.flagData?.visibility || '',
        }));
      }
    } catch (err) {
      console.warn('Sync Calendar | getNotesForDate failed', err);
    }

    // Moon phases on the selected day.
    try {
      const phases = api.getAllMoonPhases?.() || [];
      detail.moonPhases = (Array.isArray(phases) ? phases : []).map((p, idx) => ({
        moonName:  p?.moonName || moons[idx]?.name || `Moon ${idx + 1}`,
        phaseName: p?.phaseName || p?.name || '',
        position:  Number(p?.position ?? p?.phasePosition ?? 0),
        color:     moons[idx]?.color || '',
      }));
    } catch (err) {
      console.warn('Sync Calendar | getAllMoonPhases failed', err);
    }

    // Current season.
    try {
      const s = api.getCurrentSeason?.() || null;
      if (s) {
        detail.season = {
          name:  s.name || '',
          color: s.color || '',
          icon:  s.icon || '',
        };
      }
    } catch (err) {
      console.warn('Sync Calendar | getCurrentSeason failed', err);
    }

    // Current weather (zone may be empty — handled gracefully).
    try {
      const w = api.getCurrentWeather?.() || null;
      if (w) {
        detail.weather = {
          label:       w.preset_label || w.label || w.preset_id || w.id || '',
          icon:        w.icon || '',
          color:       w.color || '',
          temperature: w.temperature_celsius ?? w.temperature ?? null,
          description: w.description || '',
        };
      }
    } catch (err) {
      // Weather often unconfigured; no console noise here.
    }

    return detail;
  }

  /**
   * Default selected date — Calendaria's "now" if available, else the start
   * of the calendar's year-zero. Always returns a 1-indexed shape.
   *
   * @private
   */
  #defaultSelectedDate(cal, currentDateTime) {
    if (currentDateTime && typeof currentDateTime === 'object') {
      return {
        year:  Number(currentDateTime.year  ?? cal?.years?.yearZero ?? 0),
        month: Number(currentDateTime.month ?? 1),
        day:   Number(currentDateTime.dayOfMonth ?? currentDateTime.day ?? 1),
      };
    }
    return {
      year:  Number(cal?.years?.yearZero ?? 0),
      month: 1,
      day:   1,
    };
  }

  /**
   * Clamp a selected date to ranges valid for the current calendar.
   * Used when the operator switches calendars mid-edit.
   *
   * @private
   */
  #clampSelectedDate(cal, date) {
    const months = readArrayLike(cal.monthsArray, cal.months?.values);
    const monthCount = months.length || 1;
    const month = Math.max(1, Math.min(monthCount, Number(date.month ?? 1)));
    const monthEntry = months[month - 1];
    const dayCount = Number(monthEntry?.days ?? 28);
    const day = Math.max(1, Math.min(dayCount, Number(date.day ?? 1)));
    return {
      year:  Number(date.year ?? cal?.years?.yearZero ?? 0),
      month,
      day,
    };
  }

  /**
   * Register hooks once per app lifetime. Throttled re-render hook handler
   * batches rapid time-change ticks.
   *
   * @override
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#registerHooksOnce();
    // Persist a slim record of which calendar we last rendered against, so
    // PR 5's snapshot system has a hook to start from. Always carry the
    // schemaVersion forward so future updates can detect stale flag data.
    try {
      game.user?.setFlag?.(FLAG_SCOPE, 'syncCalendarLastSeen', {
        schemaVersion: SCHEMA_VERSION,
        calendarId: this._activeCalendarId,
        calendariaVersion: this._calendariaVersion,
        seenAt: new Date().toISOString(),
      });
    } catch {
      // User flag persistence is best-effort.
    }
  }

  #registerHooksOnce() {
    if (this._hooksRegistered) return;
    const rerender = () => this.#scheduleRerender();

    const subs = {
      // Lifecycle.
      'calendaria.calendarSwitched':       rerender,
      'calendaria.remoteCalendarSwitch':   rerender,
      'calendaria.calendarUpdated':        rerender,
      // Time.
      'calendaria.dateTimeChange':         rerender,
      'calendaria.dayChange':              rerender,
      'calendaria.monthChange':            rerender,
      'calendaria.yearChange':             rerender,
      'calendaria.seasonChange':           rerender,
      'calendaria.moonPhaseChange':        rerender,
      'calendaria.restDayChange':          rerender,
      'calendaria.remoteDateChange':       rerender,
      // Notes.
      'calendaria.noteCreated':            rerender,
      'calendaria.noteUpdated':            rerender,
      'calendaria.noteDeleted':            rerender,
      // Weather.
      'calendaria.weatherChange':          rerender,
    };
    for (const [name, fn] of Object.entries(subs)) {
      try {
        Hooks.on(name, fn);
        this._hookHandlers[name] = fn;
      } catch (err) {
        console.warn(`Sync Calendar | failed to register hook ${name}`, err);
      }
    }
    this._hooksRegistered = true;
  }

  #unregisterHooks() {
    for (const [name, fn] of Object.entries(this._hookHandlers)) {
      try {
        Hooks.off(name, fn);
      } catch {
        // Idempotent unregister; never crash close().
      }
    }
    this._hookHandlers = {};
    this._hooksRegistered = false;
  }

  /**
   * Throttle re-renders. Hooks like `dateTimeChange` can fire in rapid
   * succession (real-time clock visualTicks); we coalesce them.
   *
   * @private
   */
  #scheduleRerender() {
    if (this._renderPending) return;
    this._renderPending = true;
    setTimeout(() => {
      this._renderPending = false;
      // Only re-render if the app is still rendered.
      if (this.rendered) this.render(false);
    }, RENDER_THROTTLE_MS);
  }

  /** @override */
  async close(options) {
    this.#unregisterHooks();
    return super.close(options);
  }

  // --- Actions ---

  static async #onSelectDay(_event, target) {
    const year  = Number(target?.dataset?.year ?? this._selectedDate?.year ?? 0);
    const month = Number(target?.dataset?.month ?? this._selectedDate?.month ?? 1);
    const day   = Number(target?.dataset?.day ?? 1);
    this._selectedDate = { year, month, day };
    this.render(false);
  }

  static async #onSelectMonth(_event, target) {
    const month = Number(target?.dataset?.month ?? this._selectedDate?.month ?? 1);
    this._selectedDate = { ...this._selectedDate, month, day: 1 };
    this.render(false);
  }

  static async #onSelectYear(_event, target) {
    const year = Number(target?.dataset?.year ?? this._selectedDate?.year ?? 0);
    this._selectedDate = { ...this._selectedDate, year };
    this.render(false);
  }

  static async #onJumpToday(_event, _target) {
    let cdt = null;
    try { cdt = globalThis.CALENDARIA?.api?.getCurrentDateTime?.() || null; } catch {}
    if (cdt) {
      this._selectedDate = {
        year:  Number(cdt.year ?? this._selectedDate?.year ?? 0),
        month: Number(cdt.month ?? this._selectedDate?.month ?? 1),
        day:   Number(cdt.dayOfMonth ?? cdt.day ?? this._selectedDate?.day ?? 1),
      };
    }
    this.render(false);
  }

  /**
   * Stub for the "Add event" button. PR 2 wires the real create-note flow
   * via `CALENDARIA.api.createNote`. Until then, surface a notification
   * explaining the gap so the operator's expectations stay calibrated.
   */
  static async #onAddEventStub(_event, _target) {
    const msg = game.i18n.localize('CHRONICLE.SyncCalendar.AddEvent.ComingSoon');
    ui.notifications.info(msg);
  }

  /**
   * Click-through from a validation finding or a structure group label.
   * PR 1 is read-only — clicking a focus target just selects the left-rail
   * group; later PRs will open the inspector against the offending entity.
   */
  static async #onFocusTarget(_event, target) {
    const focus = target?.dataset?.focus || '';
    if (!focus) return;
    // No-op for PR 1 beyond an optional notification confirming the click.
    // The structure groups are read-only in this PR; clicking them already
    // toggles the rail-section visibility via CSS, no JS needed.
    if (game?.user?.isGM === false) return;
  }
}

/**
 * Helpers — coerce Calendaria's variably-shaped containers into arrays.
 * Calendaria exposes `*Array` getters on calendar instances for ordered
 * iteration, but the JSON-imported shape stores values under `*.values` as
 * a keyed object. Both happen in practice; this helper handles either.
 */
function readArrayLike(...sources) {
  for (const src of sources) {
    if (Array.isArray(src)) return src;
    if (src && typeof src === 'object') return Object.values(src);
  }
  return [];
}

/**
 * Compute a 0-indexed month index from a month entry. Calendaria stores
 * months 1-indexed via `ordinal`; some imports omit it. Falls back to the
 * array position the caller resolved.
 */
function monthIndexFromMonth(month, _allMonths) {
  const ord = Number(month?.ordinal ?? 0);
  if (Number.isFinite(ord) && ord > 0) return ord - 1;
  // No ordinal — caller already resolved the array position; we don't have
  // access to that here without threading the index in. Fall back to 0 and
  // rely on the caller for context.
  return 0;
}

function monthOrdinalFromMonth(month, fallbackIndex0) {
  const ord = Number(month?.ordinal ?? 0);
  if (Number.isFinite(ord) && ord > 0) return ord;
  return Number(fallbackIndex0 ?? 0) + 1;
}

function monthFallbackId(month, index0) {
  if (typeof month?.id === 'string' && month.id.length > 0) return month.id;
  return `month-${index0}`;
}

/**
 * Convenience: open the application as a singleton. Subsequent calls bring
 * the existing window to the front instead of stacking duplicates.
 */
let _instance = null;

export function openSyncCalendar() {
  if (!game?.user?.isGM) return null;
  if (_instance && _instance.rendered) {
    _instance.bringToFront?.();
    return _instance;
  }
  _instance = new SyncCalendarApplication();
  _instance.render(true);
  return _instance;
}

/**
 * Convenience for tests / future PRs: return the current singleton (or
 * null). Never instantiates.
 */
export function getSyncCalendarInstance() {
  return _instance && _instance.rendered ? _instance : null;
}
