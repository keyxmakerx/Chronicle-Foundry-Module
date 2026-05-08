/**
 * Chronicle Sync - Map Sync (FM-MAP1, Path B)
 *
 * Orchestrates Chronicle map data into Foundry. The previous architecture
 * bound Chronicle markers to Foundry Scene Notes; that path is gone. Maps
 * now materialize as JournalEntries (one entry per map, image-type page)
 * inside a "Chronicle Maps" folder, and `MapViewerSheet` renders the map
 * with all sub-resources via SVG overlays.
 *
 * Responsibilities:
 *   - Materialize Chronicle maps as JournalEntry documents (idempotent by
 *     `mapId` page flag).
 *   - Maintain an in-memory cache of all map sub-resources (markers,
 *     drawings, tokens, fog, layers) for the current GM session.
 *   - Filter sub-resources by audience, writing only player-safe data into
 *     JournalEntry page flags so Foundry's native document sync delivers
 *     them to players. DM-only data lives only in GM memory.
 *   - Handle Chronicle WebSocket events for `map.*`, `marker.*`, `drawing.*`,
 *     `token.*`, `layer.*`, `fog.*` (with a 5s polling fallback for types
 *     Chronicle does not yet emit — see TODO(FM-MAP1-WS) markers).
 *   - Provide marker CRUD helpers used by MapViewerSheet's edit affordances.
 *
 * Visibility model (Phase A):
 *   - Markers with `visibility=dm_only` → GM memory only, never in flags.
 *   - Markers with `visibility=everyone` → flag-stored. Per-user
 *     `visibility_rules` are embedded for client-side render-time filtering.
 *     This trades a known DOM-inspection leak (the marker name is in flags
 *     even for non-allowed users) for feature parity. Flagged in PR.
 *   - Drawings with `is_hidden=true` → GM memory only.
 *   - Drawings with `is_visible=false` → not rendered (not stored in flags).
 *   - Drawings with `is_visible=true && is_hidden=false` → flag-stored.
 *   - Tokens, layers → flag-stored (no per-user visibility in schema).
 *   - Fog of war → GM memory only.
 *
 * Player-side this module is inert (SyncManager.start exits early for
 * non-GM users, so init() is never called). MapViewerSheet on the player's
 * machine reads only from page flags written by the GM client.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

/** Folder name for materialized Chronicle maps. */
const MAPS_FOLDER_NAME = 'Chronicle Maps';

/** Polling interval for sub-resource types Chronicle doesn't yet emit events for. */
const POLL_INTERVAL_MS = 5000;

/** Sub-resource types we currently poll. `marker.*` is omitted because
 *  Chronicle's `MapEventPublisher` already emits marker events. */
// TODO(FM-MAP1-WS): remove drawing/token/layer/fog from this list once
// Chronicle's C-MAP1 work ships event emission for those resource types.
const POLLED_SUBRESOURCES = Object.freeze(['drawings', 'tokens', 'layers', 'fog']);

/**
 * Pin category → Foundry icon and color mapping.
 * Re-exported for backward compatibility with map-viewer.mjs which uses
 * the same icon set for local-pin rendering.
 */
export const PIN_ICONS = {
  location: { icon: 'icons/svg/village.svg', color: '#3B82F6', faIcon: 'fa-map-pin' },
  danger:   { icon: 'icons/svg/skull.svg',   color: '#EF4444', faIcon: 'fa-skull' },
  treasure: { icon: 'icons/svg/chest.svg',   color: '#F59E0B', faIcon: 'fa-gem' },
  quest:    { icon: 'icons/svg/book.svg',    color: '#8B5CF6', faIcon: 'fa-scroll' },
  note:     { icon: 'icons/svg/eye.svg',     color: '#6B7280', faIcon: 'fa-map-pin' },
};

/**
 * Convert a Chronicle map's `image_id` (or full URL) to a usable image src
 * for Foundry. Chronicle returns either a media UUID or a full URL; we
 * prefix media UUIDs with the configured base URL.
 * @param {object} map
 * @returns {string}
 */
function _mapImageSrc(map) {
  if (!map) return '';
  if (map.image_url) return map.image_url;
  if (map.image && /^https?:/i.test(map.image)) return map.image;
  if (map.image_id) {
    const baseUrl = getSetting('apiUrl')?.replace(/\/+$/, '');
    return baseUrl ? `${baseUrl}/api/v1/media/${map.image_id}` : '';
  }
  return '';
}

/**
 * MapSync orchestrates Chronicle map data ↔ Foundry materialization.
 */
export class MapSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** Back-reference to SyncManager (bound by registerModule). */
    this._syncManager = null;

    /**
     * GM-side cache of full sub-resource data per Chronicle map id.
     * Populated lazily on viewer-open and on incoming WS events.
     * Players never have an entry here.
     * @type {Map<string, {
     *   meta: object,
     *   markers: object[],
     *   drawings: object[],
     *   tokens: object[],
     *   layers: object[],
     *   fog: object|null,
     *   lastFetched: number,
     * }>}
     */
    this._cache = new Map();

    /** Active poll timers keyed by mapId. */
    this._pollTimers = new Map();

    /** Open-viewer registry: mapId → count of open MapViewerSheets needing data. */
    this._openCounts = new Map();
  }

  /**
   * Initialize map sync. GM only — SyncManager.start exits early for non-GM.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;
    if (!getSetting('syncMaps')) return;
    console.debug('Chronicle: Map sync initialized (Path B, journal-backed)');
  }

  /**
   * Handle WebSocket messages routed from SyncManager.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncMaps')) return;
    if (!msg?.type) return;

    try {
      switch (msg.type) {
        case 'map.created':   await this._onMapCreated(msg.payload); break;
        case 'map.updated':   await this._onMapUpdated(msg.payload); break;
        case 'map.deleted':   await this._onMapDeleted(msg.payload); break;

        case 'marker.created':
        case 'marker.updated':
        case 'marker.deleted':
          await this._onMarkerEvent(msg.type, msg.payload); break;

        case 'drawing.created':
        case 'drawing.updated':
        case 'drawing.deleted':
          await this._onDrawingEvent(msg.type, msg.payload); break;

        case 'token.created':
        case 'token.updated':
        case 'token.deleted':
          await this._onTokenEvent(msg.type, msg.payload); break;

        case 'layer.created':
        case 'layer.updated':
        case 'layer.deleted':
          await this._onLayerEvent(msg.type, msg.payload); break;

        case 'fog.updated':
        case 'fog.deleted':
          await this._onFogEvent(msg.type, msg.payload); break;
      }
    } catch (err) {
      console.error(`Chronicle: MapSync.onMessage error for ${msg.type}`, err);
    }
  }

  /** Stop polling and clear caches on shutdown. */
  destroy() {
    for (const timer of this._pollTimers.values()) clearInterval(timer);
    this._pollTimers.clear();
    this._cache.clear();
    this._openCounts.clear();
  }

  /**
   * Initial sync: fetch all Chronicle maps and materialize each as a
   * JournalEntry. Idempotent — re-running matches existing entries by
   * `mapId` page flag, not by name.
   */
  async onInitialSync() {
    if (!getSetting('syncMaps')) return;
    if (!this._api) return;

    let maps;
    try {
      const result = await this._api.get('/maps');
      maps = Array.isArray(result) ? result : (result?.data || []);
    } catch (err) {
      console.warn('Chronicle: Initial map sync failed to fetch /maps', err);
      return;
    }

    if (!maps.length) {
      console.debug('Chronicle: No maps to materialize');
      return;
    }

    await this._ensureMapsFolder();

    for (const map of maps) {
      try {
        await this._materializeMap(map);
      } catch (err) {
        console.warn(`Chronicle: Failed to materialize map ${map.id}`, err);
      }
    }
    console.debug(`Chronicle: Materialized ${maps.length} Chronicle map(s)`);
  }

  /**
   * Backward-compat with SyncManager.runWizardImport: handle "map" mappings
   * during wizard import. Phase B no-op (we materialize from /maps directly,
   * not from sync mappings) but kept for legacy mappings to be ignored
   * gracefully without errors.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping?.chronicle_type !== 'map') return;
    // No-op. Path B materializes from the /maps endpoint, not from
    // sync mappings. Legacy mappings are tolerated silently.
  }

  // ---------------------------------------------------------------------------
  // Public API used by MapViewerSheet
  // ---------------------------------------------------------------------------

  /**
   * Build the merged render payload for a map page. Players see flag data
   * only. GMs additionally see DM-only memory.
   * @param {JournalEntryPage} page
   * @returns {{
   *   meta: object|null,
   *   markers: object[],
   *   drawings: object[],
   *   tokens: object[],
   *   layers: object[],
   *   fog: object|null,
   * }}
   */
  getMapData(page) {
    const mapId = page?.getFlag(FLAG_SCOPE, 'mapId') || null;
    const meta = page?.getFlag(FLAG_SCOPE, 'chronicleMapMeta') || null;
    const markers = page?.getFlag(FLAG_SCOPE, 'chronicleMarkers') || [];
    const drawings = page?.getFlag(FLAG_SCOPE, 'chronicleDrawings') || [];
    const tokens = page?.getFlag(FLAG_SCOPE, 'chronicleTokens') || [];
    const layers = page?.getFlag(FLAG_SCOPE, 'chronicleLayers') || [];

    if (!mapId || !game.user.isGM) {
      return { meta, markers, drawings, tokens, layers, fog: null };
    }

    const cached = this._cache.get(mapId);
    if (!cached) {
      return { meta, markers, drawings, tokens, layers, fog: null };
    }

    return {
      meta: cached.meta || meta,
      markers: this._mergeById(markers, cached.markers || []),
      drawings: this._mergeById(drawings, cached.drawings || []),
      tokens: cached.tokens || tokens,
      layers: cached.layers || layers,
      fog: cached.fog || null,
    };
  }

  /**
   * Notify MapSync that a viewer for this map opened. GM-only — triggers
   * sub-resource fetch and starts polling for non-event types.
   * @param {string} mapId
   */
  async onViewerOpen(mapId) {
    if (!game.user.isGM || !this._api || !mapId) return;
    const count = (this._openCounts.get(mapId) || 0) + 1;
    this._openCounts.set(mapId, count);

    if (count === 1) {
      await this._refreshSubResources(mapId).catch((err) =>
        console.warn(`Chronicle: Sub-resource fetch failed for map ${mapId}`, err)
      );
      this._startPolling(mapId);
    }
  }

  /** Notify MapSync that a viewer closed. Stops polling when last viewer closes. */
  onViewerClose(mapId) {
    if (!mapId) return;
    const count = (this._openCounts.get(mapId) || 0) - 1;
    if (count <= 0) {
      this._openCounts.delete(mapId);
      this._stopPolling(mapId);
    } else {
      this._openCounts.set(mapId, count);
    }
  }

  /**
   * GM-only: create a marker on Chronicle and update local cache + flags.
   * @param {string} mapId
   * @param {object} markerData - Marker fields (name, x, y, visibility, etc.)
   * @returns {Promise<object|null>}
   */
  async createMarker(mapId, markerData) {
    if (!game.user.isGM || !this._api || !mapId) return null;
    try {
      const result = await this._api.post(`/maps/${mapId}/markers`, markerData);
      if (result?.id) {
        await this._refreshSubResources(mapId);
      }
      return result;
    } catch (err) {
      console.error('Chronicle: Failed to create marker', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.MapViewer.MarkerCreateFailed'));
      return null;
    }
  }

  /**
   * GM-only: update a marker on Chronicle.
   * @param {string} mapId
   * @param {string} markerId
   * @param {object} markerData
   * @returns {Promise<object|null>}
   */
  async updateMarker(mapId, markerId, markerData) {
    if (!game.user.isGM || !this._api || !mapId || !markerId) return null;
    try {
      const result = await this._api.put(`/maps/${mapId}/markers/${markerId}`, markerData);
      await this._refreshSubResources(mapId);
      return result;
    } catch (err) {
      console.error('Chronicle: Failed to update marker', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.MapViewer.MarkerUpdateFailed'));
      return null;
    }
  }

  /**
   * GM-only: delete a marker on Chronicle.
   * @param {string} mapId
   * @param {string} markerId
   */
  async deleteMarker(mapId, markerId) {
    if (!game.user.isGM || !this._api || !mapId || !markerId) return;
    try {
      await this._api.delete(`/maps/${mapId}/markers/${markerId}`);
      await this._refreshSubResources(mapId);
    } catch (err) {
      console.error('Chronicle: Failed to delete marker', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.MapViewer.MarkerDeleteFailed'));
    }
  }

  /**
   * Build a deep-link URL to the Chronicle web editor for a map.
   * @param {string} mapId
   * @returns {string|null}
   */
  getChronicleMapUrl(mapId) {
    const baseUrl = getSetting('apiUrl')?.replace(/\/+$/, '');
    const campaignId = getSetting('campaignId');
    if (!baseUrl || !campaignId || !mapId) return null;
    return `${baseUrl}/campaigns/${campaignId}/maps/${mapId}`;
  }

  /**
   * Find the Foundry JournalEntryPage materialized for a Chronicle map id.
   * @param {string} mapId
   * @returns {JournalEntryPage|null}
   */
  findPageByMapId(mapId) {
    if (!mapId) return null;
    for (const entry of game.journal.contents) {
      for (const page of entry.pages.contents) {
        if (page.getFlag(FLAG_SCOPE, 'mapId') === mapId) return page;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Materialization
  // ---------------------------------------------------------------------------

  /**
   * Ensure the "Chronicle Maps" JournalEntry folder exists. Auto-created on
   * first run. Idempotent by `isMapsFolder` flag, not by name (users may
   * rename it).
   * @returns {Promise<Folder>}
   * @private
   */
  async _ensureMapsFolder() {
    let folder = game.folders.find(
      (f) => f.type === 'JournalEntry' && f.getFlag(FLAG_SCOPE, 'isMapsFolder') === true
    );
    if (!folder) {
      folder = await Folder.create({
        name: MAPS_FOLDER_NAME,
        type: 'JournalEntry',
        sorting: 'a',
        flags: { [FLAG_SCOPE]: { isMapsFolder: true } },
      });
      console.debug('Chronicle: Created "Chronicle Maps" folder');
    }
    return folder;
  }

  /**
   * Create or update the JournalEntry materialization for a Chronicle map.
   * Idempotency key: `mapId` flag on a page (not entry name).
   * @param {object} mapData
   * @returns {Promise<JournalEntryPage|null>}
   * @private
   */
  async _materializeMap(mapData) {
    if (!mapData?.id) return null;

    const folder = await this._ensureMapsFolder();
    const meta = this._buildMapMeta(mapData);
    const imageSrc = _mapImageSrc(mapData);

    let page = this.findPageByMapId(mapData.id);

    if (!page) {
      const entry = await JournalEntry.create({
        name: mapData.name || 'Untitled Map',
        folder: folder.id,
        pages: [{
          name: mapData.name || 'Untitled Map',
          type: 'image',
          src: imageSrc,
          flags: {
            [FLAG_SCOPE]: {
              mapId: mapData.id,
              chronicleMapMeta: meta,
            },
          },
        }],
      });
      page = entry?.pages?.contents?.[0] || null;
      console.debug(`Chronicle: Materialized map "${mapData.name}" → JournalEntry ${entry?.id}`);
    } else {
      const updates = {
        [`flags.${FLAG_SCOPE}.chronicleMapMeta`]: meta,
      };
      if (imageSrc && page.src !== imageSrc) updates.src = imageSrc;
      if (page.name !== mapData.name && mapData.name) updates.name = mapData.name;
      await page.update(updates);

      const entry = page.parent;
      if (entry && mapData.name && entry.name !== mapData.name &&
          !entry.name.endsWith('(archived)')) {
        await entry.update({ name: mapData.name });
      }
    }

    return page;
  }

  /**
   * Build the `chronicleMapMeta` page flag from a Chronicle map row.
   * @param {object} mapData
   * @returns {object}
   * @private
   */
  _buildMapMeta(mapData) {
    return {
      id: mapData.id,
      name: mapData.name || '',
      description: mapData.description || '',
      image_id: mapData.image_id || null,
      image_width: mapData.image_width || 0,
      image_height: mapData.image_height || 0,
      background_color: mapData.background_color || '',
      sort_order: mapData.sort_order || 0,
      updated_at: mapData.updated_at || null,
    };
  }

  // ---------------------------------------------------------------------------
  // Sub-resource fetch + cache + flag refresh
  // ---------------------------------------------------------------------------

  /**
   * Fetch all sub-resources for a map and refresh GM cache + page flags.
   * @param {string} mapId
   * @private
   */
  async _refreshSubResources(mapId) {
    if (!this._api || !mapId) return;

    // Fetch in parallel; missing endpoints (404) degrade to empty arrays.
    const [markersR, drawingsR, tokensR, layersR, fogR] = await Promise.all([
      this._api.get(`/maps/${mapId}/markers`).catch(() => null),
      this._api.get(`/maps/${mapId}/drawings`).catch(() => null),
      this._api.get(`/maps/${mapId}/tokens`).catch(() => null),
      this._api.get(`/maps/${mapId}/layers`).catch(() => null),
      this._api.get(`/maps/${mapId}/fog`).catch(() => null),
    ]);

    const markers = this._coerceArray(markersR);
    const drawings = this._coerceArray(drawingsR);
    const tokens = this._coerceArray(tokensR);
    const layers = this._coerceArray(layersR);
    const fog = (fogR && !Array.isArray(fogR)) ? fogR : null;

    const cached = this._cache.get(mapId) || {};
    this._cache.set(mapId, {
      meta: cached.meta || null,
      markers,
      drawings,
      tokens,
      layers,
      fog,
      lastFetched: Date.now(),
    });

    await this._refreshPageFlags(mapId, { markers, drawings, tokens, layers });
  }

  /**
   * Write the player-safe subset of sub-resource data to the JournalEntry
   * page flags. DM-only data is filtered out and stays only in GM memory.
   * @param {string} mapId
   * @param {{ markers: object[], drawings: object[], tokens: object[], layers: object[] }} data
   * @private
   */
  async _refreshPageFlags(mapId, { markers, drawings, tokens, layers }) {
    const page = this.findPageByMapId(mapId);
    if (!page) return;

    const safeMarkers = (markers || []).filter((m) => m?.visibility !== 'dm_only');
    const safeDrawings = (drawings || []).filter(
      (d) => d?.is_visible !== false && d?.is_hidden !== true
    );

    await page.update({
      [`flags.${FLAG_SCOPE}.chronicleMarkers`]: safeMarkers,
      [`flags.${FLAG_SCOPE}.chronicleDrawings`]: safeDrawings,
      [`flags.${FLAG_SCOPE}.chronicleTokens`]: tokens || [],
      [`flags.${FLAG_SCOPE}.chronicleLayers`]: layers || [],
    });
  }

  /**
   * Coerce a Chronicle list response into a plain array.
   * Tolerates `{data: [...]}` wrappers and bare arrays.
   * @param {*} resp
   * @returns {object[]}
   * @private
   */
  _coerceArray(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp.data)) return resp.data;
    return [];
  }

  /**
   * Merge two arrays of sub-resources by `id`, preferring entries from the
   * second source (GM cache) when both contain an item. Used to overlay
   * GM-only items on top of player-safe flag data when rendering for GM.
   * @param {object[]} flagged
   * @param {object[]} cached
   * @returns {object[]}
   * @private
   */
  _mergeById(flagged, cached) {
    if (!cached.length) return flagged.slice();
    const byId = new Map(flagged.map((x) => [x.id, x]));
    for (const c of cached) {
      if (c?.id) byId.set(c.id, c);
    }
    return Array.from(byId.values());
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  /**
   * Start polling sub-resources for a map. Used while at least one viewer
   * is open. Markers are NOT polled — Chronicle emits `marker.*` events.
   * Other types poll until Chronicle ships C-MAP1 event emission.
   * @param {string} mapId
   * @private
   */
  _startPolling(mapId) {
    if (this._pollTimers.has(mapId)) return;

    // TODO(FM-MAP1-WS): remove this entire polling path once Chronicle
    // emits drawing/token/layer/fog events. Markers are already real-time.
    const timer = setInterval(async () => {
      try {
        await this._pollSubResources(mapId);
      } catch (err) {
        console.warn(`Chronicle: Poll failed for map ${mapId}`, err);
      }
    }, POLL_INTERVAL_MS);
    this._pollTimers.set(mapId, timer);
  }

  /** Stop polling a map. */
  _stopPolling(mapId) {
    const timer = this._pollTimers.get(mapId);
    if (timer) {
      clearInterval(timer);
      this._pollTimers.delete(mapId);
    }
  }

  /**
   * Poll only the sub-resource types Chronicle doesn't yet emit events for.
   * @param {string} mapId
   * @private
   */
  async _pollSubResources(mapId) {
    if (!this._api) return;

    const fetches = await Promise.all(
      POLLED_SUBRESOURCES.map((kind) =>
        this._api.get(`/maps/${mapId}/${kind}`).catch(() => null)
      )
    );

    const cached = this._cache.get(mapId) || {};
    const updates = { ...cached };

    fetches.forEach((resp, i) => {
      const kind = POLLED_SUBRESOURCES[i];
      if (resp == null) return;
      if (kind === 'fog') {
        updates.fog = (resp && !Array.isArray(resp)) ? resp : null;
      } else {
        updates[kind] = this._coerceArray(resp);
      }
    });
    updates.lastFetched = Date.now();
    this._cache.set(mapId, updates);

    await this._refreshPageFlags(mapId, {
      markers: cached.markers || [],
      drawings: updates.drawings || [],
      tokens: updates.tokens || [],
      layers: updates.layers || [],
    });

    this._notifyViewers(mapId);
  }

  // ---------------------------------------------------------------------------
  // WebSocket event handlers
  // ---------------------------------------------------------------------------

  /** Materialize a newly created Chronicle map. */
  async _onMapCreated(mapData) {
    if (!mapData?.id) return;
    await this._ensureMapsFolder();
    await this._materializeMap(mapData);
  }

  /** Update map metadata + image on the materialized JournalEntry. */
  async _onMapUpdated(mapData) {
    if (!mapData?.id) return;
    await this._materializeMap(mapData);

    const cached = this._cache.get(mapData.id);
    if (cached) {
      cached.meta = this._buildMapMeta(mapData);
      this._cache.set(mapData.id, cached);
    }
    this._notifyViewers(mapData.id);
  }

  /**
   * On map.deleted: preserve the JournalEntry if local pins exist
   * (`page.flags['chronicle-sync'].pins` non-empty). Otherwise delete it.
   */
  async _onMapDeleted(payload) {
    const mapId = payload?.id || payload;
    if (!mapId) return;

    const page = this.findPageByMapId(mapId);
    if (!page) {
      this._cache.delete(mapId);
      return;
    }

    const entry = page.parent;
    const localPins = page.getFlag(FLAG_SCOPE, 'pins') || [];

    if (localPins.length > 0) {
      // Strip Chronicle linkage; preserve user data.
      await page.update({
        [`flags.${FLAG_SCOPE}.-=mapId`]: null,
        [`flags.${FLAG_SCOPE}.-=chronicleMapMeta`]: null,
        [`flags.${FLAG_SCOPE}.-=chronicleMarkers`]: null,
        [`flags.${FLAG_SCOPE}.-=chronicleDrawings`]: null,
        [`flags.${FLAG_SCOPE}.-=chronicleTokens`]: null,
        [`flags.${FLAG_SCOPE}.-=chronicleLayers`]: null,
      });

      if (entry && !entry.name.endsWith('(archived)')) {
        await entry.update({ name: `${entry.name} (archived)` });
      }

      const archivedName = entry?.name || page.name || 'map';
      ui.notifications.info(
        game.i18n.format('CHRONICLE.MapViewer.MapArchivedNotice', { name: archivedName })
      );
      console.debug(`Chronicle: Archived map ${mapId} (local pins preserved)`);
    } else if (entry) {
      await entry.delete();
      console.debug(`Chronicle: Deleted JournalEntry for removed map ${mapId}`);
    }

    this._cache.delete(mapId);
    this._stopPolling(mapId);
    this._openCounts.delete(mapId);
  }

  /** Marker create/update/delete: refresh GM cache + flag-write player-safe subset. */
  async _onMarkerEvent(_type, payload) {
    const mapId = payload?.map_id;
    if (!mapId) return;
    await this._refreshSubResources(mapId);
    this._notifyViewers(mapId);
  }

  async _onDrawingEvent(_type, payload) {
    const mapId = payload?.map_id;
    if (!mapId) return;
    await this._refreshSubResources(mapId);
    this._notifyViewers(mapId);
  }

  async _onTokenEvent(_type, payload) {
    const mapId = payload?.map_id;
    if (!mapId) return;
    await this._refreshSubResources(mapId);
    this._notifyViewers(mapId);
  }

  async _onLayerEvent(_type, payload) {
    const mapId = payload?.map_id;
    if (!mapId) return;
    await this._refreshSubResources(mapId);
    this._notifyViewers(mapId);
  }

  async _onFogEvent(_type, payload) {
    const mapId = payload?.map_id;
    if (!mapId) return;
    await this._refreshSubResources(mapId);
    this._notifyViewers(mapId);
  }

  /**
   * Fire a Foundry hook so any open MapViewerSheet for the affected map
   * re-renders with fresh data.
   * @param {string} mapId
   * @private
   */
  _notifyViewers(mapId) {
    if (!mapId) return;
    Hooks.callAll('chronicleMapDataChanged', mapId);
  }
}
