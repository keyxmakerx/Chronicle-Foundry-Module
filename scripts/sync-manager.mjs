/**
 * Chronicle Sync - Sync Manager
 *
 * Orchestrates sync state across all sync modules (journals, maps, calendar).
 * Manages the API client lifecycle, initial sync on connect, and coordinates
 * conflict resolution.
 */

import { ChronicleAPI } from './api-client.mjs';
import { getSetting, setSetting, isConfigured, getSyncDirections, getExcludedTags, getUserMappings, setUserMappings } from './settings.mjs';

/**
 * How long the connection must stay continuously connected after a reconnect
 * before we re-pull (FM-SYNC-HARDENING §2). Debouncing collapses a flapping
 * connection's repeated reconnect events into a single re-pull once the link
 * has settled, preventing a re-pull storm.
 * @type {number}
 */
const RECONNECT_RESYNC_DEBOUNCE_MS = 3000;

/**
 * SyncManager coordinates all Chronicle sync operations.
 * It owns the API client and delegates to feature-specific sync modules.
 */
export class SyncManager {
  constructor() {
    /** @type {ChronicleAPI} */
    this.api = new ChronicleAPI();

    /** @type {Array<object>} Registered sync modules. */
    this._modules = [];

    /** @type {boolean} Whether initial sync has completed. */
    this._initialSyncDone = false;

    /** @type {boolean} Whether we've seen a disconnect since the last (re)sync. */
    this._sawDisconnect = false;

    /** @type {ReturnType<typeof setTimeout>|null} Debounce timer for reconnect re-pull. */
    this._reconnectResyncTimer = null;

    /** @type {Array<{time: number, type: string, message: string}>} Recent activity log. */
    this._activityLog = [];

    /** @type {number} Maximum activity log entries. */
    this._maxLogEntries = 100;

    /** @type {string|null} Matched Chronicle system ID, or null if no match. */
    this._matchedSystem = null;

    /** @type {string|null} Foundry's game.system.id. */
    this._foundrySystemId = null;

    /** @type {Array<object>|null} Cached Chronicle campaign members. */
    this._members = null;

    /** @type {boolean} Whether the player-character-claiming addon is enabled for this campaign. */
    this._pcClaimingEnabled = false;
  }

  /**
   * Register a sync module (e.g., JournalSync, MapSync).
   * Modules must implement: init(api), onMessage(msg), destroy().
   * If the module declares a `_syncManager` field, a back-reference is bound
   * so the module can reach SyncManager-level helpers (e.g., user mappings).
   * @param {object} module
   */
  registerModule(module) {
    if (Object.prototype.hasOwnProperty.call(module, '_syncManager')) {
      module._syncManager = this;
    }
    this._modules.push(module);
  }

  /**
   * Start the sync manager. Connects to Chronicle and performs initial sync.
   * Only runs for GMs when the module is configured.
   */
  async start() {
    if (!game.user.isGM) {
      console.debug('Chronicle: Non-GM user, skipping sync');
      return;
    }

    if (!isConfigured()) {
      console.warn('Chronicle: Module not configured. Set URL, API key, and campaign ID in settings.');
      ui.notifications.warn('Chronicle Sync is not configured. Go to Module Settings to set up.');
      return;
    }

    if (!getSetting('syncEnabled')) {
      console.debug('Chronicle: Sync disabled in settings');
      return;
    }

    // Detect game system and match against Chronicle systems.
    await this._detectSystem();

    // Detect enabled addons (player-character-claiming, etc.) so modules can
    // read isPcClaimingEnabled() during their init() call below.
    await this._fetchAddons();

    // Initialize all registered modules.
    for (const mod of this._modules) {
      if (typeof mod.init === 'function') {
        try {
          await mod.init(this.api);
        } catch (err) {
          console.error(`Chronicle: Module ${mod.constructor.name} failed to initialize`, err);
        }
      }
    }

    // Listen for all WebSocket messages and route to modules.
    this.api.on('*', (msg) => this._routeMessage(msg));

    // Listen for connection state changes (must be registered BEFORE connect).
    this.api.on('sync.status', async (msg) => {
      if (msg.payload?.status === 'connected' && !this._initialSyncDone) {
        await this._performInitialSync();
        this._initialSyncDone = true;
      }
    });

    // Re-pull on reconnect (FM-SYNC-HARDENING §2). Driven off the connection
    // state machine — a deterministic signal independent of the server's
    // sync.status message shape. The first connect is handled by the
    // sync.status listener above; this only fires for genuine reconnects
    // after a drop, so changes made on Chronicle during the disconnect
    // window aren't lost until a world reload.
    this.api.onStateChange((state) => this._onConnectionStateChange(state));

    // Connect WebSocket.
    this.api.connect();

    console.debug('Chronicle: Sync manager started');
  }

  /**
   * React to WebSocket connection-state transitions for the reconnect
   * re-pull (FM-SYNC-HARDENING §2).
   *
   * - Any drop ('disconnected' / 'reconnecting') arms `_sawDisconnect`.
   * - A return to 'connected' after a drop, once the initial sync has already
   *   happened, schedules a debounced re-pull to catch Chronicle edits made
   *   during the disconnect window.
   *
   * The first connect (before initial sync completes) is intentionally
   * ignored here — `_performInitialSync` handles it via the sync.status
   * listener — so we never double-sync on startup.
   *
   * @param {string} state - New connection state.
   * @private
   */
  _onConnectionStateChange(state) {
    if (state === 'disconnected' || state === 'reconnecting') {
      this._sawDisconnect = true;
      return;
    }
    if (state === 'connected' && this._initialSyncDone && this._sawDisconnect) {
      this._scheduleReconnectResync();
    }
  }

  /**
   * Debounce a reconnect re-pull. Each reconnect 'connected' event resets the
   * timer, so a flapping connection only triggers one re-pull after it has
   * been stable for `RECONNECT_RESYNC_DEBOUNCE_MS`.
   * @private
   */
  _scheduleReconnectResync() {
    if (this._reconnectResyncTimer) clearTimeout(this._reconnectResyncTimer);
    this._reconnectResyncTimer = setTimeout(() => {
      this._reconnectResyncTimer = null;
      this._resyncAfterReconnect();
    }, RECONNECT_RESYNC_DEBOUNCE_MS);
  }

  /**
   * Re-pull after a reconnect. Resets the disconnect flag and re-runs the
   * initial-sync pull. That pull is a delta (`/sync/pull?since=lastSyncTime`),
   * so it's cheap even on large worlds — only mappings changed during the
   * disconnect are fetched. We call `_performInitialSync` directly rather than
   * toggling `_initialSyncDone`, so we don't race the sync.status first-sync
   * listener.
   * @private
   */
  async _resyncAfterReconnect() {
    this._sawDisconnect = false;
    try {
      await this._performInitialSync();
      this.logActivity('connect', 'Reconnected — re-pulled changes made during the disconnect');
    } catch (err) {
      console.warn('Chronicle: Reconnect re-pull failed', err);
    }
  }

  /**
   * Fetch campaign members from Chronicle and auto-match to Foundry users.
   * Stores mappings in the `userMappings` setting.
   */
  async fetchAndCacheMembers() {
    try {
      const result = await this.api.get('/members');
      const members = result?.data || result || [];
      this._members = Array.isArray(members) ? members : [];

      // Auto-match by display_name → Foundry user name.
      const mappings = getUserMappings();
      let newMappings = 0;
      for (const member of this._members) {
        if (mappings[member.user_id]) continue; // Already mapped.
        const foundryUser = game.users.find(
          (u) => u.name.toLowerCase() === (member.display_name || '').toLowerCase()
        );
        if (foundryUser) {
          mappings[member.user_id] = foundryUser.id;
          newMappings++;
        }
      }
      if (newMappings > 0) {
        await setUserMappings(mappings);
        this.logActivity('connect', `Auto-matched ${newMappings} Chronicle members to Foundry users`);
      }

      console.debug(`Chronicle: Fetched ${this._members.length} campaign members`);
    } catch (err) {
      console.warn('Chronicle: Failed to fetch campaign members', err);
      this._members = [];
    }
  }

  /**
   * Get cached campaign members.
   * @returns {Array<object>}
   */
  getMembers() {
    return this._members || [];
  }

  /**
   * Get the Foundry user ID mapped to a Chronicle user ID.
   * @param {string} chronicleUserId
   * @returns {string|null}
   */
  getFoundryUserId(chronicleUserId) {
    const mappings = getUserMappings();
    return mappings[chronicleUserId] || null;
  }

  /**
   * Get the Chronicle user ID mapped to a Foundry user ID.
   * @param {string} foundryUserId
   * @returns {string|null}
   */
  getChronicleUserId(foundryUserId) {
    const mappings = getUserMappings();
    for (const [cId, fId] of Object.entries(mappings)) {
      if (fId === foundryUserId) return cId;
    }
    return null;
  }

  /**
   * Stop the sync manager and disconnect.
   */
  stop() {
    this.api.disconnect();
    for (const mod of this._modules) {
      if (typeof mod.destroy === 'function') {
        mod.destroy();
      }
    }
    this._modules = [];
    this._initialSyncDone = false;
    this._sawDisconnect = false;
    if (this._reconnectResyncTimer) {
      clearTimeout(this._reconnectResyncTimer);
      this._reconnectResyncTimer = null;
    }
    console.debug('Chronicle: Sync manager stopped');
  }

  /**
   * Returns the matched Chronicle system ID, or null if no match.
   * @returns {string|null}
   */
  getMatchedSystem() {
    return this._matchedSystem;
  }

  /**
   * Returns Foundry's game.system.id.
   * @returns {string|null}
   */
  getFoundrySystemId() {
    return this._foundrySystemId;
  }

  /**
   * Whether the player-character-claiming addon is enabled for this campaign.
   * Populated by `_fetchAddons()` during `start()`, before any module `init()`.
   * @returns {boolean}
   */
  isPcClaimingEnabled() {
    return this._pcClaimingEnabled;
  }

  /**
   * Fetch the campaign's enabled addons and cache whether the
   * player-character-claiming addon is active.
   * Gracefully degrades when the addons endpoint is not yet deployed.
   * @private
   */
  async _fetchAddons() {
    try {
      const addons = await this.api.getAddons();
      const list = Array.isArray(addons) ? addons : (addons?.data ?? []);
      this._pcClaimingEnabled = list.some(
        (a) => a.slug === 'player-character-claiming' && a.enabled !== false
      );
      console.debug(`Chronicle: player-character-claiming addon ${this._pcClaimingEnabled ? 'enabled' : 'disabled'}`);
      if (this._pcClaimingEnabled) {
        this.logActivity('connect', 'Player Character Claiming addon detected');
      }
    } catch {
      // Addon endpoint not available — claiming feature stays off.
      this._pcClaimingEnabled = false;
    }
  }

  /**
   * Detect the Foundry game system and match it against Chronicle systems.
   * Queries the /systems API endpoint which returns foundry_system_id on each
   * system. Matching is fully API-driven so any installed system package
   * (including custom-uploaded ones) works automatically.
   * @private
   */
  async _detectSystem() {
    this._foundrySystemId = game.system?.id || null;

    if (!this._foundrySystemId) {
      console.debug('Chronicle: No Foundry game system detected');
      return;
    }

    try {
      // Query Chronicle for available systems. Each system includes
      // foundry_system_id from its manifest for automatic matching.
      const result = await this.api.get('/systems');
      const systems = result.data || [];

      // Log API response for debugging system matching issues.
      console.debug(`Chronicle: /systems API returned ${systems.length} system(s)`);
      for (const s of systems) {
        console.debug(`  - ${s.id} (foundry_id: ${s.foundry_system_id ?? 'MISSING'}, enabled: ${s.enabled})`);
      }
      console.debug(`Chronicle: Looking for foundry_system_id: "${this._foundrySystemId}"`);

      // Match by foundry_system_id returned from the API.
      const match = systems.find(
        (s) => s.foundry_system_id === this._foundrySystemId && s.enabled
      );

      if (match) {
        this._matchedSystem = match.id;
        await setSetting('detectedSystem', match.id);
        this.logActivity('connect', `Game system matched: ${match.name}`);
        console.debug(`Chronicle: System matched — Foundry "${this._foundrySystemId}" → Chronicle "${match.id}"`);
      } else {
        await setSetting('detectedSystem', '');
        // Provide diagnostic info about why matching failed.
        const byFoundryId = systems.find(s => s.foundry_system_id === this._foundrySystemId);
        if (byFoundryId && !byFoundryId.enabled) {
          console.warn(`Chronicle: System "${byFoundryId.id}" matches Foundry system "${this._foundrySystemId}" but is not enabled for this campaign`);
          this.logActivity('warning', `System "${byFoundryId.name}" found but not enabled for this campaign`);
        } else if (systems.length > 0) {
          const ids = systems.map(s => s.foundry_system_id || '(none)').join(', ');
          console.warn(`Chronicle: No system has foundry_system_id="${this._foundrySystemId}". Available: ${ids}`);
          this.logActivity('warning', `No Chronicle system matches Foundry system "${this._foundrySystemId}"`);
        } else {
          console.warn('Chronicle: No game systems installed in Chronicle');
          this.logActivity('warning', 'No game systems installed in Chronicle');
        }
      }
    } catch (err) {
      console.warn('Chronicle: Failed to detect system match', err);
      // Fall back to local setting if API call fails.
      const cached = getSetting('detectedSystem');
      if (cached) {
        this._matchedSystem = cached;
      }
    }
  }

  /**
   * Perform initial sync: pull all changes since last sync time.
   * @private
   */
  async _performInitialSync() {
    const lastSync = getSetting('lastSyncTime') || '1970-01-01T00:00:00Z';

    try {
      console.debug(`Chronicle: Initial sync from ${lastSync}`);
      ui.notifications.info('Chronicle: Syncing...', { permanent: false });

      // Fetch campaign members for user ID mapping.
      await this.fetchAndCacheMembers();

      // Pull sync mappings modified since last sync.
      const result = await this.api.get(`/sync/pull?since=${encodeURIComponent(lastSync)}`);

      if (result.mappings && result.mappings.length > 0) {
        console.debug(`Chronicle: Received ${result.mappings.length} mapping updates`);

        // Route each mapping to the appropriate module.
        for (const mapping of result.mappings) {
          for (const mod of this._modules) {
            if (typeof mod.onSyncMapping === 'function') {
              await mod.onSyncMapping(mapping);
            }
          }
        }
      }

      // Let each module perform its own initial sync (e.g., calendar structure).
      for (const mod of this._modules) {
        if (typeof mod.onInitialSync === 'function') {
          await mod.onInitialSync();
        }
      }

      // Post-pass: modules that need to coordinate with each other after
      // the first sync (e.g., journal-sync deletes character duplicates
      // once actor-sync has materialized its actors).
      for (const mod of this._modules) {
        if (typeof mod.onPostInitialSync === 'function') {
          try {
            await mod.onPostInitialSync();
          } catch (err) {
            console.warn(`Chronicle: ${mod.constructor.name}.onPostInitialSync failed`, err);
          }
        }
      }

      // Update last sync timestamp.
      await setSetting('lastSyncTime', result.server_time || new Date().toISOString());

      this.logActivity('connect', `Initial sync complete (${result.mappings?.length || 0} mappings)`);
      ui.notifications.info('Chronicle: Initial sync complete');
    } catch (err) {
      console.error('Chronicle: Initial sync failed', err);
      this.logActivity('error', `Initial sync failed: ${err.message || 'Unknown error'}`);
      ui.notifications.error('Chronicle: Initial sync failed. Check console for details.');
    }
  }

  /**
   * Route an incoming WebSocket message to all registered modules.
   * @param {object} msg
   * @private
   */
  _routeMessage(msg) {
    for (const mod of this._modules) {
      if (typeof mod.onMessage === 'function') {
        try {
          mod.onMessage(msg);
        } catch (err) {
          console.error(`Chronicle: Module message handler error`, err);
        }
      }
    }
  }

  /**
   * Add an entry to the activity log.
   * @param {string} type - Log type: 'pull', 'push', 'update', 'link', 'unlink', 'connect', 'error'.
   * @param {string} message - Human-readable description.
   */
  logActivity(type, message) {
    this._activityLog.unshift({
      time: Date.now(),
      type,
      message,
      timeFormatted: new Date().toLocaleTimeString(),
    });
    if (this._activityLog.length > this._maxLogEntries) {
      this._activityLog.length = this._maxLogEntries;
    }
  }

  /**
   * Get the activity log entries.
   * @returns {Array<{time: number, type: string, message: string, timeFormatted: string}>}
   */
  getActivityLog() {
    return this._activityLog;
  }

  /**
   * Clear the activity log.
   */
  clearActivityLog() {
    this._activityLog = [];
  }

  /**
   * Create or update a sync mapping on the server. Delegates to
   * `ensureMapping` so legacy callers (wizard `link-map`, dashboard
   * manual-sync) inherit conflict-tolerant idempotency.
   * @param {object} mapping
   * @returns {Promise<object>}
   */
  async createMapping(mapping) {
    return this.ensureMapping(mapping);
  }

  /**
   * Idempotent sync-mapping POST.
   *
   * 1. Look up an existing mapping for `(chronicle_type, chronicle_id)`.
   *    If one exists, return it — the happy path for already-synced
   *    docs (no Chronicle round-trip beyond the GET; no 400 noise).
   * 2. Otherwise POST `/sync/mappings`.
   * 3. If the POST returns a 400 with body containing "already exists",
   *    refetch via `findMapping` and return that — covers the race
   *    window between our GET and POST where a concurrent client
   *    created the mapping. The absorbed 400 is also stripped from the
   *    api-client error log so it does not pollute the FM-MAP-DIAG
   *    dashboard.
   * 4. Any other failure propagates.
   *
   * @param {object} payload - `{chronicle_type, chronicle_id, external_system, external_id, sync_direction, sync_metadata?}`
   * @returns {Promise<object|null>}
   */
  async ensureMapping(payload) {
    const ctype = payload?.chronicle_type;
    const cid = payload?.chronicle_id;

    if (ctype && cid) {
      const existing = await this.findMapping(ctype, cid);
      if (existing) return existing;
    }

    try {
      return await this.api.post('/sync/mappings', payload);
    } catch (err) {
      if (this._isMappingConflict(err)) {
        // Absorbed conflict — strip the 400 from the dashboard error log
        // and return the freshly-fetched mapping.
        this.api.dropLastErrorLogEntry?.({
          status: 400,
          path: '/sync/mappings',
          messageIncludes: 'already exists',
        });
        if (ctype && cid) return await this.findMapping(ctype, cid);
        return null;
      }
      throw err;
    }
  }

  /**
   * Detect Chronicle's specific 400 conflict for sync mappings. Chronicle
   * returns `{error: "Bad Request", message: "conflict: sync mapping already
   * exists for this object"}` with HTTP 400 (not 409, so api-client wraps
   * it in a generic Error). Match on substring rather than relying on the
   * status code alone so we don't suppress unrelated 400s.
   * @param {Error} err
   * @returns {boolean}
   * @private
   */
  _isMappingConflict(err) {
    const msg = err?.message || '';
    return /Chronicle API error 400/.test(msg) && /already exists/i.test(msg);
  }

  /**
   * Get the sync direction for a given sync type.
   * Returns "both", "pull", "push", or "off".
   * @param {string} syncType - One of: journals, maps, calendar, characters, shops.
   * @returns {string}
   */
  getSyncDirection(syncType) {
    const directions = getSyncDirections();
    return directions[syncType] || 'both';
  }

  /**
   * Check if a sync type allows pulling from Chronicle to Foundry.
   * @param {string} syncType
   * @returns {boolean}
   */
  canPull(syncType) {
    const dir = this.getSyncDirection(syncType);
    return dir === 'both' || dir === 'pull';
  }

  /**
   * Check if a sync type allows pushing from Foundry to Chronicle.
   * @param {string} syncType
   * @returns {boolean}
   */
  canPush(syncType) {
    const dir = this.getSyncDirection(syncType);
    return dir === 'both' || dir === 'push';
  }

  /**
   * Check if auto-sync on change is enabled.
   * @returns {boolean}
   */
  isAutoSync() {
    return getSetting('autoSync');
  }

  /**
   * Check if an entity should be excluded from sync based on tag or name rules.
   * @param {object} entity - Entity with name and tags array.
   * @returns {boolean} True if the entity should be excluded.
   */
  isExcludedByRules(entity) {
    // Tag-based exclusion.
    const excludedTags = getExcludedTags();
    if (excludedTags.length > 0 && entity.tags) {
      const entityTags = Array.isArray(entity.tags)
        ? entity.tags.map(t => (typeof t === 'string' ? t : t.name || '').toLowerCase())
        : [];
      const excluded = excludedTags.map(t => t.toLowerCase());
      if (entityTags.some(t => excluded.includes(t))) return true;
    }

    // Name pattern exclusion.
    const namePattern = getSetting('excludedNamePattern');
    if (namePattern && entity.name) {
      if (entity.name.toLowerCase().includes(namePattern.toLowerCase())) return true;
    }

    return false;
  }

  /**
   * Execute a single import plan item from the import wizard.
   * Delegates to the appropriate sync module method based on item type.
   * @param {{ type: string, data: object }} item - Import plan item.
   */
  async runWizardImport(item) {
    switch (item.type) {
      case 'create-tag': {
        await this.api.createTag(item.data);
        break;
      }
      case 'push-journal': {
        const journal = game.journal.get(item.data.journalId);
        if (!journal) throw new Error(`Journal ${item.data.journalId} not found`);
        const journalSync = this._modules.find((m) => m.constructor.name === 'JournalSync');
        if (!journalSync) throw new Error('JournalSync module not loaded');
        await journalSync._handleCreateJournal(journal, {}, game.user.id);
        break;
      }
      case 'push-actor': {
        const actor = game.actors.get(item.data.actorId);
        if (!actor) throw new Error(`Actor ${item.data.actorId} not found`);
        const actorSync = this._modules.find((m) => m.constructor.name === 'ActorSync');
        if (!actorSync) throw new Error('ActorSync module not loaded');
        await actorSync._handleCreateActor(actor, {}, game.user.id);
        break;
      }
      case 'link-map': {
        const scene = game.scenes.get(item.data.sceneId);
        if (!scene) throw new Error(`Scene ${item.data.sceneId} not found`);
        await scene.setFlag('chronicle-sync', 'mapId', item.data.mapId);
        await this.createMapping({
          chronicle_type: 'map',
          chronicle_id: item.data.mapId,
          external_system: 'foundry',
          external_id: item.data.sceneId,
          sync_direction: 'both',
          sync_metadata: { foundry_type: 'Scene' },
        });
        break;
      }
      case 'assign-tags': {
        await this.api.bulkAssignTags(item.data);
        break;
      }
      default:
        throw new Error(`Unknown import item type: ${item.type}`);
    }
  }

  /**
   * Look up a sync mapping by Chronicle identity.
   * @param {string} chronicleType
   * @param {string} chronicleId
   * @returns {Promise<object|null>}
   */
  async findMapping(chronicleType, chronicleId) {
    try {
      return await this.api.get(
        `/sync/lookup?chronicle_type=${encodeURIComponent(chronicleType)}&chronicle_id=${encodeURIComponent(chronicleId)}`
      );
    } catch {
      return null;
    }
  }

  /**
   * Look up a sync mapping by Foundry document ID.
   * @param {string} externalId - Foundry document ID.
   * @returns {Promise<object|null>}
   */
  async findMappingByExternal(externalId) {
    try {
      return await this.api.get(
        `/sync/lookup?external_system=foundry&external_id=${encodeURIComponent(externalId)}`
      );
    } catch {
      return null;
    }
  }
}
