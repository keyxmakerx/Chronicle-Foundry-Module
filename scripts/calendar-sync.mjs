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

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

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
   * Update the local Foundry calendar date from Chronicle.
   * @param {object} data - { year, month, day, hour, minute }
   * @private
   */
  async _onChronicaleDateAdvanced(data) {
    if (!data) return;
    await this._setLocalDate(data);
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

    try {
      await this._api.put('/calendar/date', {
        year: data.year,
        month: data.month,
        day: data.dayOfMonth ?? data.day,
        hour: data.hour ?? 0,
        minute: data.minute ?? 0,
      });
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
    return {
      name: noteData.name || noteData.title || 'Untitled Note',
      year: startDate.year,
      month: startDate.month,
      day: startDate.day ?? startDate.dayOfMonth ?? 1,
      description: noteData.content || noteData.description || flagData.content || '',
      visibility: noteData.gmOnly ? 'gm_only' : 'everyone',
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
            gmOnly: data.visibility === 'gm_only',
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
