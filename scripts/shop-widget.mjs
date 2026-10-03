/**
 * Chronicle Sync - Shop Widget
 *
 * Opens Chronicle shops in Foundry as the shop room (`shop-room-window.mjs`)
 * and keeps open rooms current from Chronicle's WebSocket events. GM only:
 * players see a shop when the GM shows it.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { ShopRoomWindow } from './shop-room-window.mjs';

/**
 * ShopWidget manages the shop window UI and drag-and-drop.
 */
export class ShopWidget {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;

    /** @type {Map<string, ShopRoomWindow>} Open shop rooms keyed by entity ID. */
    this._openWindows = new Map();
  }

  /**
   * Initialize the shop widget module.
   * @param {import('./api-client.mjs').ChronicleAPI} api
   */
  async init(api) {
    this._api = api;

    // Add context menu option to JournalEntries linked to shop entities.
    Hooks.on('getJournalEntryContext', (html, options) => {
      options.push({
        name: game.i18n.localize('CHRONICLE.ShopRoom.OpenShop'),
        icon: '<i class="fas fa-store"></i>',
        condition: (li) => {
          const id = li instanceof HTMLElement ? li.dataset.documentId : li.data('documentId');
          const journal = game.journal.get(id);
          return journal?.getFlag(FLAG_SCOPE, 'entityType') === 'Shop';
        },
        callback: async (li) => {
          const id = li instanceof HTMLElement ? li.dataset.documentId : li.data('documentId');
          const journal = game.journal.get(id);
          const entityId = journal?.getFlag(FLAG_SCOPE, 'entityId');
          if (entityId) await this.openShop(entityId, journal.name);
        },
      });
    });

    console.debug('Chronicle: Shop widget initialized');
  }

  /**
   * Handle incoming WebSocket messages for shop inventory changes.
   * @param {object} msg
   */
  onMessage(msg) {
    // Refresh on entity updates.
    if (msg.type === 'entity.updated') {
      const entityId = msg.payload?.id;
      if (entityId && this._openWindows.has(entityId)) {
        this._openWindows.get(entityId).refresh();
      }
    }

    // Refresh on relation changes (stock depleted after purchase).
    if (msg.type === 'relation.metadata_updated' || msg.type === 'relation.deleted') {
      for (const window of this._openWindows.values()) {
        window.refresh();
      }
    }
  }

  /**
   * Open a shop window for a Chronicle shop entity.
   * @param {string} entityId
   * @param {string} shopName
   */
  async openShop(entityId, shopName) {
    // Don't open duplicate windows.
    if (this._openWindows.has(entityId)) {
      const open = this._openWindows.get(entityId);
      open.bringToFront?.() ?? open.bringToTop?.();
      return;
    }

    const window = new ShopRoomWindow({
      api: this._api,
      campaignId: getSetting('campaignId'),
      shopId: entityId,
      name: shopName,
      onClose: () => this._openWindows.delete(entityId),
    });

    this._openWindows.set(entityId, window);
    await window.render({ force: true });
  }

  /**
   * Clean up on destroy.
   */
  destroy() {
    for (const window of this._openWindows.values()) {
      window.close();
    }
    this._openWindows.clear();
  }
}
