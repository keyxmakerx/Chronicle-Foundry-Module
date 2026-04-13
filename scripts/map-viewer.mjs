/**
 * Chronicle Sync - Interactive Map Viewer Journal Page
 *
 * Registers a custom JournalPageSheet for image-type pages that provides
 * an interactive map viewer with pin placement, zoom/pan, and real-time
 * socket sync between Foundry clients. Pins are stored as page flags.
 *
 * Phase 1: Standalone viewer with local storage + Foundry socket sync.
 * Phase 2 (future): Chronicle marker API integration.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { PIN_ICONS } from './map-sync.mjs';

/* ============================================================
   Constants
   ============================================================ */

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.15;

/**
 * Extended pin types for the map viewer. Inherits the 5 types from
 * map-sync.mjs and adds a text-only label type.
 */
const VIEWER_PIN_TYPES = {
  ...PIN_ICONS,
  text: { icon: 'icons/svg/scroll.svg', color: '#e2e8f0', faIcon: 'fa-font' },
};

/* ============================================================
   MapViewerSheet — Custom JournalPageSheet for image pages
   ============================================================ */

/**
 * An interactive map viewer that renders inside a journal entry page.
 * Provides pin placement, drag-to-move, zoom/pan, and label toggling.
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
    this._activeTool = null; // null or pin type key
    this._isPanning = false;
    this._panStart = null;

    // Pin drag state.
    this._draggingPin = null;
    this._dragOffset = null;

    // Bound socket handler for cleanup.
    this._boundSocketHandler = this._onSocketMessage.bind(this);
  }

  /* ----------------------------------------------------------
     Data
     ---------------------------------------------------------- */

  /** @override */
  async getData(options = {}) {
    const data = await super.getData(options);
    const allPins = this.document.getFlag(FLAG_SCOPE, 'pins') || [];

    // Filter GM-only pins for non-GM users.
    const isGM = game.user.isGM;
    const visiblePins = isGM ? allPins : allPins.filter((p) => p.shared !== false);

    // Enrich pins with icon/color from type definitions.
    const pins = visiblePins.map((pin) => {
      const style = VIEWER_PIN_TYPES[pin.type] || VIEWER_PIN_TYPES.note;
      return { ...pin, faIcon: style.faIcon, color: style.color };
    });

    // Build pin type list with labels for toolbar/dropdown.
    const pinTypes = {};
    for (const [key, val] of Object.entries(VIEWER_PIN_TYPES)) {
      pinTypes[key] = {
        ...val,
        label: game.i18n.localize(`CHRONICLE.MapViewer.PinTypes.${key}`),
      };
    }

    return {
      ...data,
      pageId: this.document.id,
      src: this.document.src,
      pins,
      pinTypes,
      isGM,
      showLabels: this._showLabels,
      zoomPercent: Math.round(this._zoom * 100),
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

    // Apply current transform (e.g. after re-render).
    this._applyTransform();

    // ---- Toolbar: pin tools ----
    viewer.querySelectorAll('.pin-tool-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const type = btn.dataset.pinType;
        if (this._activeTool === type) {
          this._setActiveTool(null);
        } else {
          this._setActiveTool(type);
        }
      });
    });

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

    // ---- Viewport: pan + pin placement ----
    this._viewport.addEventListener('mousedown', (e) => {
      // Left-click only.
      if (e.button !== 0) return;

      // Check if clicking on a pin (handled separately).
      if (e.target.closest('.map-pin')) return;

      if (this._activeTool) {
        // Place a new pin at the click position.
        e.preventDefault();
        this._placePin(e);
      } else {
        // Start panning.
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

    // ---- Pin interactions ----
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

    // ---- Foundry socket sync ----
    game.socket.on(SOCKET_CHANNEL, this._boundSocketHandler);
  }

  /** @override */
  close(options) {
    // Clean up global listeners.
    if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseUp) document.removeEventListener('mouseup', this._onMouseUp);
    game.socket.off(SOCKET_CHANNEL, this._boundSocketHandler);
    return super.close(options);
  }

  /* ----------------------------------------------------------
     Zoom / Pan
     ---------------------------------------------------------- */

  _applyTransform() {
    if (!this._container) return;
    this._container.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;

    // Update zoom indicator.
    const indicator = this._viewer?.querySelector('.zoom-indicator');
    if (indicator) indicator.textContent = `${Math.round(this._zoom * 100)}%`;
  }

  _zoomBy(delta) {
    this._zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this._zoom + delta));
    this._applyTransform();
  }

  /**
   * Zoom towards the mouse cursor position.
   */
  _zoomAt(delta, clientX, clientY) {
    const oldZoom = this._zoom;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom + delta));
    if (newZoom === oldZoom) return;

    const rect = this._viewport.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    // Adjust pan so the point under the cursor stays fixed.
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

    // Toggle label visibility in DOM without full re-render.
    const btn = this._viewer?.querySelector('.toggle-labels');
    if (btn) btn.classList.toggle('active', this._showLabels);

    this._pinLayer?.querySelectorAll('.pin-label').forEach((el) => {
      el.style.display = this._showLabels ? '' : 'none';
    });
  }

  /* ----------------------------------------------------------
     Active Tool
     ---------------------------------------------------------- */

  _setActiveTool(type) {
    this._activeTool = type;

    // Update toolbar button states.
    this._viewer?.querySelectorAll('.pin-tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pinType === type);
    });

    // Update viewport cursor.
    this._viewport?.classList.toggle('placing', !!type);
  }

  /* ----------------------------------------------------------
     Pin CRUD
     ---------------------------------------------------------- */

  _getPins() {
    return (this.document.getFlag(FLAG_SCOPE, 'pins') || []).slice();
  }

  async _savePins(pins) {
    await this.document.setFlag(FLAG_SCOPE, 'pins', pins);
  }

  /**
   * Place a new pin at the click position.
   */
  async _placePin(event) {
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

    // Re-render to show the new pin.
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
     Pin Drag (move)
     ---------------------------------------------------------- */

  _onPinDragStart(pinEl, event) {
    this._draggingPin = pinEl;
    this._dragMoved = false;
    this._dragStartPos = { x: event.clientX, y: event.clientY };
    pinEl.classList.add('dragging');
  }

  _onPinDragMove(event) {
    if (!this._draggingPin) return;

    // Only count as a drag if moved more than 3px (to distinguish from click).
    const dx = event.clientX - this._dragStartPos.x;
    const dy = event.clientY - this._dragStartPos.y;
    if (!this._dragMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

    this._dragMoved = true;

    // Move the pin element visually (will be saved on mouseup).
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
      if (coords) {
        await this._movePin(pinEl.dataset.pinId, coords.x, coords.y);
      }
    }
    this._dragMoved = false;
  }

  /* ----------------------------------------------------------
     Pin Double-Click (open linked journal)
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

  /* ----------------------------------------------------------
     Pin Config Dialog
     ---------------------------------------------------------- */

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
     Coordinate Conversion
     ---------------------------------------------------------- */

  /**
   * Convert a mouse event position to percentage coordinates relative to the map image.
   */
  _eventToPercent(event) {
    return this._clientToPercent(event.clientX, event.clientY);
  }

  /**
   * Convert client (screen) coordinates to percentage of the map image.
   */
  _clientToPercent(clientX, clientY) {
    const img = this._viewer?.querySelector('.map-image');
    if (!img) return null;

    // The image's bounding rect accounts for the CSS transform (zoom + pan).
    const imgRect = img.getBoundingClientRect();
    if (!imgRect.width || !imgRect.height) return null;

    const x = ((clientX - imgRect.left) / imgRect.width) * 100;
    const y = ((clientY - imgRect.top) / imgRect.height) * 100;

    // Clamp to image bounds.
    return {
      x: Math.max(0, Math.min(100, Math.round(x * 10) / 10)),
      y: Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
    };
  }

  /* ----------------------------------------------------------
     Socket Sync
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
    if (data.userId === game.user.id) return; // Ignore own events.

    // Re-render to reflect the remote change. The flag data is already
    // updated by the time we receive the socket event (since the sending
    // client called setFlag which propagates via Foundry's native sync).
    this.render(false);
  }
}


/* ============================================================
   PinConfigDialog — ApplicationV2 popup for editing a pin
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

  async _prepareContext(options = {}) {
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

  static #onSave(event, target) {
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

  static async #onDelete(event, target) {
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
