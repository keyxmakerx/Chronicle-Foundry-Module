/**
 * Chronicle Sync - Sync Dashboard
 *
 * The Chronicle Sync window: setup and health in one place. Four sections:
 * Overview, Linked (pages, characters, maps, shops and the calendar), Problems
 * (health, player reports, sync history) and Settings. Until a world is set
 * up, its first-run screen takes the window: connect, then the import wizard.
 *
 * Accessed via the sidebar status indicator or scene controls button (GM only).
 */

import { noticeText } from './_escape-html.mjs';
import {
  newSettingsState, settingsContext, wireSettingsForm, testConnection, refreshMembers,
} from './chronicle-settings.mjs';
import { ImportWizard } from './import-wizard.mjs';
import { getSetting, setSetting, getUserMappings } from './settings.mjs';
import { SyncHistoryTab } from './sync-history-tab.mjs';
import { FLAG_SCOPE, REPORT_STORE_FLAG } from './constants.mjs';
import { confirmDialog, promptDialog } from './_dialogs.mjs';
import { REMOVED_FOLDER_FLAG } from './_set-aside.mjs';
import { buildMemberRows, memberKey } from './_member-mapping.mjs';
import {
  captureActorSnapshot,
  buildCapabilityReport,
  renderCapabilityMarkdown,
  renderCapabilityJSON,
  CAP_STATUS,
} from './capability-inspector.mjs';
import { buildDiagnosticBundle } from './sync-diagnostic-bundle.mjs';
import { checkDiceFiles, diceSoNiceReport } from './dice-so-nice.mjs';
import { buildOverviewModel } from './_overview-model.mjs';
import { log, getLogBuffer } from './logger.mjs';
import { walkEntityPages } from './_entity-page-walk.mjs';
import { mapThumbSrc } from './_map-look.mjs';
import { _isAllowedImageHost } from './_url-validation.mjs';
import { projectSubresourcePanel } from './_calendar-subresources.mjs';
import { calendarStateFromError } from './_calendar-probe-state.mjs';
import {
  REPORTS_CHANGED_HOOK, collectModuleInfo, collectSyncLog, gatherSideBySide, getReports, markReportDone, submitReport,
} from './debug-hub.mjs';
import { resolveDashboardTab, SECTION_PANES } from './_dashboard-tabs.mjs';
import { MAX_TEXT, relativeAge, splitReports, unreadCount } from './_debug-reports.mjs';
import { reportToMarkdown } from './_debug-markdown.mjs';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * SyncDashboard is the main sync management UI.
 * Extends Foundry's ApplicationV2 with HandlebarsApplicationMixin for
 * template rendering and tab support.
 */
export class SyncDashboard extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {SyncDashboard|null} Singleton instance. */
  static _instance = null;

  /** Get or create the singleton dashboard instance. */
  static get instance() {
    if (!SyncDashboard._instance) {
      SyncDashboard._instance = new SyncDashboard();
    }
    return SyncDashboard._instance;
  }

  static DEFAULT_OPTIONS = {
    id: 'chronicle-sync-dashboard',
    classes: ['chronicle-dashboard'],
    window: {
      title: 'Chronicle Sync',
      icon: 'fa-solid fa-rotate',
      resizable: true,
    },
    position: {
      width: 620,
      height: 700,
    },
    actions: {
      refresh: SyncDashboard.#onRefresh,
      'pull-entity': SyncDashboard.#onPullEntityAction,
      'push-journal': SyncDashboard.#onPushJournalAction,
      'delete-journal': SyncDashboard.#onDeleteJournalAction,
      'delete-set-aside': SyncDashboard.#onDeleteSetAsideAction,
      'pull-all': SyncDashboard.#onPullAllAction,
      'push-all': SyncDashboard.#onPushAllAction,
      'toggle-visibility': SyncDashboard.#onToggleVisibilityAction,
      'open-map-journal': SyncDashboard.#onOpenMapJournalAction,
      'resync-all-maps': SyncDashboard.#onResyncAllMapsAction,
      'resync-all-journals': SyncDashboard.#onResyncAllJournalsAction,
      'resync-everything': SyncDashboard.#onResyncEverythingAction,
      'open-maps-folder': SyncDashboard.#onOpenMapsFolderAction,
      'dismiss-map-errors': SyncDashboard.#onDismissMapErrorsAction,
      reconnect: SyncDashboard.#onReconnectAction,
      'clear-log': SyncDashboard.#onClearLogAction,
      'open-settings': SyncDashboard.#onOpenSettingsAction,
      testConnection: SyncDashboard.#onTestConnectionAction,
      refreshMembers: SyncDashboard.#onRefreshMembersAction,
      startImport: SyncDashboard.#onStartImportAction,
      ...Object.fromEntries(ImportWizard.ACTION_NAMES.map((name) => [name, SyncDashboard.#onWizardAction])),
      'open-shop': SyncDashboard.#onOpenShopAction,
      'push-actor': SyncDashboard.#onPushActorAction,
      'push-all-actors': SyncDashboard.#onPushAllActorsAction,
      'copy-debug': SyncDashboard.#onCopyDebugAction,
      'copy-diagnostic-bundle': SyncDashboard.#onCopyDiagnosticBundleAction,
      'check-dice-files': SyncDashboard.#onCheckDiceFilesAction,
      'copy-capability': SyncDashboard.#onCopyCapabilityAction,
      'copy-capability-json': SyncDashboard.#onCopyCapabilityJsonAction,
      'bulk-set-public': SyncDashboard.#onBulkSetPublicAction,
      'bulk-set-private': SyncDashboard.#onBulkSetPrivateAction,
      'bulk-delete': SyncDashboard.#onBulkDeleteAction,
      'create-entity-type': SyncDashboard.#onCreateEntityTypeAction,
      'resolve-match': SyncDashboard.#onResolveMatchAction,
      'resolve-create': SyncDashboard.#onResolveCreateAction,
      'resolve-repush': SyncDashboard.#onResolveRepushAction,
      'debug-open-report': SyncDashboard.#onDebugOpenReportAction,
      'debug-done': SyncDashboard.#onDebugDoneAction,
      'debug-copy-issue': SyncDashboard.#onDebugCopyIssueAction,
      'debug-check': SyncDashboard.#onDebugCheckAction,
      'debug-report-row': SyncDashboard.#onDebugReportRowAction,
      'debug-report-send': SyncDashboard.#onDebugReportSendAction,
      'debug-report-cancel': SyncDashboard.#onDebugReportCancelAction,
    },
  };

  static PARTS = {
    dashboard: {
      template: 'modules/chronicle-sync/templates/sync-dashboard.hbs',
      templates: [
        'modules/chronicle-sync/templates/chronicle-settings.hbs',
        'modules/chronicle-sync/templates/import-wizard.hbs',
      ],
    },
  };

  constructor(options = {}) {
    super(options);

    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;

    /** @type {boolean} Whether data is currently loading. */
    this._loading = false;

    /** @type {object} Cached data for each tab. */
    this._cache = { entityTypes: null, entities: null, maps: null, calendar: null };

    /** @type {Set<number>} Collapsed entity type groups (persisted per-client). */
    try {
      const collapsed = JSON.parse(getSetting('dashboardCollapsedTypes'));
      this._collapsedTypes = new Set(collapsed);
    } catch { this._collapsedTypes = new Set(); }

    /** @type {string} Current search filter text. */
    this._searchFilter = '';

    /**
     * @type {string|null} Actor id the GM chose to inspect in Diagnostics' Health pane
     * Capability Inspector. Null = auto-pick (first linked, else first of type).
     * Per-session instance state (like _searchFilter): survives re-renders,
     * resets when the dashboard window is closed.
     */
    this._capabilityActorId = null;

    // The saved tab may be a name an older version used; it opens where that
    // content lives now. Defaults to the Overview, a calm summary.
    const saved = resolveDashboardTab(getSetting('dashboardActiveTab') || 'overview');
    /** @type {string} Currently active rail section (persisted per-client). */
    this._activeTab = saved.tab;
    /** @type {Record<string, string>} The open pane of each section that has panes. */
    this._panes = Object.fromEntries(Object.entries(SECTION_PANES).map(([tab, panes]) => [tab, panes[0]]));
    if (saved.pane) this._panes[saved.tab] = saved.pane;

    /** The Settings section's page types and unsaved edits, kept across re-renders. */
    this._settings = newSettingsState();

    /** @type {ImportWizard|null} The first-run screen's wizard while it is showing. */
    this._firstRun = null;

    /** The History pane's rows and filters, kept across re-renders. */
    this._historyTab = new SyncHistoryTab(() => this.api);

    /** @type {Set<string>} Currently selected entity IDs for bulk operations. */
    this._selectedEntities = new Set();

    // Player reports state (per window, like _capabilityActorId).
    /** @type {string|null} Actor id picked for the side by side. */
    this._debugActorId = null;
    /** @type {{loading: boolean, result: object|null, error: string}} */
    this._debugSbs = { loading: false, result: null, error: '' };
    /** @type {Set<string>} Reports whose snapshot is expanded. */
    this._debugOpen = new Set();
    /** @type {{open: boolean, text: string, message: string}} the GM's own report box */
    this._debugSelf = { open: false, text: '', message: '' };
    this._onReportsChanged = () => { if (this.rendered) this.render({ force: true }); };
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    Hooks.on(REPORTS_CHANGED_HOOK, this._onReportsChanged);
    if (context.configured && getSetting('firstRunPending')) this.startFirstRun();
  }

  /** @override */
  _onClose(options) {
    Hooks.off(REPORTS_CHANGED_HOOK, this._onReportsChanged);
    super._onClose?.(options);
  }

  /**
   * Bind the sync manager to the dashboard.
   * @param {import('./sync-manager.mjs').SyncManager} syncManager
   */
  bind(syncManager) {
    this._syncManager = syncManager;
  }

  /** @returns {import('./api-client.mjs').ChronicleAPI|null} */
  get api() {
    return this._syncManager?.api ?? null;
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  /**
   * Normalize an API response to an array.
   * Chronicle endpoints may return a plain array or an object wrapping
   * the array under common keys like `data`, `entity_types`, `entities`,
   * `maps`, etc.  This helper unwraps whichever shape we get.
   * @param {*} raw - The raw parsed JSON from the API.
   * @param {...string} keys - Object keys to try (in order) if raw is not an array.
   * @returns {Array}
   * @private
   */
  _normalizeArray(raw, ...keys) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      for (const key of keys) {
        if (Array.isArray(raw[key])) return raw[key];
      }
      // Last resort: try the generic `data` wrapper.
      if (Array.isArray(raw.data)) return raw.data;
    }
    return [];
  }

  /**
   * Show the import wizard in place of the four sections.
   * @returns {Promise<void>}
   */
  async startFirstRun() {
    if (!this._syncManager || !this.api) return;
    if (!this._firstRun) this._firstRun = ImportWizard.hostedIn(this, this._syncManager);
    this.render({ force: true });
    await this._firstRun.start();
  }

  /** Back to the four sections; the setup only offers itself again from Settings. */
  leaveFirstRun() {
    this._firstRun = null;
    setSetting('firstRunPending', false).catch(() => {});
    this.render({ force: true });
  }

  /** @override */
  async _prepareContext(options = {}) {
    // Before a campaign is connected the window is the first-run screen's
    // first step, the connection settings.
    if (!this._syncManager || !this.api) {
      return { configured: false, settings: { ...(await settingsContext(this._settings)), firstRun: true } };
    }
    if (this._firstRun) {
      return { configured: true, firstRun: await this._firstRun._prepareContext() };
    }

    this._loading = true;
    const exclusions = this._getExclusions();
    const loadErrors = [];

    // Build entity tab data.
    let entityGroups = [];
    let foundryOnlyJournals = [];
    try {
      entityGroups = await this._buildEntityGroups(exclusions);
      foundryOnlyJournals = this._getFoundryOnlyJournals();
    } catch (err) {
      console.error('Chronicle Dashboard: Failed to load entities', err);
      loadErrors.push({ tab: 'entities', message: err.message || 'Failed to load entities' });
    }

    // Build map tab data.
    let mapData = { chronicleMaps: [], unlinkedScenes: [] };
    try {
      mapData = await this._buildMapData();
    } catch (err) {
      console.error('Chronicle Dashboard: Failed to load maps', err);
      loadErrors.push({ tab: 'maps', message: err.message || 'Failed to load maps' });
    }

    // Build shops tab data.
    let shopData = { shops: [] };
    try {
      shopData = await this._buildShopData();
    } catch (err) {
      console.error('Chronicle Dashboard: Failed to load shops', err);
      loadErrors.push({ tab: 'shops', message: err.message || 'Failed to load shops' });
    }

    // Build calendar tab data.
    let calendarData = { available: false };
    try {
      calendarData = await this._buildCalendarData();
    } catch (err) {
      console.error('Chronicle Dashboard: Failed to load calendar', err);
      loadErrors.push({ tab: 'calendar', message: err.message || 'Failed to load calendar' });
    }

    // Build status tab data.
    const statusData = this._buildStatusData();

    // Build sync-capability data (what CAN pull vs what DOES).
    let capabilityData = null;
    try {
      capabilityData = await this._buildCapabilityData();
    } catch (err) {
      log.error('Dashboard: Failed to build sync capability', err);
      loadErrors.push({ tab: 'problems', message: err.message || 'Failed to build sync capability' });
    }

    // Build characters tab data.
    const characterData = this._buildCharacterData();

    const debugData = this._buildDebugData();

    // Build sync-issues (resolver) tab data.
    let issuesData = { issues: [], hasIssues: false, count: 0, headline: '' };
    try {
      issuesData = await this._buildIssuesData();
    } catch (err) {
      console.error('Chronicle Dashboard: Failed to load sync issues', err);
      loadErrors.push({ tab: 'characters', message: err.message || 'Failed to load issues' });
    }

    // Build the Overview cockpit from the pieces already computed above — a
    // calm landing view that routes problems to the tab that fixes each one.
    const overview = buildOverviewModel({
      connectionState: statusData.connectionState,
      connectionLabel: statusData.connectionLabel,
      syncedEntities: statusData.syncedEntities,
      linkedScenes: statusData.linkedScenes,
      characters: characterData.characters,
      issuesCount: issuesData.count,
      unmatchedMembers: this._unmatchedMemberCount(),
      calendarRebuilding: !!calendarData.calendarRebuilding,
      errorCount: statusData.errorLog?.length ?? 0,
      matchedSystem: statusData.matchedSystem,
      lastSyncTime: statusData.lastSyncTime,
      t: (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k)),
    });

    this._loading = false;

    return {
      configured: true,
      loading: false,
      settings: await settingsContext(this._settings),
      searchFilter: this._searchFilter,
      activeTab: this._activeTab,
      // Named as the rail names them, so the GM can find what didn't load.
      loadErrors: loadErrors.map((e) => ({
        ...e,
        label: game.i18n.localize(`CHRONICLE.Dashboard.Rail.${e.tab.charAt(0).toUpperCase()}${e.tab.slice(1)}`),
      })),
      hasLoadErrors: loadErrors.length > 0,

      // Overview (landing cockpit) tab.
      overview,

      // Issues (resolver) tab.
      issues: issuesData,

      // Entities tab.
      entityGroups: entityGroups.map(g => ({
        ...g,
        entities: g.entities.map(e => ({
          ...e,
          isSelected: this._selectedEntities.has(e.id),
        })),
      })),
      entityTypes: entityGroups.map(g => ({ id: g.typeId, name: g.typeNamePlural })),
      foundryOnlyJournals,
      hasChronicleOnly: entityGroups.some(g => g.entities.some(e => e.status === 'chronicle-only')),
      hasFoundryOnly: foundryOnlyJournals.length > 0,
      setAsideCount: foundryOnlyJournals.filter((j) => j.setAside).length,
      bulkSelectionCount: this._selectedEntities.size,

      // Shops tab.
      ...shopData,

      // Maps tab.
      ...mapData,

      // Characters tab.
      ...characterData,

      // Calendar tab.
      calendar: calendarData,

      // Diagnostics, Health pane.
      ...statusData,

      // Sync Capability (status tab panel).
      capability: capabilityData,

      // Diagnostics, Health pane: Dice So Nice as this client sees it.
      dice: this._buildDiceData(),

      // Diagnostics, Player reports pane.
      debug: debugData,
    };
  }

  // ---------------------------------------------------------------------------
  // Entity data
  // ---------------------------------------------------------------------------

  /**
   * Build entity groups by type with sync status.
   * @param {object} exclusions
   * @returns {Promise<Array>}
   * @private
   */
  async _buildEntityGroups(exclusions) {
    // Fetch entity types from Chronicle.
    if (!this._cache.entityTypes) {
      const raw = await this.api.get('/entity-types');
      this._cache.entityTypes = this._normalizeArray(raw, 'entity_types');
    }
    const types = this._cache.entityTypes;

    // Fetch all entities, sharing the bounded walk with JournalSync.resyncAll
    // (scripts/_entity-page-walk.mjs) so this never silently truncates past
    // a fixed page count.
    if (!this._cache.entities) {
      const walked = await walkEntityPages(
        (page, perPage) => this.api.get(`/entities?per_page=${perPage}&page=${page}`),
        (result) => this._normalizeArray(result, 'entities'),
      );
      this._cache.entities = walked.entities;
      this._cache.entitiesTruncated = walked.truncated;
      if (walked.truncated) {
        console.warn(`Chronicle: dashboard entity list stopped at ${walked.entities.length}; the campaign has more.`);
      }
    }
    const chronicleEntities = this._cache.entities || [];

    // Index Foundry journals by entityId flag.
    const journalsByEntityId = new Map();
    for (const j of game.journal.contents) {
      const eid = j.getFlag(FLAG_SCOPE, 'entityId');
      if (eid) journalsByEntityId.set(eid, j);
    }
    // Characters sync as actors, not journals, so a linked actor counts too.
    const actorEntityIds = new Set();
    for (const a of game.actors?.contents ?? []) {
      const eid = a.getFlag(FLAG_SCOPE, 'entityId');
      if (eid) actorEntityIds.add(eid);
    }

    // Build groups.
    const groups = [];
    for (const type of types) {
      const typeEntities = chronicleEntities.filter(e => e.entity_type_id === type.id);
      const isTypeExcluded = exclusions.excludedTypes.includes(type.id);

      const entities = typeEntities.map(entity => {
        const journal = journalsByEntityId.get(entity.id);
        const isExcluded = exclusions.excludedEntities.includes(entity.id) || isTypeExcluded;

        let status = actorEntityIds.has(entity.id) ? 'actor' : 'chronicle-only';
        if (journal) {
          const lastSync = journal.getFlag(FLAG_SCOPE, 'lastSync');
          if (lastSync) {
            const syncTime = new Date(lastSync).getTime();
            const updateTime = new Date(entity.updated_at).getTime();
            if (Math.abs(updateTime - syncTime) < 5000) {
              status = 'synced';
            } else if (updateTime > syncTime) {
              status = 'modified';
            } else {
              status = 'synced';
            }
          } else {
            status = 'synced';
          }
        }

        return {
          id: entity.id,
          name: entity.name,
          typeName: type.name,
          status,
          isPrivate: entity.is_private ?? false,
          isExcluded,
          journalId: journal?.id ?? null,
          updatedAt: entity.updated_at,
        };
      });

      // Apply search filter.
      const filtered = this._searchFilter
        ? entities.filter(e => e.name.toLowerCase().includes(this._searchFilter.toLowerCase()))
        : entities;

      const syncedCount = filtered.filter(e => e.status === 'synced' || e.status === 'modified' || e.status === 'actor').length;
      const chronicleOnlyCount = filtered.filter(e => e.status === 'chronicle-only').length;

      groups.push({
        typeId: type.id,
        typeName: type.name,
        typeNamePlural: type.name_plural || type.name + 's',
        typeIcon: type.icon || 'fa-solid fa-file',
        typeColor: type.color || '#888',
        isCollapsed: this._collapsedTypes.has(type.id),
        isTypeExcluded,
        entities: filtered,
        syncedCount,
        chronicleOnlyCount,
        totalCount: filtered.length,
      });
    }

    // Only show groups that have entities (or chronicle-only).
    return groups.filter(g => g.totalCount > 0);
  }

  /**
   * Get Foundry journals that aren't linked to any Chronicle entity.
   * @returns {Array}
   * @private
   */
  /** Whether a journal sits in the "Chronicle: removed" folder or below it. @private */
  _isSetAside(journal) {
    for (let f = journal.folder; f; f = f.folder) {
      if (f.getFlag?.(FLAG_SCOPE, REMOVED_FOLDER_FLAG)) return true;
    }
    return false;
  }

  /**
   * Delete Foundry-only journals the GM picked, after asking. Foundry has no
   * bin, so the question names how many and that it can't be undone. Only
   * unlinked journals are ever passed here, so Chronicle is not touched.
   * @param {string[]} ids
   * @private
   */
  async _onDeleteJournals(ids) {
    const journals = ids.map((id) => game.journal.get(id))
      .filter((j) => j && !j.getFlag(FLAG_SCOPE, 'entityId'));
    if (!journals.length) return;
    const one = journals.length === 1;
    const ok = await confirmDialog({
      title: game.i18n.localize('CHRONICLE.Dashboard.Entities.DeleteTitle'),
      content: `<p>${one
        ? game.i18n.format('CHRONICLE.Dashboard.Entities.DeleteOne', { name: noticeText(journals[0].name) })
        : game.i18n.format('CHRONICLE.Dashboard.Entities.DeleteMany', { count: journals.length })}</p>`,
      defaultYes: false,
    });
    if (!ok) return;
    try {
      await JournalEntry.deleteDocuments(journals.map((j) => j.id));
      this._logActivity('update', `Deleted ${journals.length} Foundry-only journal${one ? '' : 's'}`);
    } catch (err) {
      console.error('Chronicle: deleting journals failed', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.Dashboard.Entities.DeleteFailed'));
    }
    this.render();
  }

  _getFoundryOnlyJournals() {
    const result = [];
    const filter = this._searchFilter?.toLowerCase() || '';

    for (const j of game.journal.contents) {
      if (j.getFlag(FLAG_SCOPE, 'entityId')) continue;
      if (j.getFlag(FLAG_SCOPE, REPORT_STORE_FLAG)) continue;

      if (filter && !j.name.toLowerCase().includes(filter)) continue;

      result.push({
        id: j.id,
        name: j.name,
        status: 'foundry-only',
        pageCount: j.pages?.size ?? 0,
        setAside: this._isSetAside(j),
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Map data
  // ---------------------------------------------------------------------------

  /**
   * Build map tab data. Chronicle maps materialize as JournalEntries with
   * image-type pages; the dashboard surfaces them as journal links and a
   * Chronicle deep-link, not as scene bindings.
   * @returns {Promise<object>}
   * @private
   */
  async _buildMapData() {
    if (!this._cache.maps) {
      const raw = await this.api.get('/maps').catch(() => []);
      this._cache.maps = this._normalizeArray(raw, 'maps');
    }
    const chronicles = this._cache.maps;

    const baseUrl = getSetting('apiUrl')?.replace(/\/+$/, '');
    const campId = getSetting('campaignId');

    // Index materialized JournalEntry pages by Chronicle map id.
    const pagesByMapId = new Map();
    for (const entry of game.journal.contents) {
      for (const page of entry.pages.contents) {
        const mapId = page.getFlag(FLAG_SCOPE, 'mapId');
        if (mapId) pagesByMapId.set(mapId, page);
      }
    }

    const chronicleMaps = chronicles.map((m) => {
      const page = pagesByMapId.get(m.id);
      const entry = page?.parent || null;
      const markerCount = (page?.getFlag(FLAG_SCOPE, 'chronicleMarkers') || []).length;
      const drawingCount = (page?.getFlag(FLAG_SCOPE, 'chronicleDrawings') || []).length;
      const tokenCount = (page?.getFlag(FLAG_SCOPE, 'chronicleTokens') || []).length;
      const chronicleUrl = (baseUrl && campId)
        ? `${baseUrl}/campaigns/${campId}/maps/${m.id}`
        : null;
      return {
        id: m.id,
        name: m.name,
        materialized: !!page,
        journalEntryId: entry?.id ?? null,
        journalEntryName: entry?.name ?? null,
        markerCount,
        drawingCount,
        tokenCount,
        chronicleUrl,
        // The page's own picture: for a shadowed map, the stored player copy.
        thumbSrc: mapThumbSrc(page?.src, (url) => _isAllowedImageHost(url, getSetting('apiUrl'))),
      };
    });

    // Pull MapSync diagnostics (errors, counts, lastSyncAt) for the panel.
    const mapSync = this._syncManager?._modules?.find(
      (mod) => mod.constructor?.name === 'MapSync'
    );
    const status = mapSync?.getSyncStatus?.() || null;
    const folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'isMapsFolder') === true
    );

    return {
      chronicleMaps,
      mapsFolderId: folder?.id ?? null,
      mapSyncStatus: status ? {
        materializedCount: status.materializedCount,
        errorCount: status.errorCount,
        openViewers: status.openViewers,
        lastSyncAt: status.lastSyncAt
          ? new Date(status.lastSyncAt).toISOString()
          : null,
        recentErrors: status.recentErrors.map((e) => ({
          kind: e.kind,
          mapId: e.mapId,
          message: e.message,
          status: e.status,
          timeFormatted: new Date(e.time).toLocaleTimeString(),
        })),
        hasErrors: status.errorCount > 0,
      } : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Shop data
  // ---------------------------------------------------------------------------

  /**
   * Build shops tab data: all shop-type entities from Chronicle with
   * inventory counts and sync status.
   * @returns {Promise<object>}
   * @private
   */
  async _buildShopData() {
    // Ensure entity types are cached.
    if (!this._cache.entityTypes) {
      const raw = await this.api.get('/entity-types');
      this._cache.entityTypes = this._normalizeArray(raw, 'entity_types');
    }
    const types = this._cache.entityTypes;

    // Find the shop entity type by slug or name.
    const shopType = types.find(t =>
      t.slug === 'shop' || t.name?.toLowerCase() === 'shop'
    );

    if (!shopType) {
      return { shops: [], shopTypeExists: false };
    }

    // Ensure entities are cached.
    if (!this._cache.entities) {
      // Trigger entity cache population via _buildEntityGroups path.
      await this._buildEntityGroups(this._getExclusions());
    }
    const allEntities = this._cache.entities || [];

    // Filter to shop entities.
    const shopEntities = allEntities.filter(e => e.entity_type_id === shopType.id);

    // Index Foundry journals by entityId flag.
    const journalsByEntityId = new Map();
    for (const j of game.journal.contents) {
      const eid = j.getFlag(FLAG_SCOPE, 'entityId');
      if (eid) journalsByEntityId.set(eid, j);
    }

    const shops = shopEntities.map(entity => {
      const journal = journalsByEntityId.get(entity.id);
      const fields = entity.fields_data || {};

      return {
        id: entity.id,
        name: entity.name,
        shopType: fields.shop_type || '',
        shopKeeper: fields.shop_keeper || '',
        synced: !!journal,
        journalId: journal?.id ?? null,
        isPrivate: entity.is_private ?? false,
      };
    });

    return {
      shops,
      shopTypeExists: true,
      shopTypeIcon: shopType.icon || 'fa-store',
      shopTypeColor: shopType.color || '#f97316',
    };
  }

  // ---------------------------------------------------------------------------
  // Calendar data
  // ---------------------------------------------------------------------------

  /**
   * Build calendar tab data.
   * @returns {Promise<object>}
   * @private
   */
  async _buildCalendarData() {
    const calendarEnabled = getSetting('syncCalendar');

    if (!calendarEnabled) {
      return { available: false, enabled: calendarEnabled };
    }

    let chronicle = null;
    let probeError = null;
    try {
      chronicle = await this.api.get('/calendar');
    } catch (err) {
      probeError = err;
    }

    // Classify the failure instead of assuming it means "no calendar
    // configured" — a 401, a proxy timeout and the calendar-rebuild 503
    // must not all collapse into that one sentence.
    if (probeError) {
      const state = calendarStateFromError(probeError);
      if (state === 'rebuilding') {
        // Keep the expected failure out of the shared 50-entry error ring: the
        // dashboard re-probes on every render, and this is a known, benign
        // condition — exactly what SyncManager already does for benign 404s.
        this.api.dropLastErrorLogEntry?.({ path: '/calendar', status: 503 });
        return {
          available: false,
          enabled: calendarEnabled,
          calendarRebuilding: true,
          rebuildingDetail: typeof probeError?.serverMessage === 'string' && probeError.serverMessage
            ? probeError.serverMessage
            : 'Chronicle’s calendar is being rebuilt and is temporarily unavailable.',
        };
      }
      if (state !== 'absent') {
        return {
          available: false,
          enabled: calendarEnabled,
          calendarUnreachable: true,
          unreachableState: state,
        };
      }
    }

    if (!chronicle) {
      // Reached only when the probe SUCCEEDED and returned nothing, or failed
      // with a genuine 404 — i.e. this campaign really has no calendar.
      return { available: false, enabled: calendarEnabled, noCampaignCalendar: true };
    }

    // Chronicle world-state panel (weather / season / era / moons) — the
    // display surface for the sub-resource broadcasts CalendarSync folds
    // into `_subresourceState`. Read-only projection.
    const calSync = this._getCalendarSyncModule();
    const worldState = projectSubresourcePanel(calSync?._subresourceState ?? null);

    return {
      available: true,
      enabled: calendarEnabled,
      chronicleDate: {
        year: chronicle.current_year,
        month: chronicle.current_month,
        day: chronicle.current_day,
        hour: chronicle.current_hour ?? 0,
        minute: chronicle.current_minute ?? 0,
        calendarName: chronicle.name || 'Campaign Calendar',
      },
      worldState,
    };
  }

  /**
   * Resolve the live CalendarSync module instance from the SyncManager (for its
   * world-state snapshot). Mirrors the class-name lookup used elsewhere in the
   * dashboard. Returns null when unavailable.
   * @returns {object|null}
   * @private
   */
  _getCalendarSyncModule() {
    return this._syncManager?._modules?.find((m) => m?.constructor?.name === 'CalendarSync') ?? null;
  }

  // ---------------------------------------------------------------------------
  // Character data
  // ---------------------------------------------------------------------------

  /**
   * Build characters tab data from ActorSync module.
   * @returns {object}
   * @private
   */
  _buildCharacterData() {
    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync'
    );
    const characters = actorSync?.getSyncedActors?.() ?? [];
    const hasUnlinkedCharacters = characters.some((c) => !c.synced);

    // Surface a one-time dashboard hint when the addon is off but the GM has
    // player-owned PC actors — claims exist in Foundry but won't sync.
    const pcClaimingEnabled = this._syncManager?.isPcClaimingEnabled?.() ?? false;
    const pcClaimingHint = !pcClaimingEnabled && (actorSync?.hasPlayerOwnedPcs?.() ?? false);

    return { characters, hasUnlinkedCharacters, pcClaimingHint };
  }

  /** @returns {object|null} the live ActorSync module, if active. @private */
  _actorSync() {
    return this._syncManager?._modules?.find((m) => m.constructor?.name === 'ActorSync') || null;
  }

  /**
   * Build the Issues (resolver) tab: character actors that can't be matched to
   * Chronicle (unlinked, or linked to a now-missing entity). Each row carries a
   * name-matched suggestion preselected + the full candidate list. Async — it
   * reaches Chronicle to verify links and list candidates.
   * @returns {Promise<object>}
   * @private
   */
  async _buildIssuesData() {
    const actorSync = this._actorSync();
    if (!actorSync?.getSyncIssues) return { issues: [], hasIssues: false, count: 0, headline: '' };
    const { issues, candidates } = await actorSync.getSyncIssues();
    const decorated = issues.map((iss) => ({
      actorId: iss.actorId,
      name: iss.name,
      img: iss.img,
      label: iss.kind === 'broken' ? 'Failed to find existing character' : 'Not linked to Chronicle',
      options: candidates.map((c) => ({ id: c.id, name: c.name, selected: c.id === iss.suggestionId })),
    }));
    const count = decorated.length;
    return {
      issues: decorated,
      hasIssues: count > 0,
      count,
      headline: `${count} character${count === 1 ? '' : 's'} couldn't be matched to Chronicle — match each to an existing character, or create a new one.`,
    };
  }

  /**
   * Chronicle members not linked to a Foundry player. Their per-player
   * permissions are dropped, so the Overview flags them; the links
   * themselves are set under Settings, Players.
   * @returns {number}
   * @private
   */
  _unmatchedMemberCount() {
    const members = this._syncManager?.getMembers?.() ?? [];
    const foundryUsers = (game.users?.contents ?? []).map((u) => ({ id: u.id, name: u.name }));
    return buildMemberRows({ members, mappings: getUserMappings(), foundryUsers, keyOf: memberKey }).unmatchedCount;
  }

  // ---------------------------------------------------------------------------
  // Status data
  // ---------------------------------------------------------------------------

  /**
   * Build status tab data.
   * @returns {object}
   * @private
   */
  _buildStatusData() {
    const state = this.api?.state ?? 'disconnected';
    const activityLog = this._syncManager?.getActivityLog() ?? [];

    // Compute stats from Foundry documents.
    const syncedEntities = game.journal.contents.filter(
      j => j.getFlag(FLAG_SCOPE, 'entityId')
    ).length;

    // Count Chronicle maps materialized as JournalEntry pages.
    let linkedScenes = 0;
    for (const entry of game.journal.contents) {
      for (const page of entry.pages.contents) {
        if (page.getFlag(FLAG_SCOPE, 'mapId')) linkedScenes++;
      }
    }

    // System detection info.
    const foundrySystem = this._syncManager?.getFoundrySystemId() || null;
    const matchedSystem = this._syncManager?.getMatchedSystem() || null;
    const syncCharacters = getSetting('syncCharacters');

    // Health metrics.
    const health = this.api?.health ?? {};
    const errorLog = this.api?.getErrorLog() ?? [];
    const retryQueueSize = this.api?.getRetryQueueSize() ?? 0;
    const uptimePercent = this.api?.getUptimePercent() ?? 0;

    // Field mapping info for debug view.
    const fieldMappingInfo = this._buildFieldMappingInfo(matchedSystem);

    return {
      connectionState: state,
      connectionLabel: this._connectionLabel(state),
      lastSyncTime: getSetting('lastSyncTime') || 'Never',
      syncedEntities,
      linkedScenes,
      foundrySystem,
      matchedSystem,
      systemMatched: !!matchedSystem,
      syncCharacters,
      characterSyncAvailable: !!matchedSystem,
      // DM-only entities synced (they reached the GM) but were intentionally
      // hidden from players — not "didn't sync".
      dmOnlyHiddenCount: this._syncManager?.getDmOnlyHiddenCount?.() ?? 0,
      dmOnlyHidden: getSetting('dmOnlyHidden'),
      activityLog: activityLog.slice(0, 50),

      // Diagnostics.
      healthMetrics: {
        restSuccessCount: health.restSuccessCount ?? 0,
        restErrorCount: health.restErrorCount ?? 0,
        reconnectAttempts: health.reconnectAttempts ?? 0,
        uptimePercent,
        retryQueueSize,
        lastRestSuccess: health.lastRestSuccess
          ? new Date(health.lastRestSuccess).toLocaleTimeString()
          : 'Never',
        lastRestError: health.lastRestError
          ? new Date(health.lastRestError).toLocaleTimeString()
          : 'None',
      },
      errorLog: errorLog.slice(0, 20),
      hasErrors: errorLog.length > 0,
      fieldMappingInfo,
    };
  }

  /**
   * Build field mapping debug info for the current system adapter.
   * Shows which fields are mapped and their Foundry paths.
   * @param {string|null} matchedSystem
   * @returns {object|null}
   * @private
   */
  _buildFieldMappingInfo(matchedSystem) {
    if (!matchedSystem) return null;

    // Access the actor sync adapter if available.
    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync' || m._adapter
    );
    if (!actorSync?._adapter) return null;

    const adapter = actorSync._adapter;

    // For generic adapters, we can read the field definitions.
    // For built-in adapters, show the system ID and type slug.
    return {
      systemId: adapter.systemId || matchedSystem,
      characterTypeSlug: adapter.characterTypeSlug || 'unknown',
      adapterType: adapter._fieldDefs ? 'generic' : 'built-in',
    };
  }

  /**
   * Build the Sync Capability report: what a representative Foundry actor
   * EXPOSES vs what Chronicle currently SYNCS. Samples one actor of the synced
   * type and diffs it against the system's declared character-field manifest.
   * Stashes the full report on `this._capabilityReport` for the copy actions.
   * Returns null when no system is matched. @private
   */
  async _buildCapabilityData() {
    const matchedSystem = this._syncManager?.getMatchedSystem?.();
    if (!matchedSystem) return null;

    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync'
    );
    const actorType = actorSync?._actorType || actorSync?._adapter?.actorType || 'character';

    const ofType = (game.actors?.contents || []).filter((a) => a?.type === actorType);

    // Which actor to inspect. If the GM picked one (and it still exists), use it;
    // otherwise auto-pick a representative actor: prefer a Chronicle-linked one,
    // else the first of the type. `autoPicked` drives the UI hint so the GM knows
    // the panel chose for them and can switch with the dropdown.
    const chosen = this._capabilityActorId
      ? ofType.find((a) => a.id === this._capabilityActorId)
      : null;
    const autoPicked = !chosen;
    const sample = chosen
      || ofType.find((a) => a.getFlag?.(FLAG_SCOPE, 'entityId'))
      || ofType[0]
      || null;
    if (!sample) {
      this._capabilityReport = null;
      return { available: false, actorType, actors: [], error: `no "${actorType}" actor to sample` };
    }

    // The full pick-list for the dropdown (linked actors flagged so the GM can
    // tell which heroes already sync to Chronicle).
    const actors = ofType
      .map((a) => ({
        id: a.id,
        name: a.name || '(unnamed)',
        linked: !!a.getFlag?.(FLAG_SCOPE, 'entityId'),
        selected: a.id === sample.id,
      }))
      .sort((x, y) => x.name.localeCompare(y.name));

    // Fetch the system's declared character fields (same source the adapter uses).
    // Kept until Refresh: a system's fields don't change while the window is open.
    let fieldDefs = this._cache.characterFields?.[matchedSystem] ?? null;
    if (!fieldDefs) {
      fieldDefs = { fields: [] };
      try {
        const resp = await this.api?.get(`/systems/${matchedSystem}/character-fields`);
        if (resp && Array.isArray(resp.fields)) {
          fieldDefs = resp;
          this._cache.characterFields = { ...this._cache.characterFields, [matchedSystem]: resp };
        }
      } catch (err) {
        log.warn('Dashboard: capability — failed to load character-fields', err);
        fieldDefs.loadError = game.i18n.localize(err?.status === 429
          ? 'CHRONICLE.Dashboard.Health.FieldsRateLimited'
          : 'CHRONICLE.Dashboard.Health.FieldsFailed');
      }
    }

    const snapshot = captureActorSnapshot(sample, fieldDefs);
    const report = buildCapabilityReport(snapshot, fieldDefs);
    this._capabilityReport = report; // stashed for the copy actions

    return {
      available: !!report.ok,
      actorType,
      actors,
      autoPicked,
      summary: report.summary,
      source: report.source,
      gaps: this._capabilityGaps(report),
      error: report.ok ? null : report.error,
      // "0 declared" is otherwise indistinguishable from a system with no fields.
      fieldsError: fieldDefs.loadError || null,
    };
  }

  /**
   * Flatten the non-synced capability rows into {status,label,detail} for the
   * template (the actionable "what we're missing" list). Caps the available-but-
   * unmapped list so a large system can't flood the panel. @private
   */
  _capabilityGaps(report) {
    if (!report?.ok) return [];
    const AVAIL_CAP = 50;
    const gaps = [];
    let availCount = 0;
    for (const r of report.fields) {
      if (r.status === CAP_STATUS.SYNCED) continue;
      if (r.status === CAP_STATUS.DECLARED_UNMAPPED) {
        gaps.push({ status: r.status, label: r.key, detail: 'declared field, no foundry_path' });
      } else if (r.status === CAP_STATUS.MAPPED_MISSING) {
        gaps.push({ status: r.status, label: r.key, detail: `${r.foundry_path} — absent on this actor` });
      } else if (r.status === CAP_STATUS.AVAILABLE_UNMAPPED) {
        if (availCount < AVAIL_CAP) {
          gaps.push({ status: r.status, label: r.foundry_path, detail: r.type });
        }
        availCount++;
      }
    }
    if (availCount > AVAIL_CAP) {
      gaps.push({ status: 'available-unmapped', label: `…and ${availCount - AVAIL_CAP} more available paths`, detail: '' });
    }
    for (const c of report.collections) {
      gaps.push({ status: c.status, label: c.source, detail: `${c.count} item(s) [${c.types.join(', ')}] — ${c.note}` });
    }
    return gaps;
  }

  /**
   * @param {string} state
   * @returns {string}
   * @private
   */
  _connectionLabel(state) {
    switch (state) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'reconnecting': return 'Reconnecting...';
      default: return 'Disconnected';
    }
  }

  // ---------------------------------------------------------------------------
  // Exclusions
  // ---------------------------------------------------------------------------

  /**
   * Get current sync exclusions.
   * @returns {{ excludedTypes: number[], excludedEntities: string[] }}
   * @private
   */
  _getExclusions() {
    try {
      const raw = getSetting('syncExclusions');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          excludedTypes: parsed.excludedTypes || [],
          excludedEntities: parsed.excludedEntities || [],
        };
      }
    } catch {
      // Ignore parse errors.
    }
    return { excludedTypes: [], excludedEntities: [] };
  }

  /**
   * Save sync exclusions.
   * @param {object} exclusions
   * @private
   */
  async _saveExclusions(exclusions) {
    await setSetting('syncExclusions', JSON.stringify(exclusions));
  }

  // ---------------------------------------------------------------------------
  // Render hooks
  // ---------------------------------------------------------------------------

  /**
   * Post-render DOM setup: tabs, search input, select dropdowns,
   * type header collapse, checkbox toggles.
   * @param {object} context
   * @param {object} options
   */
  _onRender(context, options) {
    const el = this.element;
    if (!el) return;
    if (context.firstRun) {
      this._firstRun?._onRender(context.firstRun, options);
      return;
    }

    // --- Tab navigation ---
    this._initTabs(el);
    // Saving the connection on the first-run screen marks the rest of the
    // setup to open once Foundry has reloaded and connected.
    const firstSave = context.configured === false;
    wireSettingsForm(el.querySelector('[data-settings-form]'), this._settings, async () => {
      if (firstSave) await setSetting('firstRunPending', true).catch(() => {});
      this.render({ force: true });
    });
    this._historyTab.mount(el, this._historyShown());

    // --- Search input ---
    const search = el.querySelector('.dashboard-search');
    if (search) {
      search.addEventListener('input', (e) => {
        this._searchFilter = e.target.value;
        this.render({ force: true });
      });
    }

    // --- Entity type header collapse/expand ---
    el.querySelectorAll('.entity-type-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        // Ignore clicks on the sync toggle button inside the header.
        if (e.target.closest('.type-sync-toggle, [data-action]')) return;

        const typeId = Number(header.dataset.typeId);
        if (this._collapsedTypes.has(typeId)) {
          this._collapsedTypes.delete(typeId);
        } else {
          this._collapsedTypes.add(typeId);
        }
        setSetting('dashboardCollapsedTypes', JSON.stringify([...this._collapsedTypes]));
        this.render({ force: true });
      });
    });

    // --- Type sync toggle ---
    el.querySelectorAll('.type-sync-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const typeId = Number(btn.dataset.typeId);
        this._onToggleType(typeId);
      });
    });

    // --- Entity sync checkbox ---
    el.querySelectorAll('.entity-sync-toggle').forEach((checkbox) => {
      checkbox.addEventListener('change', (e) => {
        const entityId = e.currentTarget.dataset.entityId;
        this._onToggleEntity(entityId, e.currentTarget.checked);
      });
    });

    // --- Bulk selection checkboxes ---
    el.querySelectorAll('.bulk-entity-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', (e) => {
        const entityId = e.currentTarget.dataset.entityId;
        if (e.currentTarget.checked) {
          this._selectedEntities.add(entityId);
        } else {
          this._selectedEntities.delete(entityId);
        }
        this.render({ force: true });
      });
    });

    // --- Bulk select all checkbox ---
    const selectAllCb = el.querySelector('.bulk-select-all-checkbox');
    if (selectAllCb) {
      selectAllCb.addEventListener('change', (e) => {
        if (e.currentTarget.checked) {
          el.querySelectorAll('.bulk-entity-checkbox').forEach((cb) => {
            this._selectedEntities.add(cb.dataset.entityId);
          });
        } else {
          this._selectedEntities.clear();
        }
        this.render({ force: true });
      });
    }

    // --- Bulk change type select ---
    const bulkTypeSelect = el.querySelector('.bulk-type-select');
    if (bulkTypeSelect) {
      bulkTypeSelect.addEventListener('change', (e) => {
        const typeId = Number(e.currentTarget.value);
        if (typeId) this._onBulkChangeType(typeId);
        e.currentTarget.value = '';
      });
    }

    // --- Overview cockpit: jump-links to other tabs ---
    // Stat tiles and "needs attention" rows carry data-jump-tab and switch the
    // active tab (no data-action, so they bypass the ApplicationV2 click router).
    el.querySelectorAll('[data-jump-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this._switchTab(e.currentTarget.dataset.jumpTab);
      });
    });

    // --- Health pane: Capability Inspector actor picker ---
    // ApplicationV2 `actions` only delegate `click`, so the `<select>` change is
    // wired here directly. Picking an actor re-renders the panel against it.
    const capActorSelect = el.querySelector('.capability-actor-select');
    if (capActorSelect) {
      capActorSelect.addEventListener('change', (e) => {
        this._capabilityActorId = e.currentTarget.value || null;
        this.render({ force: true });
      });
    }

    // --- Player reports pane: character picker and the GM's own report box ---
    el.querySelector('[data-debug-actor]')?.addEventListener('change', (e) => {
      this._debugActorId = e.currentTarget.value || null;
      this._debugSbs = { loading: false, result: null, error: '' };
      this._debugSelf = { open: false, text: '', message: '' };
      this.render({ force: true });
      if (this._debugActorId) this._debugCheck();
    });
    const selfText = el.querySelector('[data-debug-self-text]');
    selfText?.addEventListener('input', () => { this._debugSelf.text = selfText.value; });

    // Map tab handlers are wired via the `open-map-journal` action above;
    // no additional select listeners are needed.
  }

  /**
   * Initialize tab navigation with CSS class toggling.
   * ApplicationV2 doesn't auto-manage CSS-based tabs from the template,
   * so we handle it manually.
   * @param {HTMLElement} el
   * @private
   */
  _initTabs(el) {
    this._applyActiveTab(el);
    el.querySelectorAll('.dashboard-tabs .item').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        this._switchTab(tab.dataset.tab);
      });
    });
    // Each section's pane strip; arrow keys move along it, as the tab pattern expects.
    el.querySelectorAll('.cs-seg[role="tablist"]').forEach((strip) => {
      const tabs = [...strip.querySelectorAll('[data-subtab]')];
      tabs.forEach((btn, i) => {
        btn.addEventListener('click', () => this._switchTab(btn.dataset.subtab));
        btn.addEventListener('keydown', (ev) => {
          const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          ev.preventDefault();
          const next = tabs[(i + step + tabs.length) % tabs.length];
          this._switchTab(next.dataset.subtab);
          next.focus();
        });
      });
    });
  }

  /**
   * Toggle the `.active` class on the rail item, section and pane matching
   * the open section and its pane. Shared by initial render and switches.
   * @param {HTMLElement} el
   * @private
   */
  _applyActiveTab(el) {
    if (!el.querySelector(`.dashboard-content .tab[data-tab="${CSS.escape(this._activeTab)}"]`)) {
      this._activeTab = 'overview';
    }
    el.querySelectorAll('.dashboard-tabs .item').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === this._activeTab));
    el.querySelectorAll('.dashboard-content .tab').forEach((p) =>
      p.classList.toggle('active', p.dataset.tab === this._activeTab));
    // Before a campaign is connected there is no rail, only Settings.
    const open = (key) => {
      const [tab, pane] = key.split(':');
      return this._panes[tab] === pane;
    };
    el.querySelectorAll('[data-subtab]').forEach((btn) => {
      const on = open(btn.dataset.subtab);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    el.querySelectorAll('[data-subpane]').forEach((p) => p.classList.toggle('active', open(p.dataset.subpane)));
  }

  /** Whether the sync history pane is the one on screen. */
  _historyShown() {
    return this._activeTab === 'problems' && this._panes.problems === 'history';
  }

  /**
   * Open the window at a section, e.g. "settings:players", whether or not it
   * is drawn yet.
   * @param {string} tabName
   */
  openOn(tabName) {
    this._switchTab(tabName);
  }

  /**
   * Switch to a section (and pane) by name and persist it. Used by rail and
   * pane-strip clicks and by the Overview's jump-links (`data-jump-tab`).
   * Scrolls the content back to the top so the section starts at its heading.
   * @param {string} tabName
   * @private
   */
  _switchTab(tabName) {
    if (!tabName) return;
    const { tab, pane } = resolveDashboardTab(tabName);
    const moved = tab !== this._activeTab;
    this._activeTab = tab;
    if (pane) this._panes[tab] = pane;
    setSetting('dashboardActiveTab', SECTION_PANES[tab] ? `${tab}:${this._panes[tab]}` : tab);
    const el = this.element;
    if (!el) return;
    this._applyActiveTab(el);
    if (moved || pane) {
      el.querySelector('.dashboard-content')?.scrollTo?.({ top: 0 });
      const section = el.querySelector('.dashboard-content .tab.active');
      const shown = section?.querySelector('[data-subpane].active') ?? section;
      if (shown) { shown.classList.remove('cs-settle'); void shown.offsetWidth; shown.classList.add('cs-settle'); }
    }
    if (this._historyShown()) this._historyTab.shown();
  }


  // ---------------------------------------------------------------------------
  // Action handlers (ApplicationV2 actions pattern)
  // Called with `this` bound to the application instance by Foundry.
  // ---------------------------------------------------------------------------

  /** Refresh button: invalidate caches and re-render. */
  static #onRefresh() {
    this._cache = { entityTypes: null, entities: null, maps: null, calendar: null };
    this._settings.pageTypesTried = false;
    this.render({ force: true });
  }

  /** Pull a single entity from Chronicle. */
  static #onPullEntityAction(event, target) {
    const entityId = target.dataset.entityId;
    this._onPullEntity(entityId);
  }

  /** Push a Foundry journal to Chronicle. */
  static #onPushJournalAction(event, target) {
    const journalId = target.dataset.journalId;
    this._onPushJournal(journalId);
  }

  /** Delete one Foundry-only journal, after asking. */
  static #onDeleteJournalAction(event, target) {
    this._onDeleteJournals([target.dataset.journalId]);
  }

  /** Delete every journal set aside in "Chronicle: removed", after asking. */
  static #onDeleteSetAsideAction() {
    this._onDeleteJournals(this._getFoundryOnlyJournals().filter((j) => j.setAside).map((j) => j.id));
  }

  /** Pull all Chronicle-only entities. */
  static #onPullAllAction() {
    this._onPullAll();
  }

  /** Push all Foundry-only journals. */
  static #onPushAllAction() {
    this._onPushAll();
  }

  /** Toggle entity visibility (public/private). */
  static #onToggleVisibilityAction(event, target) {
    const entityId = target.dataset.entityId;
    const isPrivate = target.dataset.isPrivate === 'true';
    this._onToggleVisibility(entityId, isPrivate);
  }

  /** Open the materialized JournalEntry for a Chronicle map. */
  static #onOpenMapJournalAction(_event, target) {
    const entryId = target.dataset.journalEntryId;
    if (!entryId) return;
    const entry = game.journal.get(entryId);
    if (entry?.sheet) entry.sheet.render({ force: true });
  }

  /** Trigger a verbose full map resync. */
  static async #onResyncAllMapsAction() {
    const mapSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'MapSync'
    );
    if (!mapSync) {
      ui.notifications.warn('Chronicle: MapSync is not running.');
      return;
    }
    await mapSync.resyncAll({ verbose: true });
    this._cache.maps = null;
    this.render({ force: true });
  }

  /** Trigger a verbose full journal resync (updates existing + creates missing). */
  static async #onResyncAllJournalsAction() {
    await this._onResyncAllJournals();
  }

  /** Re-sync EVERYTHING: journals + every linked character + maps. */
  static async #onResyncEverythingAction() {
    await this._onResyncEverything();
  }

  /**
   * Reveal the "Chronicle Maps" folder in Foundry's journal sidebar.
   * Activates the journal tab and expands the folder.
   */
  static #onOpenMapsFolderAction(_event, target) {
    const folderId = target.dataset.folderId;
    if (!folderId) {
      ui.notifications.warn('Chronicle: "Chronicle Maps" folder not found. Run an initial sync first.');
      return;
    }
    try {
      ui.sidebar?.activateTab?.('journal');
      const folder = game.folders.get(folderId);
      if (folder) {
        // Folder.collection.render reveals the folder in the sidebar tree;
        // toggling expanded ensures the items inside are visible.
        if (folder.expanded === false) folder.expanded = true;
        ui.journal?.render?.(true);
      }
    } catch (err) {
      console.warn('Chronicle: Could not focus the Chronicle Maps folder', err);
    }
  }

  /** Clear the surfaced map-sync error log. */
  static #onDismissMapErrorsAction() {
    const mapSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'MapSync'
    );
    mapSync?.clearRecentErrors?.();
    this.render({ force: true });
  }

  /** Reconnect WebSocket. */
  static #onReconnectAction() {
    this.api?.connect();
    setTimeout(() => this.render({ force: true }), 1000);
  }

  // ---------------------------------------------------------------------------
  // Player reports
  // ---------------------------------------------------------------------------

  /** Localized "5m ago" style age. @private */
  _debugAge(at) {
    const { unit, n } = relativeAge(at, Date.now());
    const key = { now: 'Now', minutes: 'Minutes', hours: 'Hours', days: 'Days' }[unit];
    return game.i18n.format(`CHRONICLE.Debug.Time.${key}`, { n });
  }

  /** Words for each side-by-side result. @private */
  _debugStatusLabels() {
    const L = (k) => game.i18n.localize(`CHRONICLE.Debug.Status.${k}`);
    return { match: L('Match'), different: L('Different'), missing: L('Missing'), 'foundry-only': L('FoundryOnly') };
  }

  /** Rows with their result word and the "Info" label/value pairs. @private */
  _debugInfoRows(info) {
    const L = (k) => game.i18n.localize(`CHRONICLE.Debug.${k}`);
    const v = (x) => x || L('InfoUnknown');
    return [
      { label: L('InfoModule'), value: v(info.moduleVersion) },
      { label: L('InfoFoundry'), value: v(info.foundryVersion) },
      { label: L('InfoSystem'), value: `${v(info.systemId)} ${info.systemVersion || ''}`.trim() },
      { label: L('InfoHost'), value: v(info.chronicleHost) },
      { label: L('InfoMoney'), value: info.moneyField || L('InfoMoneyPending') },
    ];
  }

  /** Everything the Player reports pane shows. Reads only what is already in memory. @private */
  _buildDebugData() {
    const labels = this._debugStatusLabels();
    const reports = getReports();
    const { open, done } = splitReports(reports);
    const shape = (r, isDone) => {
      const snap = r.snapshot;
      const state = game.i18n.localize(isDone ? 'CHRONICLE.Debug.StateDone' : 'CHRONICLE.Debug.StateNew');
      return {
        id: r.id,
        isDone,
        firstDone: false,
        isOpen: this._debugOpen.has(r.id),
        headline: game.i18n.format('CHRONICLE.Debug.ReportLine', { name: r.fromName, when: this._debugAge(r.at), state }),
        text: `\u201c${r.text}\u201d`,
        noSnapshot: r.note || game.i18n.localize('CHRONICLE.Debug.NoSnapshot'),
        attached: game.i18n.format('CHRONICLE.Debug.Attached', { name: snap?.characterName || r.fromName }),
        snapshot: snap ? {
          rows: (snap.compare?.rows ?? []).map((x) => ({ ...x, statusLabel: labels[x.status] || x.status })),
          moneyLine: snap.compare?.moneyLine ?? '',
          log: (snap.log ?? []).slice(0, 20).map((e) => ({ level: e.level, text: e.text, time: e.at ? new Date(e.at).toLocaleString() : '' })),
          info: this._debugInfoRows(snap.info ?? {}),
        } : null,
      };
    };
    const list = [...open.map((r) => shape(r, false)), ...done.map((r) => shape(r, true))];
    const firstDone = list.find((r) => r.isDone);
    if (firstDone) firstDone.firstDone = true;

    const actors = (game.actors?.contents ?? [])
      .filter((a) => a.getFlag?.(FLAG_SCOPE, 'entityId'))
      .map((a) => ({ id: a.id, name: a.name || '(unnamed)', selected: a.id === this._debugActorId }))
      .sort((x, y) => x.name.localeCompare(y.name));

    const sbs = this._debugSbs;
    const res = sbs.result;
    const self = this._debugSelf;
    return {
      unread: unreadCount(reports),
      reports: list,
      actors,
      sbs: {
        canCheck: !!this._debugActorId,
        loading: sbs.loading,
        error: sbs.error,
        ready: !!res,
        rows: (res?.rows ?? []).map((x) => ({ ...x, statusLabel: labels[x.status] || x.status })),
        differences: res?.differences ?? 0,
        moneyLine: res?.moneyLine ?? '',
      },
      selfReport: { ...self, max: MAX_TEXT },
      log: collectSyncLog(50).map((e) => ({ level: e.level, text: e.text, time: e.at ? new Date(e.at).toLocaleTimeString() : '' })),
      info: this._debugInfoRows(collectModuleInfo(res?.moneyField ?? '')),
    };
  }

  /** (Re)run the side by side for the picked character. Read-only. @private */
  async _debugCheck() {
    const actor = game.actors.get(this._debugActorId);
    if (!actor) return;
    this._debugSbs = { loading: true, result: this._debugSbs.result, error: '' };
    this.render({ force: true });
    let out;
    try {
      out = await gatherSideBySide(actor);
    } catch (err) {
      log.error('Dashboard: side by side failed', err);
      out = { ok: false, reason: 'chronicle' };
    }
    if (this._debugActorId !== actor.id) return;
    if (out.ok) {
      this._debugSbs = { loading: false, result: out, error: '' };
    } else {
      const key = out.reason === 'unlinked' ? 'Unlinked' : 'ChronicleError';
      this._debugSbs = { loading: false, result: null, error: game.i18n.localize(`CHRONICLE.Debug.${key}`) };
    }
    this.render({ force: true });
  }

  static #onDebugCheckAction() {
    this._debugCheck();
  }

  static #onDebugOpenReportAction(_event, target) {
    const id = target.dataset.reportId;
    if (!id) return;
    if (this._debugOpen.has(id)) this._debugOpen.delete(id); else this._debugOpen.add(id);
    this.render({ force: true });
  }

  static async #onDebugDoneAction(_event, target) {
    const id = target.dataset.reportId;
    if (id) await markReportDone(id);
    this.render({ force: true });
  }

  static async #onDebugCopyIssueAction(_event, target) {
    const id = target.dataset.reportId;
    const resultEl = this.element?.querySelector(`[data-debug-copy-result="${CSS.escape(id ?? '')}"]`);
    try {
      const report = getReports().find((r) => r.id === id);
      if (!report) throw new Error('report not found');
      await game.clipboard.copyPlainText(reportToMarkdown(report, { statusLabels: this._debugStatusLabels() }));
      if (resultEl) {
        resultEl.textContent = game.i18n.localize('CHRONICLE.Debug.Copied');
        resultEl.className = 'debug-copy-result test-success';
        setTimeout(() => { resultEl.textContent = ''; }, 3000);
      }
    } catch (err) {
      log.error('Dashboard: report copy failed', err);
      if (resultEl) {
        resultEl.textContent = game.i18n.localize('CHRONICLE.Debug.CopyFailed');
        resultEl.className = 'debug-copy-result test-error';
      }
    }
  }

  /** "Report a problem" on a row: open the GM's own box, started with the row's name. */
  static #onDebugReportRowAction(event, target) {
    event.preventDefault();
    const thing = target.dataset.thing || '';
    const prefix = game.i18n.format('CHRONICLE.Debug.RowPrefix', { thing });
    this._debugSelf = { open: true, text: this._debugSelf.text || prefix, message: '' };
    this.render({ force: true });
  }

  static async #onDebugReportSendAction() {
    const characterId = game.actors.get(this._debugActorId)?.getFlag(FLAG_SCOPE, 'entityId');
    const text = this._debugSelf.text;
    if (!characterId || !text.trim()) return;
    const res = await submitReport({ characterId, text });
    if (res.ok) {
      this._debugSelf = { open: false, text: '', message: game.i18n.localize('CHRONICLE.Debug.Report.Sent') };
    } else {
      const key = res.code === 'rate_limited' ? 'RateLimited' : 'Failed';
      this._debugSelf = { open: true, text, message: game.i18n.localize(`CHRONICLE.Debug.Report.${key}`) };
    }
    this.render({ force: true });
  }

  static #onDebugReportCancelAction() {
    this._debugSelf = { open: false, text: '', message: '' };
    this.render({ force: true });
  }

  /** Clear the activity log. */
  static #onClearLogAction() {
    this._syncManager?.clearActivityLog();
    this.render({ force: true });
  }

  /** Go to the Settings section, at the tab the button names. */
  static #onOpenSettingsAction(_event, target) {
    this._switchTab(`settings:${target?.dataset?.settingsTab ?? ''}`);
  }

  /** Settings > Connection: test the typed (or saved) connection. */
  static #onTestConnectionAction(_event, target) {
    return testConnection(this.element, target);
  }

  /** Settings > Players: fetch Chronicle's members again. */
  static async #onRefreshMembersAction(_event, target) {
    await refreshMembers(target);
    this.render({ force: true });
  }

  /** Settings > Connection: the Setup Wizard, shown as the first-run screen. */
  static #onStartImportAction() {
    return this.startFirstRun();
  }

  /** The first-run screen's wizard buttons. */
  static #onWizardAction(event, target) {
    return this._firstRun?.handleAction(target.dataset.action, event, target);
  }

  /** Open a shop window via the ShopWidget module. */
  static #onOpenShopAction(event, target) {
    const entityId = target.dataset.entityId;
    const shopName = target.dataset.shopName || 'Shop';
    const shopWidget = this._syncManager?._modules?.find(
      m => m.constructor?.name === 'ShopWidget'
    );
    if (shopWidget) {
      shopWidget.openShop(entityId, shopName);
    }
  }

  /** Manually push an unlinked Foundry actor to Chronicle. */
  static #onPushActorAction(event, target) {
    const actorId = target.dataset.actorId;
    this._onPushActor(actorId);
  }

  /** Push all unlinked actors to Chronicle. */
  static #onPushAllActorsAction() {
    this._onPushAllActors();
  }

  /** Resolver: link an orphaned actor to the row's selected existing entity. */
  static #onResolveMatchAction(event, target) {
    return this._onResolveMatch(target);
  }

  /** Resolver: create a new Chronicle character (the system's type) for an orphan. */
  static #onResolveCreateAction(event, target) {
    return this._onResolveCreate(target);
  }

  /** Resolver / Characters: re-push a linked actor's current data to Chronicle. */
  static #onResolveRepushAction(event, target) {
    return this._onResolveRepush(target);
  }

  /** Copy system debug snapshot to clipboard for pasting into AI tools. */
  static #onCopyDebugAction() {
    this._onCopyDebug();
  }

  /** Copy the troubleshooting Diagnostic Bundle to the clipboard. */
  static #onCopyDiagnosticBundleAction() {
    this._onCopyDiagnosticBundle();
  }

  /**
   * Gather the live data for a Diagnostic Bundle from the same accessors the
   * status tab uses (versions, health, logs, field mapping, capability). @private
   */
  _buildDiagnosticInput() {
    const health = this.api?.health ?? {};
    const matchedSystem = this._syncManager?.getMatchedSystem?.() || null;
    const cap = this._capabilityReport;
    return {
      generatedAt: new Date().toISOString(),
      versions: {
        module: game.modules.get('chronicle-sync')?.version ?? null,
        chronicle: this._syncManager?.getChronicleVersion?.() ?? null,
        foundry: game.version ?? null,
        system: game.system?.title ?? null,
        systemId: game.system?.id ?? null,
      },
      connection: {
        state: this.api?.state ?? 'disconnected',
        uptimePercent: this.api?.getUptimePercent?.() ?? null,
        restSuccess: health.restSuccessCount ?? null,
        restError: health.restErrorCount ?? null,
        reconnectAttempts: health.reconnectAttempts ?? null,
        retryQueue: this.api?.getRetryQueueSize?.() ?? null,
      },
      fieldMapping: this._buildFieldMappingInfo(matchedSystem),
      dice: this._buildDiceData(),
      capability: cap && cap.ok ? { source: cap.source, summary: cap.summary } : null,
      activityLog: (this._syncManager?.getActivityLog?.() ?? []).slice(0, 100),
      errorLog: (this.api?.getErrorLog?.() ?? []).slice(0, 100),
      logBuffer: getLogBuffer().slice(-200),
    };
  }

  /** Health pane's Dice So Nice rows; a failure here never blanks the pane. @private */
  _buildDiceData() {
    try {
      const report = diceSoNiceReport();
      const label = { off: 'StateOff', ok: 'StateOk', warn: 'StateWarn', error: 'StateError' }[report.state];
      return { ...report, stateLabel: game.i18n.localize(`CHRONICLE.Dice.${label}`) };
    } catch (err) {
      log.warn('Dashboard: Dice So Nice check failed', err);
      return null;
    }
  }

  /** Ask the server for every rune dice file, then redraw the rows. */
  static async #onCheckDiceFilesAction() {
    try {
      await checkDiceFiles();
    } catch (err) {
      log.warn('Dashboard: dice file check failed', err);
    }
    this.render();
  }

  /** Build + copy the troubleshooting Diagnostic Bundle. Mirrors _onCopyDebug. @private */
  async _onCopyDiagnosticBundle() {
    const el = this.element;
    const resultEl = el?.querySelector('[data-bundle-result]');
    try {
      const text = buildDiagnosticBundle(this._buildDiagnosticInput());
      await game.clipboard.copyPlainText(text);
      if (resultEl) {
        resultEl.textContent = 'Copied to clipboard!';
        resultEl.className = 'debug-copy-result test-success';
        setTimeout(() => { resultEl.textContent = ''; }, 3000);
      }
      ui.notifications.info('Chronicle: Diagnostic bundle copied to clipboard.');
    } catch (err) {
      log.error('Dashboard: diagnostic bundle copy failed', err);
      if (resultEl) {
        resultEl.textContent = 'Copy failed — check console.';
        resultEl.className = 'debug-copy-result test-error';
      }
    }
  }

  /** Copy the Sync Capability report (markdown) to clipboard. */
  static #onCopyCapabilityAction() {
    this._onCopyCapability(false);
  }

  /** Copy the Sync Capability report (JSON) to clipboard. */
  static #onCopyCapabilityJsonAction() {
    this._onCopyCapability(true);
  }

  /**
   * Copy the stashed Sync Capability report to the clipboard — markdown (human +
   * AI friendly) or JSON. Mirrors _onCopyDebug. @private
   */
  async _onCopyCapability(asJson = false) {
    const el = this.element;
    const resultEl = el?.querySelector('[data-capability-result]');
    try {
      const report = this._capabilityReport;
      if (!report) throw new Error('no capability report available');
      const text = asJson ? renderCapabilityJSON(report) : renderCapabilityMarkdown(report);
      await game.clipboard.copyPlainText(text);
      if (resultEl) {
        resultEl.textContent = 'Copied to clipboard!';
        resultEl.className = 'debug-copy-result test-success';
        setTimeout(() => { resultEl.textContent = ''; }, 3000);
      }
      ui.notifications.info('Chronicle: Sync capability report copied to clipboard.');
    } catch (err) {
      log.error('Dashboard: capability copy failed', err);
      if (resultEl) {
        resultEl.textContent = 'Copy failed — check console.';
        resultEl.className = 'debug-copy-result test-error';
      }
    }
  }

  /** Set all selected entities to public. */
  static #onBulkSetPublicAction() {
    this._onBulkSetVisibility(false);
  }

  /** Set all selected entities to private. */
  static #onBulkSetPrivateAction() {
    this._onBulkSetVisibility(true);
  }

  /** Delete all selected entities after confirmation. */
  static #onBulkDeleteAction() {
    this._onBulkDelete();
  }

  /** Open a dialog to create a new Chronicle entity type. */
  static async #onCreateEntityTypeAction() {
    const html = `
      <form class="chronicle-create-type-form">
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" placeholder="e.g. Faction" required />
        </div>
        <div class="form-group">
          <label>Plural Name</label>
          <input type="text" name="name_plural" placeholder="e.g. Factions" />
        </div>
        <div class="form-group">
          <label>Icon Class</label>
          <input type="text" name="icon" value="fa-solid fa-circle" placeholder="fa-solid fa-circle" />
        </div>
        <div class="form-group">
          <label>Color</label>
          <input type="color" name="color" value="#60a5fa" />
        </div>
      </form>
    `;

    const result = await promptDialog({
      title: game.i18n.localize('CHRONICLE.Dashboard.Entities.CreateTypeTitle'),
      content: html,
      callback: (html) => {
        const form = html.querySelector ? html.querySelector('form') : html[0].querySelector('form');
        const name = form.querySelector('[name="name"]').value.trim();
        if (!name) return null;
        return {
          name,
          name_plural: form.querySelector('[name="name_plural"]').value.trim() || name + 's',
          icon: form.querySelector('[name="icon"]').value.trim() || 'fa-solid fa-circle',
          color: form.querySelector('[name="color"]').value || '#60a5fa',
        };
      },
      rejectClose: false,
    });

    if (!result) return;

    try {
      await this.api.createEntityType(result);
      ui.notifications.info(`Entity type "${noticeText(result.name)}" created.`);
      this._cache.entityTypes = null;
      this._cache.entities = null;
      this.render({ force: true });
    } catch (err) {
      ui.notifications.error(`Failed to create entity type: ${noticeText(err.message)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Actions (business logic)
  // ---------------------------------------------------------------------------

  /**
   * Toggle an entire entity type's sync exclusion.
   * @param {number} typeId
   * @private
   */
  async _onToggleType(typeId) {
    const exclusions = this._getExclusions();
    const idx = exclusions.excludedTypes.indexOf(typeId);
    if (idx >= 0) {
      exclusions.excludedTypes.splice(idx, 1);
    } else {
      exclusions.excludedTypes.push(typeId);
    }
    await this._saveExclusions(exclusions);
    this.render({ force: true });
  }

  /**
   * Toggle an individual entity's sync exclusion.
   * @param {string} entityId
   * @param {boolean} enabled - True if sync should be enabled (not excluded).
   * @private
   */
  async _onToggleEntity(entityId, enabled) {
    const exclusions = this._getExclusions();
    const idx = exclusions.excludedEntities.indexOf(entityId);
    if (enabled && idx >= 0) {
      exclusions.excludedEntities.splice(idx, 1);
    } else if (!enabled && idx < 0) {
      exclusions.excludedEntities.push(entityId);
    }
    await this._saveExclusions(exclusions);
  }

  /**
   * Pull a single entity from Chronicle into Foundry.
   * @param {string} entityId
   * @param {{quiet?: boolean}} [opts] - quiet: Pull all redraws once at the end,
   *   since each redraw re-reads the whole campaign from Chronicle.
   * @private
   */
  async _onPullEntity(entityId, { quiet = false } = {}) {
    try {
      const entity = await this.api.get(`/entities/${entityId}`);
      if (!entity) return;

      // Find the JournalSync module.
      const journalSync = this._syncManager?._modules?.find(m => m.constructor?.name === 'JournalSync');
      // A character pulled as a journal would duplicate its actor, and the
      // next connect would set that journal aside again.
      if (journalSync?._isHandledByActorSync(entity)) {
        ui.notifications.info(game.i18n.format('CHRONICLE.Dashboard.Entities.PullCharacter', { name: noticeText(entity.name) }));
        return;
      }
      if (journalSync) {
        await journalSync._createJournalFromEntity(entity);
        this._logActivity('pull', `Pulled "${entity.name}" from Chronicle`);
      }

      if (quiet) return;
      this._cache.entities = null; // Invalidate cache.
      this.render({ force: true });
    } catch (err) {
      console.error('Chronicle Dashboard: Pull failed', err);
      ui.notifications.error(`Failed to pull entity: ${noticeText(err.message)}`);
    }
  }

  /**
   * Push a Foundry journal to Chronicle as a new entity.
   * @param {string} journalId
   * @param {{quiet?: boolean}} [opts] - quiet: Push all redraws once at the end.
   * @private
   */
  async _onPushJournal(journalId, { quiet = false } = {}) {
    const journal = game.journal.get(journalId);
    if (!journal) return;

    try {
      const textPage = journal.pages.find(p => p.type === 'text');
      const entity = await this.api.post('/entities', {
        name: journal.name,
        entity_type_id: 0,
        is_private: (journal.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
        entry: textPage?.text?.content || '',
      });

      if (entity) {
        await journal.setFlag(FLAG_SCOPE, 'entityId', entity.id);
        await journal.setFlag(FLAG_SCOPE, 'lastSync', new Date().toISOString());

        // Idempotent — tolerates pre-existing mapping (e.g., dashboard
        // re-push or race with a concurrent server-side create).
        await this._syncManager?.ensureMapping({
          chronicle_type: 'entity',
          chronicle_id: entity.id,
          external_system: 'foundry',
          external_id: journal.id,
          sync_direction: 'both',
        });

        this._logActivity('push', `Pushed "${journal.name}" to Chronicle`);
      }

      if (quiet) return;
      this._cache.entities = null;
      this.render({ force: true });
    } catch (err) {
      console.error('Chronicle Dashboard: Push failed', err);
      ui.notifications.error(`Failed to push journal: ${noticeText(err.message)}`);
    }
  }

  /**
   * Re-fetch every Chronicle entity and apply it to Foundry, updating existing
   * journals (name, content, AND permissions) as well as creating missing ones.
   * This is the correct fix for journals with stale permissions.
   * @private
   */
  async _onResyncAllJournals() {
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: game.i18n.localize('CHRONICLE.Dashboard.Entities.ResyncAllJournals'),
        content: `<p>${game.i18n.localize('CHRONICLE.Dashboard.Entities.ResyncAllJournalsHint')}</p>`,
      });
    } catch {
      return; // User closed dialog.
    }
    if (!confirmed) return;

    const journalSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'JournalSync'
    );
    if (!journalSync) {
      ui.notifications.warn('Chronicle: JournalSync is not running.');
      return;
    }
    await journalSync.resyncAll({ verbose: true });
    this._cache.entities = null;
    this.render({ force: true });
  }

  /**
   * Pull all Chronicle-only entities.
   * @private
   */
  async _onPullAll() {
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: 'Pull All from Chronicle',
        content: '<p>Pull all Chronicle entities that don\'t have a Foundry journal yet?</p>',
      });
    } catch {
      return; // User closed dialog.
    }
    if (!confirmed) return;

    const data = await this._prepareContext();
    let count = 0;
    for (const group of data.entityGroups) {
      for (const entity of group.entities) {
        if (entity.status === 'chronicle-only') {
          await this._onPullEntity(entity.id, { quiet: true });
          count++;
        }
      }
    }
    this._cache.entities = null;
    this.render({ force: true });
    ui.notifications.info(`Chronicle: Pulled ${count} entities.`);
  }

  /**
   * Push all Foundry-only journals.
   * @private
   */
  async _onPushAll() {
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: 'Push All to Chronicle',
        content: '<p>Push all Foundry journals that aren\'t linked to Chronicle yet?</p>',
      });
    } catch {
      return; // User closed dialog.
    }
    if (!confirmed) return;

    const journals = this._getFoundryOnlyJournals();
    let count = 0;
    for (const j of journals) {
      await this._onPushJournal(j.id, { quiet: true });
      count++;
    }
    this._cache.entities = null;
    this.render({ force: true });
    ui.notifications.info(`Chronicle: Pushed ${count} journals.`);
  }

  /**
   * Toggle entity visibility (public/private) on Chronicle.
   * @param {string} entityId
   * @param {boolean} currentlyPrivate
   * @private
   */
  async _onToggleVisibility(entityId, currentlyPrivate) {
    try {
      // Use the purpose-built reveal endpoint: a bare PUT /entities/:id
      // with only {is_private} fails Chronicle's UpdateEntity name-required
      // validation. POST /entities/:id/reveal accepts exactly {is_private}.
      await this.api.post(`/entities/${entityId}/reveal`, {
        is_private: !currentlyPrivate,
      });

      // Update the local journal's ownership.
      const journal = game.journal.find(j => j.getFlag(FLAG_SCOPE, 'entityId') === entityId);
      if (journal) {
        const newOwnership = currentlyPrivate
          ? { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
          : { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
        await journal.update({ ownership: newOwnership });
      }

      this._cache.entities = null;
      this.render({ force: true });
    } catch (err) {
      console.error('Chronicle Dashboard: Visibility toggle failed', err);
    }
  }

  /**
   * Manually push an unlinked actor to Chronicle.
   * Triggers the ActorSync create flow for an actor that wasn't
   * auto-pushed (e.g., existed before character sync was enabled).
   * @param {string} actorId
   * @private
   */
  async _onPushActor(actorId) {
    const actor = game.actors.get(actorId);
    if (!actor) return;

    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync'
    );
    if (!actorSync) {
      ui.notifications.warn('Character sync module not active.');
      return;
    }

    try {
      // Trigger the create flow by calling the hook handler directly.
      await actorSync._handleCreateActor(actor, {}, game.user.id);
      this._logActivity('push', `Pushed actor "${actor.name}" to Chronicle`);
      this.render({ force: true });
    } catch (err) {
      console.error('Chronicle Dashboard: Push actor failed', err);
      ui.notifications.error(`Failed to push actor: ${noticeText(err.message)}`);
    }
  }

  /** Link an orphaned actor (button's data-actor-id) to the row's selected entity. */
  async _onResolveMatch(target) {
    const actorId = target?.dataset?.actorId;
    const row = target?.closest?.('.issue-row');
    const entityId = row?.querySelector?.('.issue-match-select')?.value;
    if (!actorId || !entityId) { ui.notifications.warn('Chronicle: Pick a character to match to first.'); return; }
    const actorSync = this._actorSync();
    if (!actorSync) { ui.notifications.warn('Chronicle: Character sync not active.'); return; }
    try {
      const ok = await actorSync.matchActorToEntity(actorId, entityId);
      ui.notifications[ok ? 'info' : 'warn'](ok ? 'Chronicle: Matched and synced.' : 'Chronicle: Match failed.');
    } catch (err) {
      console.error('Chronicle Dashboard: match failed', err);
      ui.notifications.error('Chronicle: Match failed — see console.');
    }
    this.render({ force: true });
  }

  /** Create a new Chronicle character (the system's type) for an orphaned actor. */
  async _onResolveCreate(target) {
    const actorId = target?.dataset?.actorId;
    if (!actorId) return;
    const actorSync = this._actorSync();
    if (!actorSync) { ui.notifications.warn('Chronicle: Character sync not active.'); return; }
    try {
      const ok = await actorSync.createEntityForActor(actorId);
      ui.notifications[ok ? 'info' : 'warn'](ok ? 'Chronicle: Created and linked.' : 'Chronicle: Create failed.');
    } catch (err) {
      console.error('Chronicle Dashboard: create failed', err);
      ui.notifications.error('Chronicle: Create failed — see console.');
    }
    this.render({ force: true });
  }

  /** Re-push a linked actor's current data to Chronicle (the stranded-data fix). */
  async _onResolveRepush(target) {
    const actorId = target?.dataset?.actorId;
    if (!actorId) return;
    const actorSync = this._actorSync();
    if (!actorSync) { ui.notifications.warn('Chronicle: Character sync not active.'); return; }
    try {
      const ok = await actorSync.repushActor(actorId);
      ui.notifications[ok ? 'info' : 'warn'](ok ? 'Chronicle: Re-synced to Chronicle.' : 'Chronicle: Re-sync failed.');
    } catch (err) {
      console.error('Chronicle Dashboard: re-sync failed', err);
      ui.notifications.error('Chronicle: Re-sync failed — see console.');
    }
    this.render({ force: true });
  }

  async _onPushAllActors() {
    const actorSync = this._syncManager?._modules?.find(
      (m) => m.constructor?.name === 'ActorSync'
    );
    if (!actorSync) {
      ui.notifications.warn('Character sync module not active.');
      return;
    }

    const characters = actorSync.getSyncedActors?.() ?? [];
    const unlinked = characters.filter((c) => !c.synced);

    if (unlinked.length === 0) {
      ui.notifications.info('Chronicle: All characters are already synced.');
      return;
    }

    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: 'Push All Actors to Chronicle',
        content: `<p>Push ${unlinked.length} unlinked actor(s) to Chronicle?</p>`,
      });
    } catch {
      return; // User closed dialog.
    }
    if (!confirmed) return;

    let count = 0;
    for (const c of unlinked) {
      try {
        const actor = game.actors.get(c.id);
        if (actor) {
          await actorSync._handleCreateActor(actor, {}, game.user.id);
          count++;
        }
      } catch (err) {
        console.error(`Chronicle Dashboard: Failed to push actor "${c.name}"`, err);
      }
    }

    this._logActivity('push', `Pushed ${count} actors to Chronicle`);
    ui.notifications.info(`Chronicle: Pushed ${count} actor(s) to Chronicle.`);
    this.render({ force: true });
  }

  /**
   * Re-sync everything that's already connected to Chronicle in one action:
   * all journals, every LINKED character (re-pushes current field data —
   * Foundry is source of truth for characters), and all maps.
   *
   * Unlinked actors are intentionally NOT auto-created here — that's a
   * heavier, entity-creating operation kept on the Characters tab's "Push
   * All Actors". Each module's resyncAll / repushActor is the same path the
   * per-tab buttons use; failures are isolated per item so one bad actor
   * can't abort the rest.
   */
  async _onResyncEverything() {
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: 'Sync Everything Now',
        content: '<p>Re-sync <strong>all</strong> journals, linked characters, and maps with Chronicle?</p>'
          + '<p class="hint">Foundry is the source of truth for characters — their current data is pushed up.</p>',
      });
    } catch {
      return; // User dismissed the dialog.
    }
    if (!confirmed) return;

    ui.notifications.info('Chronicle: Re-syncing everything…');
    const mods = this._syncManager?._modules || [];
    const find = (name) => mods.find((m) => m.constructor?.name === name);
    const done = [];

    // 1. Journals (verbose=false to avoid a flood of per-entry toasts mid-sweep).
    const journalSync = find('JournalSync');
    if (journalSync?.resyncAll) {
      try { await journalSync.resyncAll({ verbose: false }); done.push('journals'); }
      catch (err) { console.error('Chronicle: journal resync failed', err); }
    }

    // 2. Characters — re-push every LINKED actor so stale fields refresh.
    const actorSync = find('ActorSync');
    if (actorSync?.repushActor) {
      const chars = actorSync.getSyncedActors?.() ?? [];
      let pushed = 0;
      for (const c of chars) {
        if (!c.synced) continue; // unlinked → use "Push All Actors" (creates entities)
        try { if (await actorSync.repushActor(c.id)) pushed++; }
        catch (err) { console.error(`Chronicle: re-push failed for "${c.name}"`, err); }
      }
      if (pushed) done.push(`${pushed} character(s)`);
    }

    // 3. Maps.
    const mapSync = find('MapSync');
    if (mapSync?.resyncAll) {
      try { await mapSync.resyncAll({ verbose: false }); done.push('maps'); }
      catch (err) { console.error('Chronicle: map resync failed', err); }
    }

    this._cache.maps = null;
    this._cache.entities = null;
    this._logActivity('push', `Re-synced everything (${done.join(', ') || 'nothing'})`);
    this.render({ force: true });
    ui.notifications.info(`Chronicle: Re-sync complete — ${done.join(', ') || 'nothing to sync'}.`);
  }

  // ---------------------------------------------------------------------------
  // Debug Export
  // ---------------------------------------------------------------------------

  /**
   * Build and copy a system debug snapshot to the clipboard.
   * The output is designed to be pasted into an AI tool (e.g., Claude) to help
   * build a Chronicle system adapter for the current Foundry game system.
   * @private
   */
  async _onCopyDebug() {
    const el = this.element;
    const resultEl = el?.querySelector('[data-debug-result]');

    try {
      const text = this._buildDebugText();
      await game.clipboard.copyPlainText(text);

      if (resultEl) {
        resultEl.textContent = 'Copied to clipboard!';
        resultEl.className = 'debug-copy-result test-success';
        setTimeout(() => { resultEl.textContent = ''; }, 3000);
      }
      ui.notifications.info('Chronicle: System debug snapshot copied to clipboard.');
    } catch (err) {
      console.error('Chronicle Dashboard: Debug export failed', err);
      if (resultEl) {
        resultEl.textContent = 'Copy failed — check console.';
        resultEl.className = 'debug-copy-result test-error';
      }
    }
  }

  /**
   * Format the System Debug snapshot as a fenced JSON block. Shared by the
   * dashboard "Copy System Debug" button (`_onCopyDebug`) and the module-API
   * escape hatch (`copyDebugReport`). DOM-independent.
   * @returns {string}
   * @private
   */
  _buildDebugText() {
    const snapshot = this._buildDebugExport();
    return '```json\n' + JSON.stringify(snapshot, null, 2) + '\n```';
  }

  /**
   * Build the System Debug report, copy it to the clipboard (best-effort), and
   * RETURN the report string. DOM-independent, so it works whether or not the
   * dashboard is rendered — this is what `game.modules.get('chronicle-sync')
   * .api.copyDebug()` calls so an operator can always produce diagnostics from
   * the console even if the dashboard's toolbar/sidebar entry points regress
   * on a Foundry upgrade. Clipboard failure is non-fatal (the returned string
   * is the fallback the caller can copy from the console).
   * @returns {Promise<string>}
   */
  async copyDebugReport() {
    const text = this._buildDebugText();
    try {
      await game.clipboard?.copyPlainText?.(text);
      ui.notifications?.info?.('Chronicle: System debug snapshot copied to clipboard.');
    } catch (err) {
      console.warn('Chronicle Dashboard: clipboard copy failed; report returned for manual copy', err);
    }
    return text;
  }

  /**
   * Gather all relevant data about the current Foundry game system that would
   * be needed to build a Chronicle system adapter. Includes system metadata,
   * actor types, sample actor schema, hooks used by the sync module, and the
   * expected adapter interface.
   * @returns {object}
   * @private
   */
  _buildDebugExport() {
    const sys = game.system;
    const sampleActor = game.actors?.contents?.find(a => a.type === 'character')
      || game.actors?.contents?.[0];

    // Extract actor type distribution.
    const actorTypes = {};
    for (const a of (game.actors?.contents || [])) {
      actorTypes[a.type] = (actorTypes[a.type] || 0) + 1;
    }

    // Extract system data schema from a sample actor.
    let sampleSchema = null;
    if (sampleActor?.system) {
      sampleSchema = this._extractSchemaSnapshot(sampleActor.system, 'system', 3);
    }

    // Item type distribution.
    const itemTypes = {};
    const sampleItems = [];
    if (sampleActor?.items?.size) {
      for (const item of sampleActor.items) {
        itemTypes[item.type] = (itemTypes[item.type] || 0) + 1;
        if (sampleItems.length < 2) {
          sampleItems.push({
            name: item.name,
            type: item.type,
            schema: this._extractSchemaSnapshot(item.system || {}, 'system', 2),
          });
        }
      }
    }

    // Chronicle sync state.
    const matchedSystem = this._syncManager?.getMatchedSystem() || null;
    const actorSync = this._syncManager?._modules?.find(
      m => m.constructor?.name === 'ActorSync' || m._adapter
    );

    // Include API errors so they appear in the debug copy/paste.
    const errorLog = this.api?.getErrorLog() ?? [];
    // ChronicleAPI exposes connection state as `.state` (connected/connecting/
    // reconnecting/disconnected); there is no `.connected` boolean.
    const connectionState = this.api?.state ?? (this.api ? 'unknown' : 'no-client');

    return {
      _description: 'Chronicle Sync — Foundry System Debug Snapshot. '
        + 'Use this to build a Chronicle system adapter or character-fields manifest. '
        + 'See the "adapterInterface" section for the expected field mapping format.',
      foundry: {
        version: game.version,
        system: {
          id: sys?.id,
          title: sys?.title,
          version: sys?.version,
        },
      },
      actorTypes,
      sampleActor: sampleActor ? {
        name: sampleActor.name,
        type: sampleActor.type,
        schema: sampleSchema,
      } : null,
      sampleItems: sampleItems.length ? sampleItems : null,
      itemTypes: Object.keys(itemTypes).length ? itemTypes : null,
      chronicleState: {
        matchedSystem,
        hasAdapter: !!actorSync?._adapter,
        adapterType: actorSync?._adapter?._fieldDefs ? 'generic' : (actorSync?._adapter ? 'built-in' : 'none'),
        connection: connectionState,
      },
      errors: errorLog.length ? errorLog : null,
      hooks: {
        _note: 'These are the Foundry hooks the Chronicle sync module listens to. '
          + 'The adapter maps fields between these hook payloads and Chronicle entity fields_data.',
        actorHooks: ['createActor', 'updateActor', 'deleteActor'],
        itemHooks: ['createItem', 'updateItem', 'deleteItem'],
        journalHooks: ['createJournalEntry', 'updateJournalEntry', 'deleteJournalEntry'],
      },
      adapterInterface: {
        _note: 'To build a Chronicle system adapter, implement these exports. '
          + 'toChronicleFields(actor) extracts from actor.system paths. '
          + 'fromChronicleFields(entity) returns dot-notation keys for actor.update(). '
          + 'Alternatively, create a generic adapter manifest with foundry_path annotations.',
        exports: {
          systemId: 'string — Chronicle system ID (e.g., "drawsteel")',
          characterTypeSlug: 'string — Chronicle entity type slug (e.g., "drawsteel-character")',
          actorType: 'string — Foundry actor type to sync (e.g., "character" or "hero")',
          'toChronicleFields(actor)': 'Extract actor.system fields → flat {key: value} object',
          'fromChronicleFields(entity)': 'Convert entity.fields_data → {"system.path.to.field": value} for actor.update()',
        },
        genericManifestFormat: {
          _note: 'For the generic adapter, define fields via the /systems/:id/character-fields API.',
          exampleField: {
            key: 'hp_current',
            foundry_path: 'system.attributes.hp.value',
            foundry_writable: true,
            type: 'number',
          },
          foundry_actor_type: 'character (or "hero" for Draw Steel, etc.)',
          preset_slug: '<systemId>-character',
        },
      },
    };
  }

  /**
   * Recursively extract a schema snapshot from an object, showing types and
   * sample values up to a given depth. Arrays are sampled at index 0.
   * @param {object} obj - The object to snapshot.
   * @param {string} prefix - Dot-notation prefix for keys.
   * @param {number} maxDepth - Maximum recursion depth.
   * @returns {object} Schema snapshot with {path: {type, value}} entries.
   * @private
   */
  _extractSchemaSnapshot(obj, prefix, maxDepth) {
    const result = {};
    if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return result;

    const entries = Object.entries(obj);
    for (const [key, value] of entries) {
      const path = `${prefix}.${key}`;

      if (value == null) {
        result[path] = { type: 'null', value: null };
      } else if (typeof value === 'number') {
        result[path] = { type: 'number', value };
      } else if (typeof value === 'string') {
        result[path] = { type: 'string', value: value.length > 80 ? value.slice(0, 80) + '...' : value };
      } else if (typeof value === 'boolean') {
        result[path] = { type: 'boolean', value };
      } else if (Array.isArray(value)) {
        result[path] = { type: 'array', length: value.length };
      } else if (typeof value === 'object') {
        Object.assign(result, this._extractSchemaSnapshot(value, path, maxDepth - 1));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  /**
   * Change entity type for all selected entities.
   * @param {number} newTypeId
   * @private
   */
  async _onBulkChangeType(newTypeId) {
    if (this._selectedEntities.size === 0) return;

    const count = this._selectedEntities.size;
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: game.i18n.localize('CHRONICLE.Dashboard.Bulk.ChangeType'),
        content: `<p>${game.i18n.format('CHRONICLE.Dashboard.Bulk.ConfirmChangeType', { count })}</p>`,
      });
    } catch { return; }
    if (!confirmed) return;

    try {
      await this.api.bulkUpdateEntityType({
        entity_ids: [...this._selectedEntities],
        entity_type_id: newTypeId,
      });
      this._selectedEntities.clear();
      this._cache.entities = null;
      this._logActivity('update', `Bulk changed type for ${count} entities`);
      this.render({ force: true });
    } catch (err) {
      console.error('Chronicle Dashboard: Bulk change type failed', err);
      ui.notifications.error(`Bulk type change failed: ${noticeText(err.message)}`);
    }
  }

  /**
   * Set visibility (public/private) for all selected entities.
   * @param {boolean} makePrivate
   * @private
   */
  async _onBulkSetVisibility(makePrivate) {
    if (this._selectedEntities.size === 0) return;

    const count = this._selectedEntities.size;
    const ids = [...this._selectedEntities];
    let succeeded = 0;

    for (const entityId of ids) {
      try {
        // Reveal endpoint (see _onToggleVisibility): a bare PUT /entities/:id
        // with only {is_private} 400s on UpdateEntity's name-required check;
        // POST /entities/:id/reveal accepts {is_private}.
        await this.api.post(`/entities/${entityId}/reveal`, { is_private: makePrivate });

        const journal = game.journal.find(j => j.getFlag(FLAG_SCOPE, 'entityId') === entityId);
        if (journal) {
          const newOwnership = makePrivate
            ? { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
            : { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
          await journal.update({ ownership: newOwnership });
        }
        succeeded++;
      } catch (err) {
        console.warn(`Chronicle: Failed to set visibility for entity ${entityId}`, err);
      }
    }

    this._selectedEntities.clear();
    this._cache.entities = null;
    const label = makePrivate ? 'private' : 'public';
    this._logActivity('update', `Set ${succeeded} entities to ${label}`);
    this.render({ force: true });
  }

  /**
   * Delete all selected entities from Chronicle (with confirmation).
   * @private
   */
  async _onBulkDelete() {
    if (this._selectedEntities.size === 0) return;

    const count = this._selectedEntities.size;
    let confirmed;
    try {
      confirmed = await confirmDialog({
        title: game.i18n.localize('CHRONICLE.Dashboard.Bulk.Delete'),
        content: `<p>${game.i18n.format('CHRONICLE.Dashboard.Bulk.ConfirmDelete', { count })}</p>`,
      });
    } catch { return; }
    if (!confirmed) return;

    const ids = [...this._selectedEntities];
    let succeeded = 0;

    for (const entityId of ids) {
      try {
        await this.api.delete(`/entities/${entityId}`);
        succeeded++;
      } catch (err) {
        console.warn(`Chronicle: Failed to delete entity ${entityId}`, err);
      }
    }

    this._selectedEntities.clear();
    this._cache.entities = null;
    this._logActivity('update', `Deleted ${succeeded} entities from Chronicle`);
    this.render({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Add an entry to the activity log.
   * @param {string} type
   * @param {string} message
   */
  _logActivity(type, message) {
    this._syncManager?.logActivity(type, message);
  }

  /** Force refresh all data and re-render. */
  refresh() {
    this._cache = { entityTypes: null, entities: null, maps: null, calendar: null };
    this.render({ force: true });
  }
}
