/**
 * Chronicle Sync — Sync Calendar editor (foundation + event CRUD)
 *
 * GM-only ApplicationV2 that renders a 3-pane view of the active Calendaria
 * calendar with an always-on validation panel. PR 1 shipped the read-only
 * shell; PR 2 (this file's current revision) adds:
 *
 *   - Year ↔ month view toggle (year overview + day-grid month view).
 *   - Day inspector becomes writable: create / edit / delete notes via
 *     `CALENDARIA.api.createNote / updateNote / deleteNote`.
 *   - Drag-select in month view → multi-day "Add event" form.
 *   - Note form (name, content, categories, icon, color, visibility,
 *     displayStyle, allDay, start+end date+time) with structural
 *     validation. Pure form ↔ API translation lives in
 *     `scripts/sync-calendar-note-form.mjs` and is unit-tested.
 *
 * Architecture (per scoping § 3.1):
 *   - Writes go through `CALENDARIA.api`. Never reach into Calendaria's
 *     internal settings.
 *   - Reads via `CALENDARIA.api.get*`, wrapped in try/catch with a graceful
 *     degraded-mode render when Calendaria is missing or broken.
 *   - Writes flow to Chronicle automatically via the existing
 *     `scripts/calendar-sync.mjs` hook handlers — no editor-side Chronicle
 *     plumbing required.
 *
 * PRs 3-5 still defer: moon strip, recurrence builder, weather, structure
 * editing, inline category creation. The Application class stays a thin
 * integration shell — pure validation + form translation live in
 * separately-unit-tested modules.
 *
 * Naming: per scoping § 7, the UI label is "Sync Calendar" — Calendaria
 * already has a "Chronicle" widget. Don't reuse that name.
 */

import { MODULE_ID, FLAG_SCOPE } from './constants.mjs';
import { runValidation, SCHEMA_VERSION } from './sync-calendar-validation.mjs';
import {
  defaultFormForDate,
  formFromNote,
  noteOptionsFromForm,
  validateForm,
  VISIBILITY,
  DISPLAY_STYLE,
} from './sync-calendar-note-form.mjs';

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
      // Navigation
      'select-month':      SyncCalendarApplication.#onSelectMonth,
      'select-year':       SyncCalendarApplication.#onSelectYear,
      'jump-today':        SyncCalendarApplication.#onJumpToday,
      'goto-month':        SyncCalendarApplication.#onGotoMonth,
      'back-to-year':      SyncCalendarApplication.#onBackToYear,
      'select-day':        SyncCalendarApplication.#onSelectDay,
      // Event CRUD
      'add-event':         SyncCalendarApplication.#onAddEvent,
      'edit-event':        SyncCalendarApplication.#onEditEvent,
      'save-event':        SyncCalendarApplication.#onSaveEvent,
      'delete-event':      SyncCalendarApplication.#onDeleteEvent,
      'cancel-form':       SyncCalendarApplication.#onCancelForm,
      // Misc
      'focus-target':      SyncCalendarApplication.#onFocusTarget,
    },
  };

  static PARTS = {
    body: {
      template: 'modules/chronicle-sync/templates/sync-calendar.hbs',
    },
  };

  constructor(options = {}) {
    super(options);
    /** Selected date — 1-indexed shape `{year, month, day}`. */
    this._selectedDate = null;
    /** 'year' or 'month'. PR 2 toggles between year overview + month day-grid. */
    this._viewMode = 'year';
    /** 'none' | 'add' | 'edit' — controls right-pane form rendering. */
    this._formMode = 'none';
    /** Form values, set when entering 'add' or 'edit' mode. */
    this._formData = null;
    /** When editing, the Calendaria note's page id we'll PUT against. */
    this._formNoteId = null;
    /** Validation messages from the last save attempt; cleared on field edit. */
    this._formErrors = [];
    /** True while a save / delete is in flight — prevents double-submit. */
    this._formBusy = false;

    /** Drag-select state — engaged in month view via pointer events. */
    this._dragStartDay = null;
    this._dragEndDay   = null;
    this._dragActive   = false;

    this._calendariaVersion = '';
    this._activeCalendarId = '';
    this._hooksRegistered = false;
    this._hookHandlers = {};
    this._renderPending = false;
  }

  /**
   * Render entry point. Builds the view-model that `sync-calendar.hbs`
   * consumes. Defensive: every `CALENDARIA.api.*` call lives in a try/catch
   * with a degraded-mode fallback.
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
    try { cal = api.getActiveCalendar() || null; }
    catch (err) { console.warn('Sync Calendar | getActiveCalendar failed', err); }
    try { currentDateTime = api.getCurrentDateTime?.() || null; }
    catch (err) { console.warn('Sync Calendar | getCurrentDateTime failed', err); }

    if (!cal) {
      return {
        degraded: true,
        degradedReason: 'CHRONICLE.SyncCalendar.Degraded.NoActiveCalendar',
        calendariaVersion: this._calendariaVersion,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    this._activeCalendarId = cal?.metadata?.id || cal?.id || '';

    if (!this._selectedDate) {
      this._selectedDate = this.#defaultSelectedDate(cal, currentDateTime);
    } else {
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

    const yearOverview = months.map((m, idx) => {
      const monthIndex0 = monthIndexFromMonth(m, idx);
      const monthOrdinal1 = monthOrdinalFromMonth(m, monthIndex0);
      let noteCount = 0;
      try {
        const notes = api.getNotesForMonth?.(this._selectedDate.year, monthOrdinal1, { includeContent: false });
        if (Array.isArray(notes)) noteCount = notes.length;
      } catch {}
      const festivalsThisMonth = festivals.filter((f) => {
        const fm = Number(f?.month ?? -1);
        return fm === monthIndex0 || fm === monthOrdinal1;
      });
      return {
        id:           m?.id || `month-${monthIndex0}`,
        name:         m?.name || 'Month',
        abbreviation: m?.abbreviation || '',
        days:         Number(m?.days ?? 0),
        leapDays:     Number(m?.leapDays ?? 0),
        ordinal:      monthOrdinal1,
        index0:       monthIndex0,
        noteCount,
        festivalCount: festivalsThisMonth.length,
        isSelected:   monthOrdinal1 === this._selectedDate.month,
      };
    });

    // Month view — per-day cell with note count + drag-select handles.
    const monthDetail = (this._viewMode === 'month')
      ? this.#buildMonthDetail(api, yearOverview, festivals)
      : null;

    const dayDetail = this.#buildDayDetail(api, cal, moons, seasons);

    const findingsView = findings.map((f) => ({
      severity:      f.severity,
      severityClass: `severity-${f.severity}`,
      code:          f.code,
      message:       f.message,
      fixHint:       f.fix_hint || '',
      focusTarget:   f.focus_target || '',
    }));

    // Form view-model — only populated when form is open.
    let formView = null;
    if (this._formMode !== 'none' && this._formData) {
      formView = {
        mode:                this._formMode,
        noteId:              this._formNoteId || '',
        data:                this._formData,
        errors:              this._formErrors.slice(),
        busy:                this._formBusy,
        hasEndDate:          this._formData.endDay != null && this._formData.endMonth != null && this._formData.endYear != null,
        visibilityOptions:   VISIBILITY_OPTIONS,
        displayStyleOptions: DISPLAY_STYLE_OPTIONS,
        categoriesText:      Array.isArray(this._formData.categories) ? this._formData.categories.join(', ') : '',
      };
    }

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

      viewMode: this._viewMode,
      yearOverview,
      monthDetail,
      dayDetail,
      formView,

      structureCounts: {
        months:       months.length,
        weekdays:     weekdays.length,
        seasons:      seasons.length,
        moons:        moons.length,
        eras:         eras.length,
        festivals:    festivals.length,
        cycles:       cycles.length,
        weatherZones: weatherZones.length,
      },

      findings: findingsView,
      findingCountsBySeverity,
      findingTotal: findings.length,

      // PR 2: writes are enabled for events. PR 5 enables structure-edit.
      writesEnabled: true,
    };
  }

  /**
   * Per-day cells for the selected month. Used by the month-view template
   * to render the day grid where the operator clicks / drag-selects.
   *
   * @private
   */
  #buildMonthDetail(api, yearOverview, festivals) {
    const month = yearOverview.find((m) => m.ordinal === this._selectedDate.month);
    if (!month) return null;
    const daysInMonth = Math.max(1, Number(month.days) || 28);
    const monthIndex0 = month.index0;

    // Fetch all notes for the month once; bucket per day.
    let monthNotes = [];
    try {
      const notes = api.getNotesForMonth?.(this._selectedDate.year, month.ordinal, { includeContent: false });
      if (Array.isArray(notes)) monthNotes = notes;
    } catch (err) {
      console.warn('Sync Calendar | getNotesForMonth failed', err);
    }
    const notesByDay = new Map();
    for (const n of monthNotes) {
      const day = Number(
        n?.startDate?.day ??
        n?.flagData?.startDate?.day ??
        n?.flagData?.startDate?.dayOfMonth,
      );
      if (Number.isFinite(day) && day >= 1) {
        if (!notesByDay.has(day)) notesByDay.set(day, []);
        notesByDay.get(day).push({
          id:    n?.id || '',
          name:  n?.name || 'Untitled',
          color: n?.color || n?.flagData?.color || '',
          icon:  n?.icon  || n?.flagData?.icon  || '',
        });
      }
    }

    const festivalDays = new Set(
      festivals
        .filter((f) => {
          const fm = Number(f?.month ?? -1);
          return fm === monthIndex0 || fm === month.ordinal;
        })
        .map((f) => Number(f?.dayOfMonth ?? f?.day ?? -1))
        .filter((d) => Number.isFinite(d) && d >= 0)
        // Festivals use 0-indexed dayOfMonth in some exports; bump to 1-indexed.
        .map((d) => d + 1),
    );

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const cellNotes = notesByDay.get(d) || [];
      days.push({
        day:          d,
        ordinal:      month.ordinal,
        year:         this._selectedDate.year,
        isSelected:   d === this._selectedDate.day,
        isFestival:   festivalDays.has(d),
        noteCount:    cellNotes.length,
        notesPreview: cellNotes.slice(0, 3),
      });
    }
    return {
      monthOrdinal: month.ordinal,
      monthName:    month.name,
      monthAbbr:    month.abbreviation,
      year:         this._selectedDate.year,
      daysInMonth,
      days,
    };
  }

  /**
   * Build the "selected day" inspector data: notes, moon phases, season,
   * weather. Each API call individually guarded.
   *
   * @private
   */
  #buildDayDetail(api, cal, moons, _seasons) {
    const date = this._selectedDate;
    const detail = {
      year:        date.year,
      month:       date.month,
      day:         date.day,
      monthName:   '',
      weekdayName: '',
      notes:       [],
      moonPhases:  [],
      season:      null,
      weather:     null,
    };

    const months = readArrayLike(cal.monthsArray, cal.months?.values);
    const monthEntry = months[date.month - 1] || null;
    detail.monthName = monthEntry?.name || '';

    try {
      const notes = api.getNotesForDate?.(date.year, date.month, date.day, { includeContent: false });
      if (Array.isArray(notes)) {
        detail.notes = notes.map((n) => ({
          id:         n?.id || '',
          name:       n?.name || 'Untitled',
          icon:       n?.icon || n?.flagData?.icon || '',
          color:      n?.color || n?.flagData?.color || '',
          visibility: n?.visibility || n?.flagData?.visibility || '',
        }));
      }
    } catch (err) { console.warn('Sync Calendar | getNotesForDate failed', err); }

    try {
      const phases = api.getAllMoonPhases?.() || [];
      detail.moonPhases = (Array.isArray(phases) ? phases : []).map((p, idx) => ({
        moonName:  p?.moonName || moons[idx]?.name || `Moon ${idx + 1}`,
        phaseName: p?.phaseName || p?.name || '',
        position:  Number(p?.position ?? p?.phasePosition ?? 0),
        color:     moons[idx]?.color || '',
      }));
    } catch (err) { console.warn('Sync Calendar | getAllMoonPhases failed', err); }

    try {
      const s = api.getCurrentSeason?.() || null;
      if (s) detail.season = { name: s.name || '', color: s.color || '', icon: s.icon || '' };
    } catch (err) { console.warn('Sync Calendar | getCurrentSeason failed', err); }

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
    } catch { /* weather often unconfigured */ }

    return detail;
  }

  #defaultSelectedDate(cal, currentDateTime) {
    if (currentDateTime && typeof currentDateTime === 'object') {
      return {
        year:  Number(currentDateTime.year  ?? cal?.years?.yearZero ?? 0),
        month: Number(currentDateTime.month ?? 1),
        day:   Number(currentDateTime.dayOfMonth ?? currentDateTime.day ?? 1),
      };
    }
    return { year: Number(cal?.years?.yearZero ?? 0), month: 1, day: 1 };
  }

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

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#registerHooksOnce();
    this.#wireFormInputs();
    this.#wireDragSelect();
    try {
      game.user?.setFlag?.(FLAG_SCOPE, 'syncCalendarLastSeen', {
        schemaVersion: SCHEMA_VERSION,
        calendarId: this._activeCalendarId,
        calendariaVersion: this._calendariaVersion,
        seenAt: new Date().toISOString(),
      });
    } catch { /* user-flag is best-effort */ }
  }

  /**
   * Attach `input` / `change` listeners to form fields. Updates
   * `this._formData` on each keystroke so the operator's input persists
   * across re-renders (e.g. a `dateTimeChange` hook firing mid-edit).
   *
   * @private
   */
  #wireFormInputs() {
    const root = this.element;
    if (!root) return;
    const inputs = root.querySelectorAll?.('[data-form-field]') || [];
    inputs.forEach((el) => {
      const field = el.dataset.formField;
      if (!field) return;
      const onInput = (evt) => this.#onFormFieldInput(field, evt?.target ?? el);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onInput);
    });
  }

  /**
   * Attach pointer events to month-view day cells for drag-select. Each
   * cell has a `data-day="N"` attribute; drag-select records the start
   * and end days and opens the multi-day add form on pointerup.
   *
   * @private
   */
  #wireDragSelect() {
    const root = this.element;
    if (!root) return;
    if (this._viewMode !== 'month') return;
    const cells = root.querySelectorAll?.('.day-cell') || [];

    const setHighlight = () => {
      const lo = Math.min(this._dragStartDay ?? 0, this._dragEndDay ?? 0);
      const hi = Math.max(this._dragStartDay ?? 0, this._dragEndDay ?? 0);
      cells.forEach((c) => {
        const d = Number(c.dataset?.day ?? -1);
        c.classList.toggle('drag-range', d >= lo && d <= hi && this._dragActive);
      });
    };

    cells.forEach((cell) => {
      cell.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        const d = Number(cell.dataset?.day);
        if (!Number.isFinite(d)) return;
        this._dragActive = true;
        this._dragStartDay = d;
        this._dragEndDay = d;
        setHighlight();
      });
      cell.addEventListener('pointerenter', () => {
        if (!this._dragActive) return;
        const d = Number(cell.dataset?.day);
        if (Number.isFinite(d)) {
          this._dragEndDay = d;
          setHighlight();
        }
      });
    });

    // Window-level pointerup so a drag that releases outside the cells
    // still closes cleanly.
    const onUp = () => {
      if (!this._dragActive) return;
      this._dragActive = false;
      const lo = Math.min(this._dragStartDay ?? 0, this._dragEndDay ?? 0);
      const hi = Math.max(this._dragStartDay ?? 0, this._dragEndDay ?? 0);
      cells.forEach((c) => c.classList.remove('drag-range'));
      window.removeEventListener('pointerup', onUp);
      // Single click vs drag-select range:
      this.#openAddEventForRange(lo, hi);
    };
    window.addEventListener('pointerup', onUp);
  }

  #onFormFieldInput(field, target) {
    if (!this._formData) return;
    let value;
    if (target.type === 'checkbox') {
      value = !!target.checked;
    } else if (target.type === 'number') {
      value = target.value === '' ? null : Number(target.value);
    } else {
      value = target.value ?? '';
    }
    if (field === 'categories' && typeof value === 'string') {
      value = value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    this._formData = { ...this._formData, [field]: value };
    if (this._formErrors.length > 0) this._formErrors = [];
  }

  #registerHooksOnce() {
    if (this._hooksRegistered) return;
    const rerender = () => this.#scheduleRerender();
    const subs = {
      'calendaria.calendarSwitched':       rerender,
      'calendaria.remoteCalendarSwitch':   rerender,
      'calendaria.calendarUpdated':        rerender,
      'calendaria.dateTimeChange':         rerender,
      'calendaria.dayChange':              rerender,
      'calendaria.monthChange':            rerender,
      'calendaria.yearChange':             rerender,
      'calendaria.seasonChange':           rerender,
      'calendaria.moonPhaseChange':        rerender,
      'calendaria.restDayChange':          rerender,
      'calendaria.remoteDateChange':       rerender,
      'calendaria.noteCreated':            rerender,
      'calendaria.noteUpdated':            rerender,
      'calendaria.noteDeleted':            rerender,
      'calendaria.weatherChange':          rerender,
    };
    for (const [name, fn] of Object.entries(subs)) {
      try { Hooks.on(name, fn); this._hookHandlers[name] = fn; }
      catch (err) { console.warn(`Sync Calendar | failed to register hook ${name}`, err); }
    }
    this._hooksRegistered = true;
  }

  #unregisterHooks() {
    for (const [name, fn] of Object.entries(this._hookHandlers)) {
      try { Hooks.off(name, fn); } catch { /* best-effort */ }
    }
    this._hookHandlers = {};
    this._hooksRegistered = false;
  }

  #scheduleRerender() {
    if (this._renderPending) return;
    this._renderPending = true;
    setTimeout(() => {
      this._renderPending = false;
      if (this.rendered) this.render(false);
    }, RENDER_THROTTLE_MS);
  }

  /** @override */
  async close(options) {
    this.#unregisterHooks();
    return super.close(options);
  }

  // -------------------------------------------------------------------
  // Form lifecycle helpers
  // -------------------------------------------------------------------

  #enterAddMode(anchor) {
    this._formMode = 'add';
    this._formNoteId = null;
    this._formData = defaultFormForDate(anchor);
    this._formErrors = [];
    this._formBusy = false;
  }

  #enterEditMode(noteId) {
    const api = globalThis.CALENDARIA?.api;
    let note = null;
    try { note = api?.getNote?.(noteId) || null; }
    catch (err) { console.warn('Sync Calendar | getNote failed', err); }
    if (!note) {
      ui.notifications.warn(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.NotFound'));
      return false;
    }
    this._formMode = 'edit';
    this._formNoteId = noteId;
    this._formData = formFromNote(note);
    this._formErrors = [];
    this._formBusy = false;
    return true;
  }

  #exitForm() {
    this._formMode = 'none';
    this._formNoteId = null;
    this._formData = null;
    this._formErrors = [];
    this._formBusy = false;
  }

  #openAddEventForRange(lo, hi) {
    const month = this._selectedDate.month;
    const year  = this._selectedDate.year;
    const anchor = lo === hi
      ? { year, month, day: lo }
      : { year, month, day: lo, endYear: year, endMonth: month, endDay: hi };
    this._selectedDate = { year, month, day: lo };
    this.#enterAddMode(anchor);
    this.render(false);
  }

  // -------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------

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

  static async #onGotoMonth(_event, target) {
    const month = Number(target?.dataset?.month ?? this._selectedDate?.month ?? 1);
    this._selectedDate = { ...this._selectedDate, month, day: 1 };
    this._viewMode = 'month';
    this.render(false);
  }

  static async #onBackToYear(_event, _target) {
    this._viewMode = 'year';
    this.render(false);
  }

  static async #onSelectDay(_event, target) {
    const day = Number(target?.dataset?.day);
    if (!Number.isFinite(day)) return;
    this._selectedDate = { ...this._selectedDate, day };
    this.render(false);
  }

  /**
   * Open the form to add a new event on the selected day. Triggered by
   * the "Add event" button in the day inspector. Drag-select uses a
   * different path (`#wireDragSelect → #openAddEventForRange`).
   */
  static async #onAddEvent(_event, _target) {
    this.#enterAddMode(this._selectedDate);
    this.render(false);
  }

  static async #onEditEvent(_event, target) {
    const noteId = target?.dataset?.noteId;
    if (!noteId) return;
    if (this.#enterEditMode(noteId)) this.render(false);
  }

  static async #onCancelForm(_event, _target) {
    this.#exitForm();
    this.render(false);
  }

  /**
   * Validate and save. Calls `CALENDARIA.api.createNote` or `updateNote`
   * depending on the form mode. Defensive: API errors surface as inline
   * `ui.notifications.error` + keep form open with errors visible.
   */
  static async #onSaveEvent(_event, _target) {
    if (this._formBusy) return;
    if (!this._formData) return;
    const errors = validateForm(this._formData);
    if (errors.length > 0) {
      this._formErrors = errors;
      this.render(false);
      return;
    }
    const api = globalThis.CALENDARIA?.api;
    if (!api) {
      this._formErrors = ['CHRONICLE.SyncCalendar.NoteForm.Errors.ApiUnavailable'];
      this.render(false);
      return;
    }

    let options;
    try { options = noteOptionsFromForm(this._formData); }
    catch (err) {
      this._formErrors = ['CHRONICLE.SyncCalendar.NoteForm.Errors.OptionsBuild'];
      console.warn('Sync Calendar | noteOptionsFromForm threw', err);
      this.render(false);
      return;
    }

    this._formBusy = true;
    this.render(false);

    try {
      if (this._formMode === 'edit') {
        if (typeof api.updateNote !== 'function') {
          throw new Error('CALENDARIA.api.updateNote not available');
        }
        await api.updateNote(this._formNoteId, options);
        ui.notifications.info(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.Updated'));
      } else {
        if (typeof api.createNote !== 'function') {
          throw new Error('CALENDARIA.api.createNote not available');
        }
        await api.createNote(options);
        ui.notifications.info(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.Created'));
      }
      this.#exitForm();
    } catch (err) {
      console.error('Sync Calendar | save failed', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.SaveFailed'));
      this._formErrors = ['CHRONICLE.SyncCalendar.NoteForm.Errors.SaveFailed'];
    } finally {
      this._formBusy = false;
      this.render(false);
    }
  }

  /**
   * Delete an existing event. Confirmation prompt before the API call.
   * Triggered from the day inspector list (data-action="delete-event"
   * + data-note-id).
   */
  static async #onDeleteEvent(_event, target) {
    const noteId = target?.dataset?.noteId;
    if (!noteId) return;
    const api = globalThis.CALENDARIA?.api;
    if (!api?.deleteNote) {
      ui.notifications.error(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.Errors.ApiUnavailable'));
      return;
    }
    const confirmed = await Dialog?.confirm?.({
      title:   game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.DeleteConfirmTitle'),
      content: `<p>${game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.DeleteConfirmBody')}</p>`,
    });
    if (!confirmed) return;
    try {
      await api.deleteNote(noteId);
      ui.notifications.info(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.Deleted'));
      if (this._formNoteId === noteId) this.#exitForm();
      this.render(false);
    } catch (err) {
      console.error('Sync Calendar | delete failed', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.SyncCalendar.NoteForm.DeleteFailed'));
    }
  }

  static async #onFocusTarget(_event, target) {
    const focus = target?.dataset?.focus || '';
    if (!focus) return;
    if (game?.user?.isGM === false) return;
    // Read-only structure focus (PR 5 will wire real navigation).
  }
}

/**
 * Pre-built option lists for the form's `<select>` elements. Templates
 * iterate these to render `<option>` elements with localized labels.
 */
const VISIBILITY_OPTIONS = [
  { value: VISIBILITY.VISIBLE, labelKey: 'CHRONICLE.SyncCalendar.NoteForm.Visibility.Visible' },
  { value: VISIBILITY.HIDDEN,  labelKey: 'CHRONICLE.SyncCalendar.NoteForm.Visibility.Hidden' },
  { value: VISIBILITY.SECRET,  labelKey: 'CHRONICLE.SyncCalendar.NoteForm.Visibility.Secret' },
];

const DISPLAY_STYLE_OPTIONS = [
  { value: DISPLAY_STYLE.ICON,   labelKey: 'CHRONICLE.SyncCalendar.NoteForm.DisplayStyle.Icon' },
  { value: DISPLAY_STYLE.PIP,    labelKey: 'CHRONICLE.SyncCalendar.NoteForm.DisplayStyle.Pip' },
  { value: DISPLAY_STYLE.BANNER, labelKey: 'CHRONICLE.SyncCalendar.NoteForm.DisplayStyle.Banner' },
];

/**
 * Helpers — coerce Calendaria's variably-shaped containers into arrays.
 */
function readArrayLike(...sources) {
  for (const src of sources) {
    if (Array.isArray(src)) return src;
    if (src && typeof src === 'object') return Object.values(src);
  }
  return [];
}

function monthIndexFromMonth(month, arrayIndex) {
  const ord = Number(month?.ordinal ?? 0);
  if (Number.isFinite(ord) && ord > 0) return ord - 1;
  return Number(arrayIndex ?? 0);
}

function monthOrdinalFromMonth(month, fallbackIndex0) {
  const ord = Number(month?.ordinal ?? 0);
  if (Number.isFinite(ord) && ord > 0) return ord;
  return Number(fallbackIndex0 ?? 0) + 1;
}

/**
 * Convenience: open the application as a singleton.
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

export function getSyncCalendarInstance() {
  return _instance && _instance.rendered ? _instance : null;
}
