/**
 * Chronicle Sync - Map/Scene Sync (Markers Only)
 *
 * Bidirectional sync between Chronicle map markers and Foundry scene
 * Map Notes (pins). The full interactive map experience (drawings, tokens,
 * fog of war, layers) lives on Chronicle's web UI — only marker/pin
 * positions and metadata are synced to Foundry.
 *
 * Sync flow:
 * - Chronicle → Foundry: Marker changes arrive via WebSocket, create/update Notes.
 * - Foundry → Chronicle: Note changes detected via Hooks, push to Chronicle API.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';

/**
 * MapSync handles map marker ↔ scene Note synchronization.
 */
export class MapSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    this._syncing = false;

    // Bound hook handlers for map pins (Notes).
    this._onCreateMapPin = this._handleCreateMapPin.bind(this);
    this._onUpdateMapPin = this._handleUpdateMapPin.bind(this);
    this._onDeleteMapPin = this._handleDeleteMapPin.bind(this);
  }

  /**
   * Initialize map sync.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    if (!getSetting('syncMaps')) return;

    // Register Foundry hooks for Note (map pin) changes.
    Hooks.on('createNote', this._onCreateMapPin);
    Hooks.on('updateNote', this._onUpdateMapPin);
    Hooks.on('deleteNote', this._onDeleteMapPin);

    // Add context menu options to scene navigation.
    Hooks.on('getSceneNavigationContext', (html, options) => {
      // "Link to Chronicle Map" — available on all scenes for GM.
      options.push({
        name: 'Link to Chronicle Map',
        icon: '<i class="fas fa-link"></i>',
        condition: () => game.user.isGM,
        callback: async (li) => {
          const sceneId = li instanceof HTMLElement ? li.dataset.sceneId : li.data('sceneId');
          const scene = game.scenes.get(sceneId);
          if (scene) await this._showMapLinkDialog(scene);
        },
      });

      // "View in Chronicle" — only on linked scenes.
      options.push({
        name: 'View in Chronicle',
        icon: '<i class="fas fa-external-link-alt"></i>',
        condition: (li) => {
          const sceneId = li instanceof HTMLElement ? li.dataset.sceneId : li.data('sceneId');
          const scene = game.scenes.get(sceneId);
          return game.user.isGM && !!scene?.getFlag(FLAG_SCOPE, 'mapId');
        },
        callback: (li) => {
          const sceneId = li instanceof HTMLElement ? li.dataset.sceneId : li.data('sceneId');
          const scene = game.scenes.get(sceneId);
          const url = this.getChronicleMapUrl(scene?.getFlag(FLAG_SCOPE, 'mapId'));
          if (url) window.open(url, '_blank');
        },
      });
    });

    console.debug('Chronicle: Map sync initialized (markers only)');
  }

  /**
   * Handle incoming WebSocket messages for marker events.
   * @param {object} msg
   */
  async onMessage(msg) {
    if (!getSetting('syncMaps')) return;

    switch (msg.type) {
      case 'marker.created':
        await this._onMarkerCreated(msg);
        break;
      case 'marker.updated':
        await this._onMarkerUpdated(msg);
        break;
      case 'marker.deleted':
        await this._onMarkerDeleted(msg);
        break;
    }
  }

  /**
   * Clean up hooks on destroy.
   */
  destroy() {
    Hooks.off('createNote', this._onCreateMapPin);
    Hooks.off('updateNote', this._onUpdateMapPin);
    Hooks.off('deleteNote', this._onDeleteMapPin);
  }

  /**
   * Handle a sync mapping received during initial sync.
   * Processes map-type mappings to link Foundry scenes to Chronicle maps.
   * @param {object} mapping
   */
  async onSyncMapping(mapping) {
    if (!getSetting('syncMaps')) return;

    if (mapping.chronicle_type === 'map') {
      const scene = game.scenes.get(mapping.external_id);
      if (scene && !scene.getFlag(FLAG_SCOPE, 'mapId')) {
        await scene.setFlag(FLAG_SCOPE, 'mapId', mapping.chronicle_id);
        console.debug(`Chronicle: Linked scene "${scene.name}" to map ${mapping.chronicle_id}`);
      }
    }
  }

  /**
   * Perform initial map sync on WebSocket connect.
   * Fetches markers from Chronicle and reconciles with the active Foundry scene.
   */
  async onInitialSync() {
    if (!getSetting('syncMaps')) return;

    const scene = canvas.scene;
    if (!scene) return;

    let mapId = scene.getFlag(FLAG_SCOPE, 'mapId');

    // If no scene is linked, try to auto-link by fetching campaign maps.
    if (!mapId) {
      try {
        const maps = await this._api.get('/maps');
        if (maps && maps.length === 1) {
          mapId = maps[0].id;
          await scene.setFlag(FLAG_SCOPE, 'mapId', mapId);
          console.debug(`Chronicle: Auto-linked scene "${scene.name}" to map "${maps[0].name}"`);

          // Create sync mapping on the server.
          await this._api.post('/sync/mappings', {
            chronicle_type: 'map',
            chronicle_id: mapId,
            external_system: 'foundry',
            external_id: scene.id,
            sync_direction: 'both',
          });
        } else if (maps && maps.length > 1) {
          console.warn(
            `Chronicle: ${maps.length} maps found. Right-click a scene in the navigation bar and select "Link to Chronicle Map" to link manually.`
          );
          return;
        } else {
          return;
        }
      } catch (err) {
        console.error('Chronicle: Failed to fetch maps for auto-link', err);
        return;
      }
    }

    // Pull current markers from Chronicle and reconcile.
    try {
      const markers = await this._api.get(`/maps/${mapId}/markers`).catch(() => []);

      this._syncing = true;
      try {
        for (const marker of (markers || [])) {
          const existing = scene.notes.find(
            (n) => n.getFlag(FLAG_SCOPE, 'markerId') === marker.id
          );
          if (!existing) {
            const noteData = this._chronicleMarkerToFoundry(marker, scene);
            await scene.createEmbeddedDocuments('Note', [noteData]);
          }
        }
      } finally {
        this._syncing = false;
      }

      console.debug('Chronicle: Map initial sync complete (markers)');
    } catch (err) {
      console.error('Chronicle: Map initial sync failed', err);
    }
  }

  /**
   * Show a dialog for the GM to pick which Chronicle map to link to a scene.
   * @param {Scene} scene
   * @private
   */
  async _showMapLinkDialog(scene) {
    try {
      const maps = await this._api.get('/maps');
      if (!maps || maps.length === 0) {
        ui.notifications.warn('Chronicle: No maps found in this campaign.');
        return;
      }

      const currentMapId = scene.getFlag(FLAG_SCOPE, 'mapId');

      // Build selection options.
      const options = maps.map(
        (m) => `<option value="${m.id}" ${m.id === currentMapId ? 'selected' : ''}>${m.name}</option>`
      ).join('');

      new Dialog({
        title: 'Link to Chronicle Map',
        content: `
          <form>
            <div class="form-group">
              <label>Chronicle Map</label>
              <select name="mapId">${options}</select>
            </div>
          </form>
        `,
        buttons: {
          link: {
            icon: '<i class="fas fa-link"></i>',
            label: 'Link',
            callback: async (html) => {
              const root = html instanceof HTMLElement ? html : html[0] ?? html;
              const mapId = root?.querySelector?.('[name="mapId"]')?.value;
              if (mapId) {
                await scene.setFlag(FLAG_SCOPE, 'mapId', mapId);

                // Create sync mapping on the server.
                try {
                  await this._api.post('/sync/mappings', {
                    chronicle_type: 'map',
                    chronicle_id: mapId,
                    external_system: 'foundry',
                    external_id: scene.id,
                    sync_direction: 'both',
                  });
                } catch (err) {
                  console.warn('Chronicle: Failed to create map sync mapping', err);
                }

                ui.notifications.info(`Chronicle: Scene "${scene.name}" linked to map.`);
              }
            },
          },
          unlink: {
            icon: '<i class="fas fa-unlink"></i>',
            label: 'Unlink',
            callback: async () => {
              await scene.unsetFlag(FLAG_SCOPE, 'mapId');
              ui.notifications.info(`Chronicle: Scene "${scene.name}" unlinked.`);
            },
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: 'Cancel',
          },
        },
        default: 'link',
      }).render(true);
    } catch (err) {
      console.error('Chronicle: Failed to fetch maps for linking', err);
      ui.notifications.error('Chronicle: Failed to fetch maps. Check console.');
    }
  }

  // ---------------------------------------------------------------------------
  // Chronicle → Foundry (Markers)
  // ---------------------------------------------------------------------------

  /**
   * Handle a new marker from Chronicle — create a Foundry Note (map pin).
   * @param {object} msg
   * @private
   */
  async _onMarkerCreated(msg) {
    const marker = msg.payload;
    if (!marker?.map_id) return;

    const scene = this._findSceneByMapId(marker.map_id);
    if (!scene) return;

    // Check if pin already exists.
    const existing = scene.notes.find(
      (n) => n.getFlag(FLAG_SCOPE, 'markerId') === marker.id
    );
    if (existing) return;

    this._syncing = true;
    try {
      const noteData = this._chronicleMarkerToFoundry(marker, scene);
      await scene.createEmbeddedDocuments('Note', [noteData]);
      console.debug(`Chronicle: Created map pin "${marker.name}" from marker`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle an updated marker from Chronicle.
   * @param {object} msg
   * @private
   */
  async _onMarkerUpdated(msg) {
    const marker = msg.payload;
    if (!marker?.map_id) return;

    const scene = this._findSceneByMapId(marker.map_id);
    if (!scene) return;

    const note = scene.notes.find(
      (n) => n.getFlag(FLAG_SCOPE, 'markerId') === marker.id
    );
    if (!note) {
      await this._onMarkerCreated(msg);
      return;
    }

    this._syncing = true;
    try {
      const dims = scene.dimensions;
      const pinStyle = PIN_ICONS[marker.pin_category] || PIN_ICONS.note;
      const updates = {
        x: (marker.x / 100) * dims.width,
        y: (marker.y / 100) * dims.height,
        text: marker.name || '',
        'texture.src': pinStyle.icon,
        'texture.tint': marker.color || pinStyle.color,
      };
      await note.update(updates);
      console.debug(`Chronicle: Updated map pin "${marker.name}"`);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Handle a deleted marker from Chronicle.
   * @param {object} msg
   * @private
   */
  async _onMarkerDeleted(msg) {
    const markerId = msg.payload?.id;
    if (!markerId) return;

    // Search all scenes for this marker.
    for (const scene of game.scenes.contents) {
      const note = scene.notes.find(
        (n) => n.getFlag(FLAG_SCOPE, 'markerId') === markerId
      );
      if (note) {
        this._syncing = true;
        try {
          await scene.deleteEmbeddedDocuments('Note', [note.id]);
          console.debug(`Chronicle: Deleted map pin for marker ${markerId}`);
        } finally {
          this._syncing = false;
        }
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Foundry → Chronicle (Notes / Map Pins)
  // ---------------------------------------------------------------------------

  /**
   * Handle Foundry Note (map pin) creation — push to Chronicle as marker.
   * @param {NoteDocument} note
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleCreateMapPin(note, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;
    if (note.getFlag(FLAG_SCOPE, 'markerId')) return;

    const scene = note.parent;
    const mapId = scene?.getFlag(FLAG_SCOPE, 'mapId');
    if (!mapId) return;

    try {
      const markerData = this._foundryNoteToChronicle(note, scene);
      markerData.foundry_id = note.id;

      const result = await this._api.post(`/maps/${mapId}/markers`, markerData);
      if (result?.id) {
        this._syncing = true;
        try {
          await note.setFlag(FLAG_SCOPE, 'markerId', result.id);
        } finally {
          this._syncing = false;
        }
        console.debug(`Chronicle: Pushed new map pin "${note.text}" to Chronicle`);
      }
    } catch (err) {
      console.error('Chronicle: Failed to push map pin to Chronicle', err);
    }
  }

  /**
   * Handle Foundry Note (map pin) update — push changes to Chronicle marker.
   * @param {NoteDocument} note
   * @param {object} change
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleUpdateMapPin(note, change, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const markerId = note.getFlag(FLAG_SCOPE, 'markerId');
    if (!markerId) return;

    const scene = note.parent;
    const mapId = scene?.getFlag(FLAG_SCOPE, 'mapId');
    if (!mapId) return;

    try {
      const markerData = this._foundryNoteToChronicle(note, scene);
      await this._api.put(`/maps/${mapId}/markers/${markerId}`, markerData);
      console.debug(`Chronicle: Pushed map pin update "${note.text}" to Chronicle`);
    } catch (err) {
      console.error('Chronicle: Failed to push map pin update', err);
    }
  }

  /**
   * Handle Foundry Note (map pin) deletion — delete Chronicle marker.
   * @param {NoteDocument} note
   * @param {object} options
   * @param {string} userId
   * @private
   */
  async _handleDeleteMapPin(note, options, userId) {
    if (this._syncing) return;
    if (userId !== game.user.id) return;

    const markerId = note.getFlag(FLAG_SCOPE, 'markerId');
    if (!markerId) return;

    const scene = note.parent;
    const mapId = scene?.getFlag(FLAG_SCOPE, 'mapId');
    if (!mapId) return;

    try {
      await this._api.delete(`/maps/${mapId}/markers/${markerId}`);
      console.debug(`Chronicle: Deleted marker ${markerId} from map pin deletion`);
    } catch (err) {
      console.warn('Chronicle: Failed to delete marker on Chronicle', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the Foundry scene linked to a Chronicle campaign.
   * @param {string} campaignId
   * @returns {Scene|null}
   * @private
   */
  _getLinkedScene(campaignId) {
    const scene = canvas.scene;
    if (scene?.getFlag(FLAG_SCOPE, 'mapId')) {
      return scene;
    }
    return null;
  }

  /**
   * Get the Chronicle map ID linked to a Foundry scene.
   * @param {Scene} scene
   * @returns {string|null}
   * @private
   */
  _getLinkedMapId(scene) {
    return scene?.getFlag(FLAG_SCOPE, 'mapId') || null;
  }

  /**
   * Find a Foundry Scene linked to a Chronicle map ID.
   * @param {string} mapId
   * @returns {Scene|null}
   * @private
   */
  _findSceneByMapId(mapId) {
    return game.scenes.find(
      (s) => s.getFlag(FLAG_SCOPE, 'mapId') === mapId
    ) || null;
  }

  /**
   * Build the Chronicle web URL for a map.
   * @param {string} mapId
   * @returns {string|null}
   */
  getChronicleMapUrl(mapId) {
    const baseUrl = getSetting('apiUrl')?.replace(/\/+$/, '');
    const campaignId = getSetting('campaignId');
    if (!baseUrl || !campaignId || !mapId) return null;
    return `${baseUrl}/campaigns/${campaignId}/maps/${mapId}`;
  }

  // ---------------------------------------------------------------------------
  // Marker ↔ Note Conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert a Chronicle marker to Foundry Note (map pin) data.
   * @param {object} marker - Chronicle marker data.
   * @param {Scene} scene - Target Foundry scene.
   * @returns {object} Foundry NoteDocument creation data.
   * @private
   */
  _chronicleMarkerToFoundry(marker, scene) {
    const dims = scene.dimensions;
    const pinStyle = PIN_ICONS[marker.pin_category] || PIN_ICONS.note;

    // Find linked JournalEntry if marker has entity_id.
    let entryId = null;
    if (marker.entity_id) {
      const linked = game.journal.find(
        (j) => j.getFlag(FLAG_SCOPE, 'entityId') === marker.entity_id
      );
      if (linked) entryId = linked.id;
    }

    return {
      x: (marker.x / 100) * dims.width,
      y: (marker.y / 100) * dims.height,
      text: marker.name || '',
      texture: {
        src: pinStyle.icon,
        tint: marker.color || pinStyle.color,
      },
      entryId: entryId,
      flags: {
        [FLAG_SCOPE]: {
          markerId: marker.id,
          pinCategory: marker.pin_category || 'note',
          markerDescription: marker.description || '',
        },
      },
    };
  }

  /**
   * Convert a Foundry Note (map pin) to Chronicle marker data.
   * @param {NoteDocument} note
   * @param {Scene} scene
   * @returns {object}
   * @private
   */
  _foundryNoteToChronicle(note, scene) {
    const dims = scene.dimensions;
    const pinCategory = note.getFlag(FLAG_SCOPE, 'pinCategory') || this._detectPinCategory(note);

    // Resolve entity_id from linked journal entry.
    let entityId = null;
    if (note.entryId) {
      const journal = game.journal.get(note.entryId);
      if (journal) {
        entityId = journal.getFlag(FLAG_SCOPE, 'entityId') || null;
      }
    }

    const pinStyle = PIN_ICONS[pinCategory] || PIN_ICONS.note;

    return {
      name: note.text || 'Pin',
      x: (note.x / dims.width) * 100,
      y: (note.y / dims.height) * 100,
      icon: pinStyle.faIcon || 'fa-map-pin',
      color: note.texture?.tint || pinStyle.color,
      pin_category: pinCategory,
      entity_id: entityId,
      visibility: 'everyone',
      description: note.getFlag(FLAG_SCOPE, 'markerDescription') || '',
    };
  }

  /**
   * Detect pin category from a Foundry Note's icon/texture.
   * Falls back to 'note' if no match.
   * @param {NoteDocument} note
   * @returns {string}
   * @private
   */
  _detectPinCategory(note) {
    const src = note.texture?.src || '';
    if (src.includes('village') || src.includes('castle') || src.includes('house')) return 'location';
    if (src.includes('skull') || src.includes('trap') || src.includes('hazard')) return 'danger';
    if (src.includes('chest') || src.includes('gem') || src.includes('coin')) return 'treasure';
    if (src.includes('book') || src.includes('scroll') || src.includes('quest')) return 'quest';
    return 'note';
  }
}

/**
 * Pin category → Foundry icon and color mapping.
 * Icons are from Foundry's bundled icon set.
 */
export const PIN_ICONS = {
  location: { icon: 'icons/svg/village.svg', color: '#3B82F6', faIcon: 'fa-map-pin' },
  danger:   { icon: 'icons/svg/skull.svg',   color: '#EF4444', faIcon: 'fa-skull' },
  treasure: { icon: 'icons/svg/chest.svg',   color: '#F59E0B', faIcon: 'fa-gem' },
  quest:    { icon: 'icons/svg/book.svg',    color: '#8B5CF6', faIcon: 'fa-scroll' },
  note:     { icon: 'icons/svg/eye.svg',     color: '#6B7280', faIcon: 'fa-map-pin' },
};
