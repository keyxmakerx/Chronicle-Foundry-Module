/**
 * Chronicle Sync - Map Sync
 *
 * Orchestrates Chronicle map data into Foundry. Maps materialize as
 * JournalEntries (one entry per map, image-type page, idempotent by
 * `mapId` page flag) inside a "Chronicle Maps" folder; `MapViewerSheet`
 * renders the map with all sub-resources (markers, drawings, tokens, fog,
 * layers) as SVG overlays. Handles Chronicle WebSocket events for `map.*`,
 * `marker.*`, `drawing.*`, `token.*`, `layer.*`, `fog.*`, catches up on
 * connect from the change feed (`_map-feed.mjs`), and provides the marker
 * CRUD helpers MapViewerSheet's edit affordances use.
 *
 * Visibility gate (restricted data must never reach flags, which sync to
 * players): `dm_only` markers/drawings, markers/drawings whose
 * `visibility_rules` narrow them to specific allowed/denied users, hidden
 * (`is_hidden`) tokens, and all fog stay in GM memory only — flags have no
 * per-recipient delivery, so anything written there is readable by every
 * observer regardless of render-time filtering (`_map-flag-filter.mjs`);
 * layers are always flag-stored (names and display settings only, nothing
 * that reveals restricted content).
 *
 * Player-side this module is inert (SyncManager.start exits early for
 * non-GM users, so init() is never called); MapViewerSheet on the
 * player's machine reads only the page flags the GM client wrote.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { _isAllowedImageHost, _describeRejection } from './_url-validation.mjs';
import { parseMapLook, resolveMapLook } from './_map-look.mjs';
import {
  PLAYER_IMAGE_DIR, parsePlayerImageUrl, playerImageFileName,
  shadowSignature,
} from './_map-player-image.mjs';
import { mapsToRefresh } from './_map-feed.mjs';
import {
  playerSafeMapItems,
  shadowAreasOf,
  flagListsToWrite,
  isTokenSafeForPlayerFlags,
} from './_map-flag-filter.mjs';

/** Folder name for materialized Chronicle maps. */
const MAPS_FOLDER_NAME = 'Chronicle Maps';

/**
 * Sheet identifier set on Chronicle-linked image pages via
 * `flags.core.sheetClass`. Format is `<scope>.<className>` matching the
 * `DocumentSheetConfig.registerSheet` call in `module.mjs`. Forcing the
 * sheet class per-page bypasses system-level overrides (e.g., Draw Steel
 * registers its own default image-page sheet, which otherwise wins).
 */
const MAP_VIEWER_SHEET_CLASS = 'chronicle-sync.MapViewerSheet';

/** Maximum entries retained in `_recentErrors` (FIFO). */
const MAX_RECENT_ERRORS = 50;

/** Debounce window for coalescing WS-driven viewer re-renders. */
const NOTIFY_DEBOUNCE_MS = 200;

/** What a failed sub-resource fetch resolves to, unlike Chronicle's `null` for an empty list. */
const FETCH_FAILED = Symbol('fetch failed');

/** Page flag holding each kind of map item, for placing a feed entry on its map. */
const ITEM_FLAGS = Object.freeze({
  marker: 'chronicleMarkers', drawing: 'chronicleDrawings', token: 'chronicleTokens', layer: 'chronicleLayers',
});

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
 * Convert a Chronicle map's image fields to a usable image src for Foundry.
 * Tries full-URL fields first, then relative paths, and finally returns
 * empty if only an `image_id` is available (the caller resolves it via
 * the media metadata endpoint and rewrites this).
 * @param {object} map
 * @returns {string}
 */
function _mapImageSrc(map) {
  if (!map) return '';
  const apiUrl = getSetting('apiUrl');
  // Prefer any full URL Chronicle includes directly — but only if its
  // host matches `apiUrl`. A mismatch is dropped here; the relative-path
  // branch below may still recover.
  for (const field of ['image_url', 'image_path', 'image']) {
    const v = map[field];
    if (typeof v === 'string' && /^https?:/i.test(v)) {
      if (_isAllowedImageHost(v, apiUrl)) return v;
      console.warn(_describeRejection('map_image', v, apiUrl));
    }
  }
  // Relative path (e.g., "/media/foo.png") — prefix with base URL.
  for (const field of ['image_url', 'image_path', 'image']) {
    const v = map[field];
    if (typeof v === 'string' && v.startsWith('/')) {
      const baseUrl = apiUrl?.replace(/\/+$/, '');
      return baseUrl ? `${baseUrl}${v}` : v;
    }
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

    /**
     * Campaign-wide map look from `GET /maps/look` (campaign frame), or
     * null before it loads or on a Chronicle without the route.
     * @type {{ campaignFrame: string, icons: string[] }|null}
     */
    this._look = null;

    /** Pending token-position flag writes keyed by mapId. */
    this._tokenFlagTimers = new Map();

    /** Open-viewer registry: mapId → count of open MapViewerSheets needing data. */
    this._openCounts = new Map();

    /**
     * Cache of resolved media URLs by media id. Chronicle returns signed
     * URLs (`?expires=…&sig=…`) with a ~24h validity window — caching them
     * indefinitely would surface as a broken `page.src` after the expiry
     * on long-running sessions. Entries TTL out at `_mediaUrlCacheTtlMs`
     * so the next `_resolveMediaUrl` call re-fetches `/media/:id`.
     * @type {Map<string, {url: string, cachedAt: number}>}
     */
    this._mediaUrlCache = new Map();

    /** Cache TTL for signed media URLs. 1h — well inside Chronicle's ~24h window. */
    this._mediaUrlCacheTtlMs = 60 * 60 * 1000;

    /**
     * FIFO ring buffer of recent failures, surfaced in the sync dashboard.
     * Each entry: `{kind, mapId, message, status, time}`.
     * @type {Array<{kind: string, mapId: string|null, message: string, status: number|null, time: number}>}
     */
    this._recentErrors = [];

    /** Keys for which we've already shown a once-per-session toast. */
    this._toastsShown = new Set();

    /** Count of maps materialized in the current GM startup. Read by module.mjs. */
    this._materializedThisStartup = 0;

    /** Timestamp (ms) of the last successful initial sync / resync. */
    this._lastSyncAt = null;

    /** Pending debounced viewer-notify timers, keyed by mapId. */
    this._notifyTimers = new Map();

    /**
     * GM-only original picture of each shadowed map. The page carries the
     * player copy; the GM's own viewer shows the original from here.
     * @type {Map<string, {imageId: string|null, url: string}>}
     */
    this._gmImages = new Map();

    /** Last seen shadow signature per map, to notice a shadow edit. */
    this._shadowSigs = new Map();
  }

  // ---------------------------------------------------------------------------
  // Error reporting + status surface
  // ---------------------------------------------------------------------------

  /**
   * Record a failure for surface in the dashboard. Also writes to console
   * so the operator can copy/paste full context.
   * @param {{kind: string, mapId?: string|null, message: string, status?: number|null, error?: Error}} entry
   * @private
   */
  _logError({ kind, mapId = null, message, status = null, error = null }) {
    this._recentErrors.unshift({
      kind,
      mapId,
      message,
      status,
      time: Date.now(),
    });
    if (this._recentErrors.length > MAX_RECENT_ERRORS) {
      this._recentErrors.length = MAX_RECENT_ERRORS;
    }
    const ctx = mapId ? `[map=${mapId}] ` : '';
    if (error) {
      console.warn(`Chronicle MapSync [${kind}] ${ctx}${message}`, error);
    } else {
      console.warn(`Chronicle MapSync [${kind}] ${ctx}${message}`);
    }
  }

  /**
   * Show a `ui.notifications` toast once per session for the given key.
   * Subsequent calls with the same key are no-ops until the GM reloads.
   * @param {string} key - Stable identifier for the toast category.
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   * @private
   */
  _toastOnce(key, level, message) {
    if (this._toastsShown.has(key)) return;
    this._toastsShown.add(key);
    try {
      (ui?.notifications?.[level] || ui?.notifications?.info)?.call(ui.notifications, message);
    } catch {
      /* notifications layer not ready — error already logged via _logError */
    }
  }

  /**
   * Snapshot the current sync status for the dashboard.
   * @returns {{
   *   lastSyncAt: number|null,
   *   materializedCount: number,
   *   errorCount: number,
   *   recentErrors: Array<{kind: string, mapId: string|null, message: string, status: number|null, time: number}>,
   *   openViewers: number,
   * }}
   */
  getSyncStatus() {
    let openViewers = 0;
    for (const n of this._openCounts.values()) openViewers += n;

    let materializedCount = 0;
    for (const entry of game.journal.contents) {
      for (const page of entry.pages.contents) {
        if (page.getFlag(FLAG_SCOPE, 'mapId')) materializedCount++;
      }
    }

    return {
      lastSyncAt: this._lastSyncAt,
      materializedCount,
      errorCount: this._recentErrors.length,
      recentErrors: this._recentErrors.slice(),
      openViewers,
    };
  }

  /** Clear the surfaced error log. Used by the dashboard's "dismiss" action. */
  clearRecentErrors() {
    this._recentErrors = [];
  }

  /**
   * Resolve a Chronicle media id to a fully-qualified image URL.
   * The Chronicle API serves media at `${baseUrl}/media/{filename}` and
   * exposes the relative path through the `url` field of the
   * `/media/:id` metadata endpoint. Results are cached with a TTL so
   * signed URLs don't outlive their `?expires=…` window.
   * @param {string} mediaId
   * @param {{forceFresh?: boolean}} [opts] When `forceFresh` is true the
   *   cache is bypassed and `/media/:id` is re-fetched.
   * @returns {Promise<string>}
   * @private
   */
  async _resolveMediaUrl(mediaId, { forceFresh = false } = {}) {
    if (!mediaId || !this._api) return '';

    if (!forceFresh) {
      const entry = this._mediaUrlCache.get(mediaId);
      if (entry && (Date.now() - entry.cachedAt) < this._mediaUrlCacheTtlMs) {
        return entry.url;
      }
    }

    try {
      const meta = await this._api.get(`/media/${mediaId}`);
      const url = meta?.url || meta?.path || '';
      if (!url) return '';

      const apiUrl = getSetting('apiUrl');
      const baseUrl = apiUrl?.replace(/\/+$/, '');
      let full;
      if (/^https?:/i.test(url)) {
        // Full URL — gate on host match. A mismatch here means Chronicle
        // returned a media URL pointing elsewhere: a misconfigured
        // deployment or a tampered response.
        if (!_isAllowedImageHost(url, apiUrl)) {
          console.warn(_describeRejection('media_url', url, apiUrl));
          return '';
        }
        full = url;
      } else {
        full = baseUrl ? `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}` : url;
      }

      this._mediaUrlCache.set(mediaId, { url: full, cachedAt: Date.now() });
      return full;
    } catch (err) {
      console.warn(`Chronicle: Failed to resolve media ${mediaId}`, err);
      return '';
    }
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
        case 'token.moved':
          await this._onTokenMoved(msg.resourceId, msg.payload); break;

        case 'layer.created':
        case 'layer.updated':
        case 'layer.deleted':
          await this._onLayerEvent(msg.type, msg.payload); break;

        case 'fog.created':
        case 'fog.updated':
        case 'fog.deleted':
          await this._onFogEvent(msg.type, msg.payload); break;
      }
    } catch (err) {
      this._logError({
        kind: 'ws_event',
        mapId: msg?.payload?.map_id || msg?.payload?.id || null,
        message: `Handler failed for ${msg.type}: ${err.message || err}`,
        error: err,
      });
      this._toastOnce(
        'ws_event_error',
        'warn',
        `Chronicle: a real-time map update failed to apply (${msg.type}). See the sync dashboard for details.`
      );
    }
  }

  /** Clear timers and caches on shutdown. */
  destroy() {
    for (const timer of this._tokenFlagTimers.values()) clearTimeout(timer);
    this._tokenFlagTimers.clear();
    for (const timer of this._notifyTimers.values()) clearTimeout(timer);
    this._notifyTimers.clear();
    this._cache.clear();
    this._openCounts.clear();
  }

  /** Change-feed area (see SyncManager._performInitialSync). */
  get feedArea() { return 'maps'; }

  /** Map items are in the feed only on a server that records them. */
  get feedType() { return 'marker'; }

  /** Maps sync only when enabled. */
  feedActive() {
    return !!this._api && !!getSetting('syncMaps');
  }

  /**
   * Initial sync: fetch all Chronicle maps and materialize each as a
   * JournalEntry. Idempotent — re-running matches existing entries by
   * `mapId` page flag, not by name. Chronicle sends no event for a map row
   * itself, so `/maps` is always read. With the change feed, maps whose
   * markers, drawings, tokens, layers or fog changed while Foundry was
   * closed also get their stored items refreshed; a failed refresh throws
   * so the cursor stays and the next connect replays.
   * @param {{feed?: {mode: 'delta'|'full', changes?: object[]}}} [opts]
   */
  async onInitialSync({ feed } = {}) {
    if (!getSetting('syncMaps')) return;
    if (!this._api) return;

    this._materializedThisStartup = 0;
    const result = await this._runMapSync({ verbose: false });
    if (feed?.mode !== 'delta') return result;

    const { mapIds, all } = mapsToRefresh(feed.changes, (type, id) => this._mapOfItem(type, id));
    const targets = all ? this._materializedMapIds() : [...mapIds].filter((id) => this.findPageByMapId(id));
    let failed = 0;
    for (const mapId of targets) {
      const { complete } = await this._refreshSubResources(mapId);
      if (!complete) failed++;
      this._notifyViewers(mapId);
    }
    if (failed) throw new Error(`map catch-up incomplete for ${failed} map(s)`);
    return result;
  }

  /**
   * The map holding a marker, drawing, token or layer this world knows,
   * from the GM cache (GM-only items included) or the stored page flags.
   * @private
   */
  _mapOfItem(type, id) {
    for (const [mapId, c] of this._cache) {
      if ((c?.[`${type}s`] || []).some((x) => String(x?.id) === id)) return mapId;
    }
    const flag = ITEM_FLAGS[type];
    for (const mapId of this._materializedMapIds()) {
      const items = this.findPageByMapId(mapId)?.getFlag(FLAG_SCOPE, flag) || [];
      if (items.some((x) => String(x?.id) === id)) return mapId;
    }
    return null;
  }

  /** Ids of every map with a page in this world. @private */
  _materializedMapIds() {
    const ids = new Set();
    for (const entry of game.journal?.contents || []) {
      for (const page of entry.pages?.contents || []) {
        const id = page.getFlag?.(FLAG_SCOPE, 'mapId');
        if (id) ids.add(id);
      }
    }
    return [...ids];
  }

  /**
   * Fetch + materialize all maps from `/maps`. Shared by `onInitialSync`
   * (silent except for failures) and the dashboard's "Resync All Maps"
   * button (verbose toasts).
   * @param {{verbose: boolean}} [opts]
   * @returns {Promise<{materialized: number, errors: number}>}
   * @private
   */
  async _runMapSync({ verbose = false } = {}) {
    if (verbose) ui.notifications.info('Chronicle: fetching maps…');

    let maps;
    try {
      const result = await this._api.get('/maps');
      maps = Array.isArray(result) ? result : (result?.data || []);
    } catch (err) {
      const status = err?.status || null;
      this._logError({
        kind: 'maps_fetch',
        message: `GET /maps failed (${status || 'network'}): ${err.message || err}`,
        status,
        error: err,
      });
      ui.notifications.error(
        `Chronicle: could not fetch maps from Chronicle${status ? ` (HTTP ${status})` : ''}. Verify apiUrl, apiKey, and campaignId in Module Settings.`
      );
      return { materialized: 0, errors: 1 };
    }

    await this._loadMapLook();

    console.debug(`Chronicle: /maps returned ${maps.length} map(s).`);
    if (maps.length) {
      // Diagnostic: dump the first map so users can confirm which fields
      // Chronicle is actually populating (image_id, image_url, etc.).
      console.debug('Chronicle: sample map row:', maps[0]);
    } else {
      if (verbose) ui.notifications.info('Chronicle: no maps in this campaign.');
      this._lastSyncAt = Date.now();
      return { materialized: 0, errors: 0 };
    }

    await this._ensureMapsFolder();

    let materialized = 0;
    let failures = 0;
    const failureMapNames = [];

    for (const map of maps) {
      try {
        await this._materializeMap(map);
        materialized++;
      } catch (err) {
        failures++;
        failureMapNames.push(map?.name || map?.id || '?');
        this._logError({
          kind: 'materialize',
          mapId: map?.id || null,
          message: `Failed to materialize "${map?.name || map?.id}": ${err.message || err}`,
          error: err,
        });
      }
    }

    this._materializedThisStartup = materialized;
    this._lastSyncAt = Date.now();
    console.debug(`Chronicle: Materialized ${materialized} of ${maps.length} Chronicle map(s)`);

    if (verbose) {
      if (failures > 0) {
        ui.notifications.warn(
          `Chronicle: materialized ${materialized} of ${maps.length} map(s); ${failures} failed. See sync dashboard for details.`
        );
      } else {
        ui.notifications.info(`Chronicle: synced ${materialized} map(s).`);
      }
    } else if (failures > 0) {
      // Silent (initial-sync) path: still surface a single aggregated toast
      // so the operator notices partial materialization.
      ui.notifications.warn(
        `Chronicle: ${failures} of ${maps.length} maps failed to materialize. See sync dashboard.`
      );
    }

    return { materialized, errors: failures };
  }

  /**
   * Backward-compat with SyncManager.runWizardImport: handle "map" mappings
   * during wizard import. No-op — maps materialize from `/maps` directly,
   * not from sync mappings — kept so legacy mappings are ignored gracefully.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (mapping?.chronicle_type !== 'map') return;
    // No-op. Materialization reads from the /maps endpoint, not from
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

    // The GM's own view of a shadowed map shows the original picture.
    const original = this._gmImages.get(mapId);
    const gmMeta = (m) => (original && m ? { ...m, image_url: original.url } : m);

    const cached = this._cache.get(mapId);
    if (!cached) {
      return { meta: gmMeta(meta), markers, drawings, tokens, layers, fog: null };
    }

    return {
      meta: gmMeta(cached.meta || meta),
      markers: this._mergeById(markers, cached.markers || []),
      drawings: this._mergeById(drawings, cached.drawings || []),
      tokens: cached.tokens || tokens,
      layers: cached.layers || layers,
      fog: cached.fog || null,
    };
  }

  /**
   * Notify MapSync that a viewer for this map opened. GM-only — triggers
   * a sub-resource fetch; Chronicle's events keep it current after that.
   * @param {string} mapId
   */
  async onViewerOpen(mapId) {
    if (!game.user.isGM || !this._api || !mapId) return;
    const count = (this._openCounts.get(mapId) || 0) + 1;
    this._openCounts.set(mapId, count);

    if (count === 1) {
      // Re-resolve the image URL up front. Chronicle's media URLs are
      // signed and expire (~24h); the value persisted in `page.src` will
      // 404 on long-running sessions. Refreshing here means each viewer
      // open gets a working URL, and players inherit it via the page
      // update broadcast.
      await this._refreshMapImage(mapId).catch((err) =>
        console.warn(`Chronicle: Image refresh failed for map ${mapId}`, err)
      );
      await this._refreshSubResources(mapId).catch((err) =>
        console.warn(`Chronicle: Sub-resource fetch failed for map ${mapId}`, err)
      );
    }
  }

  /**
   * Force-refresh the persisted image URL for a map. Resolves a new signed
   * URL via `/media/:id` (bypassing the in-memory cache) and updates the
   * page's `src` + `chronicleMapMeta.image_url` if it changed. GM-only.
   * @param {string} mapId
   * @private
   */
  async _refreshMapImage(mapId) {
    if (!game.user.isGM || !this._api || !mapId) return;

    // A shadowed map's original is refreshed in GM memory only; the page
    // keeps the stored player copy.
    const original = this._gmImages.get(mapId);
    if (original?.imageId) {
      const fresh = await this._resolveMediaUrl(original.imageId, { forceFresh: true });
      if (fresh) this._gmImages.set(mapId, { ...original, url: fresh });
      return;
    }

    const page = this.findPageByMapId(mapId);
    if (!page) return;

    const meta = page.getFlag(FLAG_SCOPE, 'chronicleMapMeta') || null;
    if (meta?.player_image) return;
    const mediaId = meta?.image_id;
    if (!mediaId) return;

    const fresh = await this._resolveMediaUrl(mediaId, { forceFresh: true });
    if (!fresh) return;

    const updates = {};
    if (page.src !== fresh) updates.src = fresh;
    if (meta.image_url !== fresh) {
      updates[`flags.${FLAG_SCOPE}.chronicleMapMeta`] = { ...meta, image_url: fresh };
    }
    if (Object.keys(updates).length > 0) {
      await page.update(updates);
    }
  }

  /**
   * Fetch a shadowed map's player copy with the GM key and store it in
   * Foundry, so the page can point at a file that holds no shadowed detail.
   * Already-stored versions are reused.
   * @param {object} mapData map row carrying `player_image_url`
   * @param {JournalEntryPage|null} page
   * @returns {Promise<string>} the stored file's path, or '' on failure.
   * @private
   */
  async _storePlayerImage(mapData, page) {
    const fail = (message, error) => {
      this._logError({ kind: 'player_image', mapId: mapData.id, message, error });
      this._toastOnce(
        `player_image:${mapData.id}`,
        'warn',
        `Chronicle: could not fetch the player picture for map "${mapData.name || mapData.id}". Players see no picture until the next sync brings it.`
      );
      return '';
    };

    const parsed = parsePlayerImageUrl(mapData.player_image_url, getSetting('campaignId'), mapData.id);
    const fileName = parsed && playerImageFileName(mapData.id, parsed.version);
    if (!fileName) return fail(`Map "${mapData.name || mapData.id}" has an unusable player picture address.`);

    const target = `${PLAYER_IMAGE_DIR}/${fileName}`;
    if (typeof page?.src === 'string' && page.src.split('?')[0].endsWith(target)) return page.src;

    try {
      const blob = await this._api.getBlob(parsed.path);
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      for (const dir of ['chronicle-sync', PLAYER_IMAGE_DIR]) {
        // Browse first so an existing folder raises no error toast; the
        // upload below reports a real failure.
        const exists = await FP.browse('data', dir).then(() => true, () => false);
        if (!exists) await FP.createDirectory('data', dir, {}).catch(() => {});
      }
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      const result = await FP.upload('data', PLAYER_IMAGE_DIR, file, {}, { notify: false });
      const path = result?.path;
      if (typeof path !== 'string' || !path) return fail(`Storing the player picture for map ${mapData.id} returned no path.`);
      return path;
    } catch (err) {
      return fail(`Fetching the player picture for map ${mapData.id} failed: ${err.message || err}`, err);
    }
  }

  /**
   * Re-read one map row and re-materialize it, so the page follows a new
   * player copy after a shadow edit.
   * @param {string} mapId
   * @private
   */
  async _refreshMapRow(mapId) {
    if (!this._api || !mapId) return;
    const resp = await this._api.get(`/maps/${mapId}`);
    const mapData = resp?.data || resp;
    if (mapData?.id !== mapId) throw new Error(`GET /maps/${mapId} returned no map`);
    await this._materializeMap(mapData);
  }

  /**
   * Record a map's shadows from a fresh drawing list; when they changed
   * since last seen, the player copy has a new version to fetch.
   * @param {string} mapId
   * @param {object[]} drawings
   * @private
   */
  async _noteShadows(mapId, drawings) {
    const sig = shadowSignature(shadowAreasOf(drawings));
    const prev = this._shadowSigs.get(mapId);
    if (prev === sig) return;
    // First sight with no shadows and no stored copy: the page is current.
    if (prev === undefined && !sig && !this._gmImages.has(mapId)) {
      this._shadowSigs.set(mapId, sig);
      return;
    }
    // Take the picture off the page before the slow fetch, unless it is a
    // copy that may already be current (first sight after a reload).
    const meta = this.findPageByMapId(mapId)?.getFlag(FLAG_SCOPE, 'chronicleMapMeta');
    if (sig && !(prev === undefined && meta?.player_image)) await this._blankPageImage(mapId);
    // Recorded before the re-read, which reads it; put back on failure so
    // the next drawing refresh retries.
    this._shadowSigs.set(mapId, sig);
    try {
      await this._refreshMapRow(mapId);
    } catch (err) {
      if (prev === undefined) this._shadowSigs.delete(mapId);
      else this._shadowSigs.set(mapId, prev);
      this._logError({
        kind: 'player_image',
        mapId,
        message: `Re-reading map ${mapId} after a shadow change failed: ${err.message || err}`,
        error: err,
      });
    }
  }

  /**
   * Remove a map's picture from the page players read, keeping the
   * original only in GM memory.
   * @param {string} mapId
   * @private
   */
  async _blankPageImage(mapId) {
    const page = this.findPageByMapId(mapId);
    if (!page) return;
    const meta = page.getFlag(FLAG_SCOPE, 'chronicleMapMeta') || {};
    if (!this._gmImages.has(mapId) && !meta.player_image && meta.image_url) {
      this._gmImages.set(mapId, { imageId: meta.image_id || null, url: meta.image_url });
    }
    if (page.src === '' && meta.player_image && !meta.image_url) return;
    await page.update({
      src: '',
      [`flags.${FLAG_SCOPE}.chronicleMapMeta`]: { ...meta, image_url: '', image_id: null, player_image: true },
    });
  }

  /** Notify MapSync that a viewer closed. */
  onViewerClose(mapId) {
    if (!mapId) return;
    const count = (this._openCounts.get(mapId) || 0) - 1;
    if (count <= 0) {
      this._openCounts.delete(mapId);
    } else {
      this._openCounts.set(mapId, count);
    }
  }

  /**
   * Re-run a full map sync from `/maps`. GM-only. Verbose by default — fires
   * progress toasts. Powers the dashboard's "Resync All Maps" button.
   * @param {{verbose?: boolean}} [opts]
   * @returns {Promise<{materialized: number, errors: number}>}
   */
  async resyncAll({ verbose = true } = {}) {
    if (!game.user.isGM || !this._api) {
      return { materialized: 0, errors: 0 };
    }
    return this._runMapSync({ verbose });
  }

  /**
   * Re-fetch one map (metadata + sub-resources) and re-materialize. Used
   * by the per-viewer "Resync this map" button. GM-only.
   * @param {string} mapId
   * @returns {Promise<boolean>} `true` if the map was refreshed.
   */
  async resyncOne(mapId) {
    if (!game.user.isGM || !this._api || !mapId) return false;
    try {
      const mapData = await this._api.get(`/maps/${mapId}`);
      const map = mapData?.data || mapData;
      if (!map?.id) {
        ui.notifications.warn(`Chronicle: map ${mapId} not found.`);
        return false;
      }
      await this._materializeMap(map);
      await this._refreshSubResources(mapId);
      this._lastSyncAt = Date.now();
      this._notifyViewers(mapId);
      ui.notifications.info(`Chronicle: resynced "${map.name || mapId}".`);
      return true;
    } catch (err) {
      const status = err?.status || null;
      this._logError({
        kind: 'resync_one',
        mapId,
        message: `Resync failed for ${mapId}: ${err.message || err}`,
        status,
        error: err,
      });
      ui.notifications.error(
        `Chronicle: resync failed for this map${status ? ` (HTTP ${status})` : ''}. See sync dashboard.`
      );
      return false;
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

    // Resolve image URL: prefer direct fields on the map row; fall back to
    // the media metadata endpoint when only `image_id` is present.
    let imageSrc = _mapImageSrc(mapData);
    if (!imageSrc && mapData.image_id) {
      imageSrc = await this._resolveMediaUrl(mapData.image_id);
    }

    let page = this.findPageByMapId(mapData.id);

    // A map with a shadow: the page gets only the stored player copy, and
    // the original stays in GM memory. The copy failing to arrive leaves the
    // previous stored copy, or no picture, never the original.
    // Shadows this client has seen but the row doesn't account for count as
    // shadowed with no copy yet (shadows only exist on servers that send it).
    let shadowed = false;
    const knownShadows = !!this._shadowSigs.get(mapData.id);
    if (mapData.player_image_url || knownShadows) {
      shadowed = true;
      if (imageSrc) this._gmImages.set(mapData.id, { imageId: mapData.image_id || null, url: imageSrc });
      imageSrc = mapData.player_image_url ? await this._storePlayerImage(mapData, page) : '';
    } else {
      this._gmImages.delete(mapData.id);
    }

    const meta = this._buildMapMeta(mapData, imageSrc, { shadowed });

    if (!imageSrc && !shadowed) {
      const reason = mapData.image_id
        ? `media id ${mapData.image_id} did not resolve via /media/:id`
        : (mapData.image_url || mapData.image_path || mapData.image)
          ? 'image fields present but none parsed as a valid URL'
          : 'no image_id, image_url, image_path, or image fields on the map row';
      this._logError({
        kind: 'image_url',
        mapId: mapData.id,
        message: `Map "${mapData.name || mapData.id}" has no resolvable image: ${reason}.`,
      });
      this._toastOnce(
        `image_url:${mapData.id}`,
        'warn',
        `Chronicle: map "${mapData.name || mapData.id}" has no image — check apiUrl setting and that the map has an uploaded image in Chronicle.`
      );
    }

    if (!page) {
      const entry = await JournalEntry.create({
        name: mapData.name || 'Untitled Map',
        folder: folder.id,
        pages: [{
          name: mapData.name || 'Untitled Map',
          type: 'image',
          src: imageSrc,
          flags: {
            // Force the MapViewerSheet for this page so it isn't rendered
            // by the system's default image-page sheet (e.g., Draw Steel
            // overrides JournalEntryPage image rendering at the system
            // level, which made Chronicle-linked pages appear blank).
            core: { sheetClass: MAP_VIEWER_SHEET_CLASS },
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
      if ((imageSrc || shadowed) && page.src !== imageSrc) updates.src = imageSrc;
      if (page.name !== mapData.name && mapData.name) updates.name = mapData.name;
      // Backfill the sheet-class flag on older pages that predate it. Only
      // set it when missing so a user who explicitly switched to a
      // different sheet via Sheet Configuration keeps their choice.
      if (!page.getFlag('core', 'sheetClass')) {
        updates['flags.core.sheetClass'] = MAP_VIEWER_SHEET_CLASS;
      }

      // Reconcile markers/drawings/tokens an older module version wrote
      // into shared flags before these filters existed (or before they
      // covered this kind). Every full sync (GM login, "Resync All Maps")
      // re-checks the stored flags, not just new writes, so restricted
      // data already on a player's client is removed instead of waiting
      // for a viewer-open or a live event to clean it up.
      // Shadows come from the stored drawings: an older module wrote visible
      // shadow drawings into flags alongside the pins they cover. Pins under
      // a GM-only shadow are caught by the full refresh that follows.
      const storedMarkers = page.getFlag(FLAG_SCOPE, 'chronicleMarkers') || [];
      const storedDrawings = page.getFlag(FLAG_SCOPE, 'chronicleDrawings') || [];
      const stored = playerSafeMapItems(storedMarkers, storedDrawings);
      if (stored.markers.length !== storedMarkers.length) {
        updates[`flags.${FLAG_SCOPE}.chronicleMarkers`] = stored.markers;
      }
      if (stored.drawings.length !== storedDrawings.length) {
        updates[`flags.${FLAG_SCOPE}.chronicleDrawings`] = stored.drawings;
      }

      const storedTokens = page.getFlag(FLAG_SCOPE, 'chronicleTokens') || [];
      const safeStoredTokens = storedTokens.filter(isTokenSafeForPlayerFlags);
      if (safeStoredTokens.length !== storedTokens.length) {
        updates[`flags.${FLAG_SCOPE}.chronicleTokens`] = safeStoredTokens;
      }

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
   * Chronicle's marker icon catalog from the last `GET /maps/look`, for the
   * marker window's picker. Empty on an older Chronicle without the route.
   * @returns {{id: string, label: string, category: string}[]}
   */
  getIconCatalog() {
    return this._look?.iconCatalog || [];
  }

  /**
   * Fetch the campaign map look. Cosmetic: a failure (or an older Chronicle
   * without the route) keeps the last answer and is only logged.
   * @private
   */
  async _loadMapLook() {
    try {
      const look = parseMapLook(await this._api.get('/maps/look'));
      if (look) this._look = look;
    } catch (err) {
      if (err?.status !== 404) {
        console.warn(`Chronicle: GET /maps/look failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * Build the `chronicleMapMeta` page flag from a Chronicle map row.
   * `imageSrc` is the resolved URL (already through `_resolveMediaUrl` on
   * GM); persisting it on the flag means players never need to re-resolve.
   * A shadowed map's meta carries no media id, so nothing re-resolves the
   * original into the flags players read.
   * @param {object} mapData
   * @param {string} [imageSrc]
   * @param {{shadowed?: boolean}} [opts]
   * @returns {object}
   * @private
   */
  _buildMapMeta(mapData, imageSrc = '', { shadowed = false } = {}) {
    return {
      // How Chronicle draws this map, resolved here so player clients read
      // it from the page without the campaign settings.
      look: resolveMapLook(mapData.display_settings, this._look?.campaignFrame),
      id: mapData.id,
      name: mapData.name || '',
      description: mapData.description || '',
      image_id: shadowed ? null : (mapData.image_id || null),
      player_image: shadowed,
      // imageSrc is already the host-validated, fully-resolved URL from
      // `_mapImageSrc` / `_resolveMediaUrl`. Never fall back to the raw
      // `mapData.image_url`/`image_path` here — that would bypass the
      // host check and re-introduce a rejected URL.
      image_url: imageSrc || '',
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
    if (!this._api || !mapId) return { complete: false };
    let failures = 0;

    // Fetch in parallel. Each `.catch` records to `_recentErrors` so a
    // failing endpoint surfaces in the dashboard instead of silently
    // degrading to `[]`. 404 is logged but not surfaced as a toast (the
    // endpoint legitimately may not yet exist on the Chronicle side).
    const sub = (kind) => this._api
      .get(`/maps/${mapId}/${kind}`)
      .catch((err) => {
        const status = err?.status || null;
        if (status !== 404) {
          failures++;
          this._logError({
            kind: `subresource:${kind}`,
            mapId,
            message: `GET /maps/${mapId}/${kind} failed${status ? ` (${status})` : ''}: ${err.message || err}`,
            status,
            error: err,
          });
        }
        return FETCH_FAILED;
      });

    const [markersR, drawingsR, tokensR, layersR, fogR] = await Promise.all([
      sub('markers'),
      sub('drawings'),
      sub('tokens'),
      sub('layers'),
      sub('fog'),
    ]);

    // Chronicle answers an empty list as `null`, which is a known (empty)
    // list; only a failed fetch leaves the drawings, and so the shadows,
    // unknown.
    const drawingsKnown = drawingsR !== FETCH_FAILED;
    const cached = this._cache.get(mapId) || {};
    // A failed list keeps the GM cache's last copy; the player copy is left
    // alone below.
    const list = (r, kind) => (r === FETCH_FAILED
      ? (Array.isArray(cached[kind]) ? cached[kind] : [])
      : this._coerceArray(r));
    const markers = list(markersR, 'markers');
    const drawings = list(drawingsR, 'drawings');
    const tokens = list(tokensR, 'tokens');
    const layers = list(layersR, 'layers');
    const fog = (fogR !== FETCH_FAILED && fogR && !Array.isArray(fogR)) ? fogR : (fogR === FETCH_FAILED ? (cached.fog ?? null) : null);

    this._cache.set(mapId, {
      meta: cached.meta || null,
      markers,
      drawings,
      tokens,
      layers,
      fog,
      drawingsKnown,
      lastFetched: Date.now(),
    });

    // Without the drawing list the shadow areas are unknown, so markers and
    // drawings in the player copy are left as they were rather than
    // rewritten from data that might sit under a shadow.
    await this._refreshPageFlags(mapId, {
      markers, drawings, tokens, layers, drawingsKnown,
      markersKnown: markersR !== FETCH_FAILED,
      tokensKnown: tokensR !== FETCH_FAILED,
      layersKnown: layersR !== FETCH_FAILED,
    });
    if (drawingsKnown) await this._noteShadows(mapId, drawings);
    return { complete: failures === 0 };
  }

  /**
   * Write the player-safe subset of sub-resource data to the JournalEntry
   * page flags. DM-only, per-user-restricted, hidden and shadowed data is
   * filtered out (`_map-flag-filter.mjs`) and stays only in GM memory.
   * Layers carry no restricted content (names and display settings only)
   * and are written through unfiltered.
   * @param {string} mapId
   * @param {{ markers: object[], drawings: object[], tokens: object[], layers: object[], drawingsKnown?: boolean }} data
   *   `drawingsKnown: false` (the drawing fetch failed) leaves the stored
   *   markers and drawings untouched, since shadows can't be applied.
   *   `markersKnown`/`tokensKnown`/`layersKnown: false` likewise leave that
   *   stored list untouched.
   * @private
   */
  async _refreshPageFlags(mapId, { markers, drawings, tokens, layers, drawingsKnown = true, markersKnown = true, tokensKnown = true, layersKnown = true }) {
    const page = this.findPageByMapId(mapId);
    if (!page) return;

    const write = flagListsToWrite({
      markers: markersKnown, drawings: drawingsKnown, tokens: tokensKnown, layers: layersKnown,
    });
    const updates = {};
    if (write.tokens) updates[`flags.${FLAG_SCOPE}.chronicleTokens`] = (tokens || []).filter(isTokenSafeForPlayerFlags);
    if (write.layers) updates[`flags.${FLAG_SCOPE}.chronicleLayers`] = layers || [];
    if (write.markers || write.drawings) {
      const safe = playerSafeMapItems(markers, drawings);
      if (write.markers) updates[`flags.${FLAG_SCOPE}.chronicleMarkers`] = safe.markers;
      if (write.drawings) updates[`flags.${FLAG_SCOPE}.chronicleDrawings`] = safe.drawings;
    }
    if (Object.keys(updates).length) await page.update(updates);
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
  // WebSocket event handlers
  // ---------------------------------------------------------------------------

  /** Materialize a newly created Chronicle map. */
  async _onMapCreated(mapData) {
    if (!mapData?.id) return;
    await this._ensureMapsFolder();
    const row = await this._withPlayerImageField(mapData);
    if (row) await this._materializeMap(row);
  }

  /**
   * Event payloads may not carry `player_image_url`; trusting that absence
   * would point players at the original of a shadowed map. Re-read the row
   * from the sync API, which sets it whenever the map has a shadow.
   * @param {object} mapData
   * @returns {Promise<object|null>} null when the re-read failed: the event
   *   is skipped, and the next full sync applies it.
   * @private
   */
  async _withPlayerImageField(mapData) {
    if (mapData.player_image_url || !this._api) return mapData;
    try {
      const resp = await this._api.get(`/maps/${mapData.id}`);
      const row = resp?.data || resp;
      if (row?.id === mapData.id) return row;
    } catch (err) {
      console.warn(`Chronicle: re-reading map ${mapData.id} failed`, err);
    }
    return null;
  }

  /** Update map metadata + image on the materialized JournalEntry. */
  async _onMapUpdated(mapData) {
    if (!mapData?.id) return;
    const row = await this._withPlayerImageField(mapData);
    if (!row) return;
    await this._materializeMap(row);

    // Pull the freshly-written meta (with resolved image URL) from the page
    // and mirror it into the cache so GM render reuses it.
    const page = this.findPageByMapId(mapData.id);
    const meta = page?.getFlag(FLAG_SCOPE, 'chronicleMapMeta') || null;
    const cached = this._cache.get(mapData.id);
    if (cached) {
      cached.meta = meta;
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

  /**
   * A token drag sends only `{x, y}` keyed by token id, many per drag. The
   * position is patched into the cached token of whichever map holds it and
   * the player-safe token flag is rewritten once the drag settles. A token
   * not in the cache belongs to a map no viewer has loaded since connect;
   * its stored positions catch up at the next viewer open or connect.
   * @private
   */
  async _onTokenMoved(tokenId, payload) {
    if (!tokenId || !Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return;
    for (const [mapId, c] of this._cache) {
      const token = (c?.tokens || []).find((t) => String(t?.id) === String(tokenId));
      if (!token) continue;
      token.x = payload.x;
      token.y = payload.y;
      this._scheduleTokenFlags(mapId);
      this._notifyViewers(mapId);
      return;
    }
  }

  /** Debounced write of a map's player-safe tokens from the cache. @private */
  _scheduleTokenFlags(mapId) {
    clearTimeout(this._tokenFlagTimers.get(mapId));
    this._tokenFlagTimers.set(mapId, setTimeout(() => {
      this._tokenFlagTimers.delete(mapId);
      const page = this.findPageByMapId(mapId);
      const tokens = this._cache.get(mapId)?.tokens || [];
      page?.update({ [`flags.${FLAG_SCOPE}.chronicleTokens`]: tokens.filter(isTokenSafeForPlayerFlags) })
        .catch((err) => console.warn(`Chronicle: token positions not saved for map ${mapId}`, err));
    }, NOTIFY_DEBOUNCE_MS));
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
   * re-renders with fresh data. Debounced per-mapId so a burst of WS
   * events (e.g. drag of a token producing rapid `*.updated`) collapses
   * to one render.
   * @param {string} mapId
   * @private
   */
  _notifyViewers(mapId) {
    if (!mapId) return;
    const existing = this._notifyTimers.get(mapId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._notifyTimers.delete(mapId);
      Hooks.callAll('chronicleMapDataChanged', mapId);
    }, NOTIFY_DEBOUNCE_MS);
    this._notifyTimers.set(mapId, timer);
  }
}
