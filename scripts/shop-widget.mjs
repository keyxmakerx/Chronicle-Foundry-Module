/**
 * Chronicle Sync - Shop Widget
 *
 * Opens Chronicle shops in Foundry as the shop room (`shop-room-window.mjs`)
 * and keeps open rooms current from Chronicle's WebSocket events. GM only:
 * players see a shop when the GM shows it.
 */

import { getSetting } from './settings.mjs';
import { FLAG_SCOPE } from './constants.mjs';
import { ShopRoomWindow, chronicleUserFor, setShopBuyRelay } from './shop-room-window.mjs';

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

    // Players' baskets reach Chronicle through this client, for a shop the
    // GM is showing, as the Chronicle member the player is matched to.
    setShopBuyRelay((user, req) => this._relayBuy(user, req));

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
   * Answer a player's buying request. Only a shop this GM is showing can be
   * bought from, and only as a Chronicle member the GM matched the player to.
   * @param {User} user - The Foundry user who sent the request.
   * @param {{action: string, shopId: string, body?: object}} req - Checked request.
   */
  async _relayBuy(user, req) {
    const win = this._openWindows.get(req.shopId);
    if (!win?.shown) return { status: 404, body: { message: game.i18n.localize('CHRONICLE.ShopRoom.NotShown') } };
    const chronicleUserId = chronicleUserFor(user.id);
    if (!chronicleUserId) return { status: 403, body: { message: game.i18n.localize('CHRONICLE.ShopRoom.NotMatched') } };
    return win.runAction(req.action, req.body, chronicleUserId, user.name);
  }

  /**
   * Clean up on destroy.
   */
  destroy() {
    setShopBuyRelay(null);
    for (const window of this._openWindows.values()) {
      window.close();
    }
    this._openWindows.clear();
  }
}
