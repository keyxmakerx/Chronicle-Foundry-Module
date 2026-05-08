/**
 * Chronicle Sync - Interactive Map Viewer Journal Page (FM-MAP1, Path B)
 *
 * Custom JournalPageSheet for image-type pages that renders both local
 * journal-flag pins and Chronicle map data (markers, drawings, tokens,
 * fog, layers). Two pin systems coexist on the same SVG/DOM surface:
 *
 *   - Local pins: stored in `flags.chronicle-sync.pins` on the page; not
 *     synced to Chronicle. Visual: dotted outline. Tooltip: "Personal
 *     annotation".
 *   - Chronicle markers: pulled from Chronicle via MapSync; rendered from
 *     `flags.chronicle-sync.chronicleMarkers` (player-safe subset written
 *     by the GM client) plus GM-only memory data. Visual: solid fill.
 *     Tooltip: "Chronicle marker".
 *
 * Visibility filtering happens at render time:
 *   - `visibility=dm_only` markers and the entire fog overlay never render
 *     for non-GMs (they are absent from the flag data; GM-only memory
 *     supplies them only on the GM client).
 *   - `visibility_rules.allowed_users` / `denied_users` are honored
 *     against the current user's mapped Chronicle user id.
 *
 * Phase A is read-only for drawings, tokens, fog, and layers; markers stay
 * editable (with a visibility=dm_only checkbox) for GM users via the
 * existing right-click and toolbar affordances.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { PIN_ICONS } from './map-sync.mjs';
import { getUserMappings } from './settings.mjs';

/* ============================================================
   Constants
   ============================================================ */

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.15;

/**
 * Extended pin types for the local-pin viewer. Inherits the 5 canonical
 * categories from PIN_ICONS and adds a text-only label type. Local pins
 * use these icons; Chronicle markers reuse the same five canonical
 * categories (text is local-only).
 */
const VIEWER_PIN_TYPES = {
  ...PIN_ICONS,
  text: { icon: 'icons/svg/scroll.svg', color: '#e2e8f0', faIcon: 'fa-font' },
};

/** Chronicle marker pin categories (the five shared with PIN_ICONS). */
const CHRONICLE_MARKER_CATEGORIES = ['location', 'danger', 'treasure', 'quest', 'note'];

/** Chronicle marker visibility values. */
const VISIBILITY_VALUES = ['everyone', 'dm_only'];

/* ============================================================
   Helpers
   ============================================================ */

/**
 * Locate the running MapSync module instance, if any. Returns null on
 * non-GM clients (where SyncManager.start exits early), or before the
 * module is ready.
 * @returns {object|null}
 */
function _getMapSync() {
  const mod = game.modules.get(MODULE_ID);
  const syncManager = mod?.api?.syncManager;
  if (!syncManager?._modules) return null;
  return syncManager._modules.find((m) => m.constructor?.name === 'MapSync') || null;
}

/**
 * Find the Chronicle user id mapped to the current Foundry user.
 * Reads from world settings, so it works on both GM and player clients.
 * @returns {string|null}
 */
function _currentChronicleUserId() {
  const mappings = getUserMappings();
  for (const [chronicleId, foundryId] of Object.entries(mappings || {})) {
    if (foundryId === game.user.id) return chronicleId;
  }
  return null;
}

/**
 * Visibility filter for a Chronicle marker. Honors `visibility=dm_only`
 * AND the per-user `visibility_rules.allowed_users` / `denied_users`.
 * @param {object} marker
 * @param {boolean} isGM
 * @param {string|null} chronicleUserId
 * @returns {boolean}
 */
function _userCanSeeMarker(marker, isGM, chronicleUserId) {
  if (!marker) return false;
  if (marker.visibility === 'dm_only') return isGM;

  const rules = marker.visibility_rules;
  if (!rules || typeof rules !== 'object') return true;
  // GM always sees regardless of rules (defense-in-depth on top of dm_only check).
  if (isGM) return true;

  const denied = Array.isArray(rules.denied_users) ? rules.denied_users : null;
  if (denied && chronicleUserId && denied.includes(chronicleUserId)) return false;

  const allowed = Array.isArray(rules.allowed_users) ? rules.allowed_users : null;
  if (allowed && allowed.length > 0) {
    return chronicleUserId ? allowed.includes(chronicleUserId) : false;
  }
  return true;
}

/** Cap a hex color to the standard `#RRGGBB[AA]` shape; strips dangerous chars. */
function _safeColor(value, fallback = '#888888') {
  if (typeof value !== 'string') return fallback;
  const m = value.match(/^#([0-9a-fA-F]{3,8})$/);
  return m ? `#${m[1]}` : fallback;
}

/* ============================================================
   MapViewerSheet — Custom JournalPageSheet for image pages
   ============================================================ */

/**
 * Interactive map viewer rendered inside a JournalEntryPage. Supports
 * pan/zoom, local-pin placement, Chronicle marker rendering with
 * visibility filtering, and read-only overlays for Chronicle drawings,
 * tokens, fog, and layers.
 */
export class MapViewerSheet extends JournalPageSheet {

  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['chronicle-map-viewer-sheet'],
      template: 'modules/chronicle-sync/templates/map-viewer.hbs',
      width: 740,
      height: 600,
      submitOnChange: false,
    });
  }

  constructor(...args) {
    super(...args);

    // View state (not persisted — resets on re-open).
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._showLabels = true;
    /** @type {string|null} Active placement tool: a pin-type key or 'chronicle-marker'. */
    this._activeTool = null;
    this._isPanning = false;
    this._panStart = null;

    // Pin drag state (local pins; Chronicle markers are not draggable in Phase A).
    this._draggingPin = null;
    this._dragOffset = null;

    // Bound handlers for cleanup.
    this._boundSocketHandler = this._onSocketMessage.bind(this);
    this._boundDataChangedHandler = this._onChronicleDataChanged.bind(this);
  }

  /* ----------------------------------------------------------
     Data
     ---------------------------------------------------------- */

  /** @override */
  async getData(options = {}) {
    const data = await super.getData(options);

    const mapId = this.document.getFlag(FLAG_SCOPE, 'mapId') || null;
    const isGM = game.user.isGM;
    const userChronicleId = _currentChronicleUserId();

    // ----- Local pins (existing system, unchanged) -----
    const allLocalPins = this.document.getFlag(FLAG_SCOPE, 'pins') || [];
    const visibleLocalPins = isGM ? allLocalPins : allLocalPins.filter((p) => p.shared !== false);
    const localPins = visibleLocalPins.map((pin) => {
      const style = VIEWER_PIN_TYPES[pin.type] || VIEWER_PIN_TYPES.note;
      return {
        ...pin,
        faIcon: style.faIcon,
        color: style.color,
        kind: 'local',
        sharedLabel: pin.shared === false
          ? game.i18n.localize('CHRONICLE.MapViewer.LocalPinGmOnly')
          : game.i18n.localize('CHRONICLE.MapViewer.LocalPinShared'),
      };
    });

    // ----- Chronicle map data -----
    const mapSync = _getMapSync();
    const mapData = mapSync && mapId
      ? mapSync.getMapData(this.document)
      : this._readChronicleFromFlags();

    const meta = mapData?.meta || null;
    const layersById = new Map(
      (mapData?.layers || []).map((l) => [l.id, l])
    );

    // Visibility-filter markers; render-time enforcement of dm_only and rules.
    const filteredMarkers = (mapData?.markers || []).filter(
      (m) => _userCanSeeMarker(m, isGM, userChronicleId)
    );

    // Annotate markers for the template.
    const chronicleMarkers = filteredMarkers.map((m) => {
      const category = CHRONICLE_MARKER_CATEGORIES.includes(m.pin_category)
        ? m.pin_category : 'note';
      const style = PIN_ICONS[category];
      const audience = m.visibility === 'dm_only'
        ? game.i18n.localize('CHRONICLE.MapViewer.MarkerAudienceDm')
        : game.i18n.localize('CHRONICLE.MapViewer.MarkerAudienceEveryone');
      return {
        id: m.id,
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
        label: m.name || '',
        description: m.description || '',
        category,
        faIcon: style.faIcon,
        color: _safeColor(m.color, style.color),
        visibility: m.visibility || 'everyone',
        isDmOnly: m.visibility === 'dm_only',
        audienceLabel: audience,
        entityId: m.entity_id || null,
      };
    });

    // Drawings: filter is_visible / is_hidden (defense-in-depth — flag data
    // already has hidden ones removed for non-GM).
    const drawings = (mapData?.drawings || [])
      .filter((d) => d?.is_visible !== false && (isGM || d?.is_hidden !== true))
      .map((d) => this._prepareDrawing(d, layersById));

    // Sort drawings by layer sort_order, then by their own sort if any.
    drawings.sort((a, b) => (a._layerOrder ?? 0) - (b._layerOrder ?? 0));

    // Tokens: render all (no per-user vis in schema).
    const tokens = (mapData?.tokens || []).map((t) => this._prepareToken(t, layersById));
    tokens.sort((a, b) => (a._layerOrder ?? 0) - (b._layerOrder ?? 0));

    // Fog of war: GM only. Players never receive the data (it lives in GM
    // memory only, never written to flags), but defense-in-depth here too.
    const fog = isGM ? mapData?.fog || null : null;

    // ----- Pin types for the toolbar -----
    const pinTypes = {};
    for (const [key, val] of Object.entries(VIEWER_PIN_TYPES)) {
      pinTypes[key] = {
        ...val,
        label: game.i18n.localize(`CHRONICLE.MapViewer.PinTypes.${key}`),
      };
    }

    // ----- Image src: prefer the resolved Chronicle URL on the meta flag
    //                  (written by GM via map-sync), else any direct URL on
    //                  meta, else fall back to the page's own src. -----
    const src = mapId
      ? this._mapImageSrc(meta) || this.document.src
      : this.document.src;

    return {
      ...data,
      pageId: this.document.id,
      src,
      mapId,
      hasChronicleMap: !!mapId,
      chronicleEditUrl: mapId ? mapSync?.getChronicleMapUrl?.(mapId) || null : null,
      isGM,
      pinTypes,
      localPins,
      chronicleMarkers,
      drawings,
      tokens,
      fog,
      hasFog: !!fog,
      showLabels: this._showLabels,
      zoomPercent: Math.round(this._zoom * 100),
    };
  }

  /**
   * Resolve a map image src from the cached meta. The GM client writes the
   * fully-resolved URL into `meta.image_url` during materialization, so
   * players can read it without an extra API call. Relative URLs are
   * prefixed with the configured Chronicle base URL.
   * @param {object} meta
   * @returns {string}
   * @private
   */
  _mapImageSrc(meta) {
    if (!meta) return '';
    const baseUrl = (game.settings.get(MODULE_ID, 'apiUrl') || '').replace(/\/+$/, '');
    for (const field of ['image_url', 'image_path', 'image']) {
      const v = meta[field];
      if (typeof v !== 'string' || !v) continue;
      if (/^https?:/i.test(v)) return v;
      if (v.startsWith('/')) return baseUrl ? `${baseUrl}${v}` : v;
    }
    return '';
  }

  /**
   * Read Chronicle map data straight from the page flags. Used on player
   * clients where MapSync is inert.
   * @returns {object}
   * @private
   */
  _readChronicleFromFlags() {
    const doc = this.document;
    return {
      meta: doc.getFlag(FLAG_SCOPE, 'chronicleMapMeta') || null,
      markers: doc.getFlag(FLAG_SCOPE, 'chronicleMarkers') || [],
      drawings: doc.getFlag(FLAG_SCOPE, 'chronicleDrawings') || [],
      tokens: doc.getFlag(FLAG_SCOPE, 'chronicleTokens') || [],
      layers: doc.getFlag(FLAG_SCOPE, 'chronicleLayers') || [],
      fog: null,
    };
  }

  /**
   * Convert a Chronicle drawing row into a render-ready descriptor for the
   * SVG overlay. Coordinates are 0–100 percentages; the SVG viewBox matches.
   * @param {object} d
   * @param {Map<string, object>} layersById
   * @returns {object}
   * @private
   */
  _prepareDrawing(d, layersById) {
    const layer = d.layer_id ? layersById.get(d.layer_id) : null;
    const points = Array.isArray(d.points) ? d.points : [];
    const stroke = _safeColor(d.stroke_color, '#ffffff');
    const fill = _safeColor(d.fill_color, '#ffffff');
    const fillAlpha = typeof d.fill_alpha === 'number' ? Math.max(0, Math.min(1, d.fill_alpha)) : 0.3;
    const strokeWidth = typeof d.stroke_width === 'number' ? Math.max(0.1, d.stroke_width) : 1;

    const out = {
      id: d.id,
      type: d.drawing_type || 'rectangle',
      stroke,
      fill,
      fillAlpha,
      strokeWidth,
      isHidden: d.is_hidden === true,
      _layerOrder: layer?.sort_order ?? 0,
    };

    switch (out.type) {
      case 'rectangle':
      case 'ellipse': {
        if (points.length < 2) return null;
        const [a, b] = points;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(a.x - b.x);
        const h = Math.abs(a.y - b.y);
        out.x = x; out.y = y; out.w = w; out.h = h;
        out.cx = x + w / 2; out.cy = y + h / 2;
        out.rx = w / 2; out.ry = h / 2;
        return out;
      }
      case 'line': {
        if (points.length < 2) return null;
        out.x1 = points[0].x; out.y1 = points[0].y;
        out.x2 = points[1].x; out.y2 = points[1].y;
        return out;
      }
      case 'polygon':
      case 'freehand': {
        if (points.length < 2) return null;
        out.pointsAttr = points.map((p) => `${p.x},${p.y}`).join(' ');
        out.closed = out.type === 'polygon';
        return out;
      }
      default:
        return null;
    }
  }

  /**
   * Render-ready token descriptor.
   * @param {object} t
   * @param {Map<string, object>} layersById
   * @returns {object}
   * @private
   */
  _prepareToken(t, layersById) {
    const layer = t.layer_id ? layersById.get(t.layer_id) : null;
    const size = typeof t.size === 'number' ? Math.max(1, Math.min(40, t.size)) : 4;
    const max = Number(t.max_hp) || 0;
    const cur = Number(t.current_hp) || 0;
    const hpPct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : null;
    return {
      id: t.id,
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      size,
      image: t.image || t.image_url || '',
      name: t.name || '',
      max_hp: max,
      current_hp: cur,
      hpPercent: hpPct,
      hasHp: hpPct !== null,
      _layerOrder: layer?.sort_order ?? 0,
    };
  }

  /* ----------------------------------------------------------
     Listeners
     ---------------------------------------------------------- */

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    const el = html[0] ?? html;
    const viewer = el.closest('.chronicle-map-viewer') ?? el.querySelector('.chronicle-map-viewer');
    if (!viewer) return;

    this._viewer = viewer;
    this._viewport = viewer.querySelector('.map-viewport');
    this._container = viewer.querySelector('.map-container');
    this._pinLayer = viewer.querySelector('.pin-layer');
    this._markerLayer = viewer.querySelector('.chronicle-marker-layer');
    this._applyTransform();

    // Notify MapSync so it can fetch/refresh sub-resources and start polling.
    const mapId = this.document.getFlag(FLAG_SCOPE, 'mapId');
    if (mapId) {
      const mapSync = _getMapSync();
      mapSync?.onViewerOpen?.(mapId).catch(() => {});
    }

    // ---- Toolbar: local pin tools ----
    viewer.querySelectorAll('.pin-tool-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const type = btn.dataset.pinType;
        this._setActiveTool(this._activeTool === type ? null : type);
      });
    });

    // ---- Toolbar: Chronicle marker placement (GM only) ----
    const markerBtn = viewer.querySelector('[data-action="place-chronicle-marker"]');
    if (markerBtn) {
      markerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this._setActiveTool(this._activeTool === 'chronicle-marker' ? null : 'chronicle-marker');
      });
    }

    // ---- Toolbar: view tools ----
    viewer.querySelectorAll('.view-tool-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'zoom-in') this._zoomBy(ZOOM_STEP);
        else if (action === 'zoom-out') this._zoomBy(-ZOOM_STEP);
        else if (action === 'zoom-reset') this._resetView();
        else if (action === 'fit-view') this._fitToView();
        else if (action === 'toggle-labels') this._toggleLabels();
      });
    });

    // ---- Viewport: zoom (mouse wheel) ----
    this._viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      this._zoomAt(delta, e.clientX, e.clientY);
    }, { passive: false });

    // ---- Viewport: pan + placement ----
    this._viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Defer to pin-layer / marker-layer handlers when clicking on a pin/marker.
      if (e.target.closest('.map-pin') || e.target.closest('.chronicle-marker')) return;

      if (this._activeTool === 'chronicle-marker') {
        e.preventDefault();
        this._beginChronicleMarkerPlacement(e);
      } else if (this._activeTool) {
        e.preventDefault();
        this._placeLocalPin(e);
      } else {
        e.preventDefault();
        this._isPanning = true;
        this._panStart = { x: e.clientX - this._panX, y: e.clientY - this._panY };
        this._viewport.classList.add('panning');
      }
    });

    document.addEventListener('mousemove', this._onMouseMove = (e) => {
      if (this._isPanning) {
        this._panX = e.clientX - this._panStart.x;
        this._panY = e.clientY - this._panStart.y;
        this._applyTransform();
      } else if (this._draggingPin) {
        this._onPinDragMove(e);
      }
    });

    document.addEventListener('mouseup', this._onMouseUp = (e) => {
      if (this._isPanning) {
        this._isPanning = false;
        this._panStart = null;
        this._viewport.classList.remove('panning');
      }
      if (this._draggingPin) {
        this._onPinDragEnd(e);
      }
    });

    // ---- Local pin interactions ----
    if (this._pinLayer) {
      this._pinLayer.addEventListener('mousedown', (e) => {
        const pinEl = e.target.closest('.map-pin');
        if (!pinEl || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._onPinDragStart(pinEl, e);
      });

      this._pinLayer.addEventListener('contextmenu', (e) => {
        const pinEl = e.target.closest('.map-pin');
        if (!pinEl) return;
        e.preventDefault();
        this._openPinConfig(pinEl.dataset.pinId);
      });

      this._pinLayer.addEventListener('dblclick', (e) => {
        const pinEl = e.target.closest('.map-pin');
        if (!pinEl) return;
        e.preventDefault();
        this._onPinDoubleClick(pinEl.dataset.pinId);
      });
    }

    // ---- Chronicle marker interactions ----
    if (this._markerLayer) {
      this._markerLayer.addEventListener('contextmenu', (e) => {
        const markerEl = e.target.closest('.chronicle-marker');
        if (!markerEl) return;
        e.preventDefault();
        if (!game.user.isGM) return; // Players cannot edit Chronicle markers in Phase A.
        this._openChronicleMarkerConfig(markerEl.dataset.markerId);
      });

      this._markerLayer.addEventListener('dblclick', (e) => {
        const markerEl = e.target.closest('.chronicle-marker');
        if (!markerEl) return;
        e.preventDefault();
        this._onChronicleMarkerDoubleClick(markerEl.dataset.markerId);
      });
    }

    // ---- Foundry socket sync (local pins only) ----
    game.socket.on(SOCKET_CHANNEL, this._boundSocketHandler);

    // ---- Hook for Chronicle data changes (re-render when WS events arrive) ----
    Hooks.on('chronicleMapDataChanged', this._boundDataChangedHandler);
  }

  /** @override */
  close(options) {
    if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseUp) document.removeEventListener('mouseup', this._onMouseUp);
    game.socket.off(SOCKET_CHANNEL, this._boundSocketHandler);
    Hooks.off('chronicleMapDataChanged', this._boundDataChangedHandler);

    const mapId = this.document.getFlag(FLAG_SCOPE, 'mapId');
    if (mapId) {
      const mapSync = _getMapSync();
      mapSync?.onViewerClose?.(mapId);
    }

    return super.close(options);
  }

  /**
   * Re-render when Chronicle data for the open map changes.
   * @param {string} mapId
   * @private
   */
  _onChronicleDataChanged(mapId) {
    const ourMapId = this.document.getFlag(FLAG_SCOPE, 'mapId');
    if (ourMapId && ourMapId === mapId) {
      this.render(false);
    }
  }

  /* ----------------------------------------------------------
     Zoom / Pan
     ---------------------------------------------------------- */

  _applyTransform() {
    if (!this._container) return;
    this._container.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;

    const indicator = this._viewer?.querySelector('.zoom-indicator');
    if (indicator) indicator.textContent = `${Math.round(this._zoom * 100)}%`;
  }

  _zoomBy(delta) {
    this._zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this._zoom + delta));
    this._applyTransform();
  }

  _zoomAt(delta, clientX, clientY) {
    const oldZoom = this._zoom;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom + delta));
    if (newZoom === oldZoom) return;

    const rect = this._viewport.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    const ratio = newZoom / oldZoom;
    this._panX = mouseX - ratio * (mouseX - this._panX);
    this._panY = mouseY - ratio * (mouseY - this._panY);
    this._zoom = newZoom;
    this._applyTransform();
  }

  _resetView() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._applyTransform();
  }

  _fitToView() {
    const img = this._viewer?.querySelector('.map-image');
    if (!img || !this._viewport) return;

    const vpRect = this._viewport.getBoundingClientRect();
    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    if (!imgW || !imgH) return;

    const scaleX = vpRect.width / imgW;
    const scaleY = vpRect.height / imgH;
    this._zoom = Math.min(scaleX, scaleY, ZOOM_MAX);
    this._panX = (vpRect.width - imgW * this._zoom) / 2;
    this._panY = (vpRect.height - imgH * this._zoom) / 2;
    this._applyTransform();
  }

  _toggleLabels() {
    this._showLabels = !this._showLabels;
    const btn = this._viewer?.querySelector('.toggle-labels');
    if (btn) btn.classList.toggle('active', this._showLabels);
    this._viewer?.querySelectorAll('.pin-label').forEach((el) => {
      el.style.display = this._showLabels ? '' : 'none';
    });
  }

  /* ----------------------------------------------------------
     Active Tool
     ---------------------------------------------------------- */

  _setActiveTool(type) {
    this._activeTool = type;

    this._viewer?.querySelectorAll('.pin-tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pinType === type);
    });
    const markerBtn = this._viewer?.querySelector('[data-action="place-chronicle-marker"]');
    if (markerBtn) {
      markerBtn.classList.toggle('active', type === 'chronicle-marker');
    }

    this._viewport?.classList.toggle('placing', !!type);
  }

  /* ----------------------------------------------------------
     Local Pin CRUD
     ---------------------------------------------------------- */

  _getPins() {
    return (this.document.getFlag(FLAG_SCOPE, 'pins') || []).slice();
  }

  async _savePins(pins) {
    await this.document.setFlag(FLAG_SCOPE, 'pins', pins);
  }

  async _placeLocalPin(event) {
    if (!this._activeTool) return;
    const coords = this._eventToPercent(event);
    if (!coords) return;

    const pin = {
      id: foundry.utils.randomID(),
      x: coords.x,
      y: coords.y,
      label: game.i18n.localize(`CHRONICLE.MapViewer.PinTypes.${this._activeTool}`),
      type: this._activeTool,
      shared: true,
      linkedJournalId: null,
      description: '',
      markerId: null,
    };

    const pins = this._getPins();
    pins.push(pin);
    await this._savePins(pins);

    this._emitPinChange('pin-create', pin);
    this._setActiveTool(null);
    this.render(false);
  }

  async _movePin(pinId, newX, newY) {
    const pins = this._getPins();
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return;

    pin.x = newX;
    pin.y = newY;
    await this._savePins(pins);
    this._emitPinChange('pin-update', pin);
  }

  async _updatePin(updatedPin) {
    const pins = this._getPins();
    const idx = pins.findIndex((p) => p.id === updatedPin.id);
    if (idx === -1) return;

    pins[idx] = { ...pins[idx], ...updatedPin };
    await this._savePins(pins);

    this._emitPinChange('pin-update', pins[idx]);
    this.render(false);
  }

  async _deletePin(pinId) {
    const pins = this._getPins();
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return;

    const remaining = pins.filter((p) => p.id !== pinId);
    await this._savePins(remaining);
    this._emitPinChange('pin-delete', pin);
    this.render(false);
  }

  /* ----------------------------------------------------------
     Local Pin Drag (move)
     ---------------------------------------------------------- */

  _onPinDragStart(pinEl, event) {
    this._draggingPin = pinEl;
    this._dragMoved = false;
    this._dragStartPos = { x: event.clientX, y: event.clientY };
    pinEl.classList.add('dragging');
  }

  _onPinDragMove(event) {
    if (!this._draggingPin) return;

    const dx = event.clientX - this._dragStartPos.x;
    const dy = event.clientY - this._dragStartPos.y;
    if (!this._dragMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    this._dragMoved = true;

    const coords = this._clientToPercent(event.clientX, event.clientY);
    if (coords) {
      this._draggingPin.style.left = `${coords.x}%`;
      this._draggingPin.style.top = `${coords.y}%`;
    }
  }

  async _onPinDragEnd(event) {
    const pinEl = this._draggingPin;
    if (!pinEl) return;

    pinEl.classList.remove('dragging');
    this._draggingPin = null;

    if (this._dragMoved) {
      const coords = this._clientToPercent(event.clientX, event.clientY);
      if (coords) await this._movePin(pinEl.dataset.pinId, coords.x, coords.y);
    }
    this._dragMoved = false;
  }

  /* ----------------------------------------------------------
     Local Pin Double-Click
     ---------------------------------------------------------- */

  _onPinDoubleClick(pinId) {
    const pins = this._getPins();
    const pin = pins.find((p) => p.id === pinId);
    if (!pin?.linkedJournalId) return;

    try {
      const doc = fromUuidSync(pin.linkedJournalId);
      if (doc?.sheet) doc.sheet.render(true);
    } catch (err) {
      console.warn('Chronicle MapViewer: Could not open linked journal', err);
    }
  }

  _openPinConfig(pinId) {
    const pins = this._getPins();
    const pin = pins.find((p) => p.id === pinId);
    if (!pin) return;

    new PinConfigDialog({
      pin: { ...pin },
      pinTypes: VIEWER_PIN_TYPES,
      onSave: (updated) => this._updatePin(updated),
      onDelete: (id) => this._deletePin(id),
    }).render(true);
  }

  /* ----------------------------------------------------------
     Chronicle Marker placement / edit (GM only)
     ---------------------------------------------------------- */

  /**
   * Place mode: click on the map opens a config dialog and creates the
   * marker on Chronicle when saved.
   * @param {MouseEvent} event
   * @private
   */
  _beginChronicleMarkerPlacement(event) {
    if (!game.user.isGM) {
      this._setActiveTool(null);
      return;
    }
    const coords = this._eventToPercent(event);
    if (!coords) return;

    const mapId = this.document.getFlag(FLAG_SCOPE, 'mapId');
    if (!mapId) {
      ui.notifications.warn(game.i18n.localize('CHRONICLE.MapViewer.NotChronicleMap'));
      this._setActiveTool(null);
      return;
    }

    new ChronicleMarkerConfigDialog({
      marker: {
        id: null,
        name: '',
        description: '',
        x: coords.x,
        y: coords.y,
        pin_category: 'note',
        color: PIN_ICONS.note.color,
        visibility: 'everyone',
      },
      mode: 'create',
      onSave: async (data) => {
        const mapSync = _getMapSync();
        if (!mapSync) return;
        await mapSync.createMarker(mapId, data);
        this.render(false);
      },
    }).render(true);

    this._setActiveTool(null);
  }

  _openChronicleMarkerConfig(markerId) {
    if (!game.user.isGM || !markerId) return;
    const mapId = this.document.getFlag(FLAG_SCOPE, 'mapId');
    if (!mapId) return;

    const mapSync = _getMapSync();
    const data = mapSync?.getMapData(this.document);
    const marker = (data?.markers || []).find((m) => m.id === markerId);
    if (!marker) return;

    new ChronicleMarkerConfigDialog({
      marker: { ...marker },
      mode: 'edit',
      onSave: async (updated) => {
        await mapSync?.updateMarker(mapId, markerId, updated);
        this.render(false);
      },
      onDelete: async () => {
        await mapSync?.deleteMarker(mapId, markerId);
        this.render(false);
      },
    }).render(true);
  }

  /**
   * Double-click a Chronicle marker → open its linked entity (if any).
   * @param {string} markerId
   * @private
   */
  _onChronicleMarkerDoubleClick(markerId) {
    const mapSync = _getMapSync();
    const data = mapSync?.getMapData(this.document) || this._readChronicleFromFlags();
    const marker = (data.markers || []).find((m) => m.id === markerId);
    if (!marker?.entity_id) return;

    // Resolve via journal-sync materialization: find a JournalEntry with
    // the matching `entityId` flag and open it.
    const journal = game.journal.find((j) => j.getFlag(FLAG_SCOPE, 'entityId') === marker.entity_id);
    if (journal?.sheet) journal.sheet.render(true);
  }

  /* ----------------------------------------------------------
     Coordinate Conversion
     ---------------------------------------------------------- */

  _eventToPercent(event) {
    return this._clientToPercent(event.clientX, event.clientY);
  }

  _clientToPercent(clientX, clientY) {
    const img = this._viewer?.querySelector('.map-image');
    if (!img) return null;

    const imgRect = img.getBoundingClientRect();
    if (!imgRect.width || !imgRect.height) return null;

    const x = ((clientX - imgRect.left) / imgRect.width) * 100;
    const y = ((clientY - imgRect.top) / imgRect.height) * 100;

    return {
      x: Math.max(0, Math.min(100, Math.round(x * 10) / 10)),
      y: Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
    };
  }

  /* ----------------------------------------------------------
     Local Pin Foundry-Socket Sync
     ---------------------------------------------------------- */

  _emitPinChange(action, pin) {
    game.socket.emit(SOCKET_CHANNEL, {
      type: 'map-viewer',
      action,
      pageId: this.document.id,
      pin,
      userId: game.user.id,
    });
  }

  _onSocketMessage(data) {
    if (data.type !== 'map-viewer') return;
    if (data.pageId !== this.document.id) return;
    if (data.userId === game.user.id) return;
    this.render(false);
  }
}


/* ============================================================
   PinConfigDialog — local pin editor
   ============================================================ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PinConfigDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'chronicle-pin-config',
    classes: ['chronicle-pin-config'],
    window: {
      title: 'CHRONICLE.MapViewer.PinConfig',
      resizable: false,
    },
    position: {
      width: 340,
    },
    actions: {
      'save-pin': PinConfigDialog.#onSave,
      'delete-pin': PinConfigDialog.#onDelete,
    },
  };

  static PARTS = {
    config: {
      template: 'modules/chronicle-sync/templates/pin-config.hbs',
    },
  };

  constructor({ pin, pinTypes, onSave, onDelete }) {
    super({
      id: `chronicle-pin-config-${pin.id}`,
      window: { title: game.i18n.localize('CHRONICLE.MapViewer.PinConfig') },
    });
    this._pin = pin;
    this._pinTypes = pinTypes;
    this._onSaveCallback = onSave;
    this._onDeleteCallback = onDelete;
  }

  async _prepareContext(_options = {}) {
    const pinTypes = {};
    for (const [key, val] of Object.entries(this._pinTypes)) {
      pinTypes[key] = {
        ...val,
        label: game.i18n.localize(`CHRONICLE.MapViewer.PinTypes.${key}`),
      };
    }
    return {
      pin: this._pin,
      pinTypes,
      isGM: game.user.isGM,
    };
  }

  static #onSave(_event, _target) {
    const form = this.element.querySelector('.chronicle-pin-config-form');
    if (!form) return;

    const updated = {
      ...this._pin,
      label: form.querySelector('[name="label"]').value.trim() || this._pin.label,
      type: form.querySelector('[name="type"]').value,
      description: form.querySelector('[name="description"]').value.trim(),
      linkedJournalId: form.querySelector('[name="linkedJournalId"]').value.trim() || null,
    };

    const sharedCb = form.querySelector('[name="shared"]');
    if (sharedCb) updated.shared = sharedCb.checked;

    if (this._onSaveCallback) this._onSaveCallback(updated);
    this.close();
  }

  static async #onDelete(_event, _target) {
    const confirmed = await Dialog.confirm({
      title: game.i18n.localize('CHRONICLE.MapViewer.PinDelete'),
      content: `<p>${game.i18n.localize('CHRONICLE.MapViewer.PinDeleteConfirm')}</p>`,
    });
    if (confirmed) {
      if (this._onDeleteCallback) this._onDeleteCallback(this._pin.id);
      this.close();
    }
  }
}


/* ============================================================
   ChronicleMarkerConfigDialog — Chronicle marker editor (GM only)
   ============================================================ */

export class ChronicleMarkerConfigDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'chronicle-marker-config',
    classes: ['chronicle-marker-config'],
    window: {
      title: 'CHRONICLE.MapViewer.MarkerConfig',
      resizable: false,
    },
    position: { width: 360 },
    actions: {
      'save-marker': ChronicleMarkerConfigDialog.#onSave,
      'delete-marker': ChronicleMarkerConfigDialog.#onDelete,
    },
  };

  static PARTS = {
    config: {
      template: 'modules/chronicle-sync/templates/chronicle-marker-config.hbs',
    },
  };

  constructor({ marker, mode, onSave, onDelete }) {
    const id = marker?.id ? `chronicle-marker-config-${marker.id}` : 'chronicle-marker-config-new';
    super({
      id,
      window: { title: game.i18n.localize('CHRONICLE.MapViewer.MarkerConfig') },
    });
    this._marker = marker;
    this._mode = mode || 'edit';
    this._onSaveCallback = onSave;
    this._onDeleteCallback = onDelete;
  }

  async _prepareContext(_options = {}) {
    const categories = CHRONICLE_MARKER_CATEGORIES.map((key) => ({
      key,
      label: game.i18n.localize(`CHRONICLE.MapViewer.PinTypes.${key}`),
      faIcon: PIN_ICONS[key].faIcon,
      color: PIN_ICONS[key].color,
    }));
    const visibilityOptions = VISIBILITY_VALUES.map((v) => ({
      value: v,
      label: game.i18n.localize(`CHRONICLE.MapViewer.MarkerVisibility.${v}`),
    }));
    return {
      marker: this._marker,
      mode: this._mode,
      isCreate: this._mode === 'create',
      categories,
      visibilityOptions,
    };
  }

  static #onSave(_event, _target) {
    const form = this.element.querySelector('.chronicle-marker-config-form');
    if (!form) return;

    const name = form.querySelector('[name="name"]').value.trim() || 'Marker';
    const description = form.querySelector('[name="description"]').value.trim();
    const category = form.querySelector('[name="pin_category"]').value;
    const visibility = form.querySelector('[name="visibility"]').value;
    const safeCategory = CHRONICLE_MARKER_CATEGORIES.includes(category) ? category : 'note';
    const safeVisibility = VISIBILITY_VALUES.includes(visibility) ? visibility : 'everyone';

    const data = {
      name,
      description,
      x: this._marker.x,
      y: this._marker.y,
      pin_category: safeCategory,
      color: PIN_ICONS[safeCategory].color,
      icon: PIN_ICONS[safeCategory].faIcon,
      visibility: safeVisibility,
    };

    if (this._onSaveCallback) this._onSaveCallback(data);
    this.close();
  }

  static async #onDelete(_event, _target) {
    const confirmed = await Dialog.confirm({
      title: game.i18n.localize('CHRONICLE.MapViewer.MarkerDelete'),
      content: `<p>${game.i18n.localize('CHRONICLE.MapViewer.MarkerDeleteConfirm')}</p>`,
    });
    if (confirmed) {
      if (this._onDeleteCallback) this._onDeleteCallback();
      this.close();
    }
  }
}
