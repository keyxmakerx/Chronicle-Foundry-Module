/**
 * Chronicle Sync - Shop Room Window
 *
 * Shows a Chronicle shop as the walk-in room the Chronicle shop page draws.
 * The drawing is Chronicle's own shop_room widget, vendored unchanged under
 * vendor/chronicle/ and run against a stand-in for Chronicle's page globals
 * (`_shop-room-data.mjs`), so the room looks exactly as it does in Chronicle.
 *
 * The GM's window reads the room from Chronicle. Players have no API key:
 * they see a shop only when the GM shows it, from the data the GM's client
 * sends over the module socket.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { _isAllowedImageHost } from './_url-validation.mjs';
import { createChronicleShim, sanitizeShopRoomMessage, shopEndpoints, SHOP_ROOM_MESSAGE } from './_shop-room-data.mjs';

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const VENDOR = `modules/${MODULE_ID}/vendor/chronicle`;

let shim = null;
let widgetLoad = null;

/** Load the vendored widget once; resolves to its definition. */
function loadShopRoomWidget() {
  if (widgetLoad) return widgetLoad;
  widgetLoad = (async () => {
    // The widget registers itself on a page global named Chronicle. Never
    // replace one that something else put there.
    if (globalThis.Chronicle && globalThis.Chronicle !== shim) {
      throw new Error('another script already defines window.Chronicle');
    }
    shim = shim || createChronicleShim();
    globalThis.Chronicle = shim;
    for (const file of ['shop_room_icons.js', 'shop_room.js']) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${VENDOR}/${file}`;
        s.charset = 'utf-8';
        s.onload = resolve;
        s.onerror = () => reject(new Error(`could not load ${file}`));
        document.head.appendChild(s);
      });
    }
    const def = shim.widgets.get('shop_room');
    if (!def) throw new Error('shop room widget did not register');
    return def;
  })();
  widgetLoad.catch(() => { widgetLoad = null; });
  return widgetLoad;
}

/** Resolve a shop entity's picture like journal pictures, or "" if absent. */
function keeperImageSrc(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return '';
  const apiUrl = getSetting('apiUrl') || '';
  const base = apiUrl.replace(/\/+$/, '');
  if (imagePath.startsWith('/') && base) return `${base}${imagePath}`;
  return /^https?:/i.test(imagePath) && _isAllowedImageHost(imagePath, apiUrl) ? imagePath : '';
}

/** Whether this client can load an image, so a broken one falls back to the silhouette. */
function canLoadImage(src) {
  if (!src) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 4000);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = src;
  });
}

const { ApplicationV2 } = foundry.applications.api;

/**
 * One shop room. On the GM's client it reads Chronicle through `api`; on a
 * player's client `api` is null and `room` holds what the GM showed.
 */
export class ShopRoomWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ['chronicle-shop-room-window'],
    window: { title: 'Shop', icon: 'fa-solid fa-store', resizable: true },
    position: { width: 760, height: 640 },
  };

  /**
   * @param {object} opts
   * @param {import('./api-client.mjs').ChronicleAPI|null} opts.api
   * @param {string} opts.campaignId
   * @param {string} opts.shopId
   * @param {string} opts.name
   * @param {object} [opts.room] - {layout, goods, image} when shown by the GM.
   * @param {Function} [opts.onClose]
   */
  constructor({ api, campaignId, shopId, name, room, onClose }) {
    super({ id: `chronicle-shop-room-${shopId}`, window: { title: name } });
    this._api = api;
    this._campaignId = campaignId;
    this._shopId = shopId;
    this._name = name;
    this._room = room || null;
    this._onCloseCallback = onClose;
    this._host = null;
    this._def = null;
    this._shown = false;
  }

  get shopId() { return this._shopId; }

  /** Read the room from Chronicle (GM only). */
  async _fetchRoom() {
    const [room, entity] = await Promise.all([
      this._api.get(`/armory/shops/${this._shopId}/room`),
      this._api.get(`/entities/${this._shopId}`).catch(() => null),
    ]);
    if (entity?.name) this._name = entity.name;
    return { layout: room?.layout ?? null, goods: Array.isArray(room?.goods) ? room.goods : [], image: keeperImageSrc(entity?.image_path) };
  }

  async _renderHTML() {
    const el = document.createElement('div');
    el.className = 'chronicle-shop-room';
    return el;
  }

  _replaceHTML(result, content) {
    if (this._host) return; // The widget owns its own redraws.
    content.replaceChildren(result);
    this._host = result;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    if (this._api && game.user.isGM) this._addShowButton();
    this._host.addEventListener('click', (e) => this._onLinkClick(e));
    if (this._api && game.user.isGM) {
      this._host.addEventListener('pointerdown', (e) => {
        const row = e.target.closest('.shr-row');
        if (row) row.draggable = true;
      });
      this._host.addEventListener('dragstart', (e) => this._onDragStart(e));
    }
    await this.refresh();
  }

  /** Re-read the room (GM) and redraw it; a shown room is re-sent to players. */
  async refresh() {
    try {
      this._def = this._def || await loadShopRoomWidget();
      if (this._api) this._room = await this._fetchRoom();
      if (!this._room) return;
      const ok = await canLoadImage(this._room.image);
      shim.setShop(this._campaignId, this._shopId, this._room);
      this._mount(ok ? this._room.image : '');
      if (this._shown) this._emit('show');
    } catch (err) {
      console.error('Chronicle: could not show shop room', err);
      this._showError(game.i18n.localize('CHRONICLE.ShopRoom.LoadFailed'));
    }
  }

  _mount(image) {
    if (this._host.firstChild) this._def.destroy(this._host);
    const ep = shopEndpoints(this._campaignId, this._shopId);
    const ds = this._host.dataset;
    ds.roomEndpoint = ep.room;
    ds.relationsEndpoint = ep.relations;
    ds.shopName = this._name;
    if (image) ds.shopImage = image; else delete ds.shopImage;
    this._def.init(this._host);
  }

  _showError(text) {
    if (!this._host) return;
    const p = document.createElement('p');
    p.className = 'notification error';
    p.textContent = text;
    this._host.replaceChildren(p);
  }

  /** Item names link to Chronicle pages; in Foundry they open the synced journal instead. */
  _onLinkClick(e) {
    const a = e.target.closest('a.shr-nm');
    if (!a) return;
    e.preventDefault();
    const entityId = (a.getAttribute('href') || '').split('/entities/')[1];
    const journal = entityId && game.journal.find((j) => j.getFlag(FLAG_SCOPE, 'entityId') === entityId);
    if (journal?.testUserPermission(game.user, 'OBSERVER')) journal.sheet.render({ force: true });
  }

  /** GM drags a good onto a character sheet, as with the old shop list. */
  _onDragStart(e) {
    const row = e.target.closest?.('.shr-row');
    if (!row) return;
    const good = (this._room?.goods || []).find((g) => String(g.id) === row.dataset.row);
    if (!good) return;
    const meta = good.metadata || {};
    e.dataTransfer.setData('text/plain', JSON.stringify({
      type: 'Item',
      name: good.targetEntityName || meta.custom_name || 'Item',
      img: 'icons/svg/item-bag.svg',
      system: {},
      flags: {
        [FLAG_SCOPE]: {
          shopEntityId: this._shopId,
          chronicleItemId: good.targetEntityId,
          shopRelationId: good.id,
          shopPrice: meta.price,
          shopCurrency: meta.currency || 'gp',
        },
      },
    }));
  }

  _addShowButton() {
    const header = this.window?.header;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-control chronicle-shop-show';
    btn.addEventListener('click', () => {
      this._shown = !this._shown;
      this._emit(this._shown ? 'show' : 'hide');
      this._paintShowButton(btn);
    });
    this._paintShowButton(btn);
    if (header) header.insertBefore(btn, this.window.close || null);
    else this.element.querySelector('.window-content')?.prepend(btn);
  }

  _paintShowButton(btn) {
    const key = this._shown ? 'CHRONICLE.ShopRoom.StopShowing' : 'CHRONICLE.ShopRoom.ShowToPlayers';
    btn.innerHTML = `<i class="fa-solid ${this._shown ? 'fa-eye-slash' : 'fa-eye'}"></i> `;
    btn.append(game.i18n.localize(key));
    btn.setAttribute('aria-pressed', String(this._shown));
  }

  _emit(action) {
    const msg = { type: SHOP_ROOM_MESSAGE, action, shopId: this._shopId, userId: game.user.id };
    if (action === 'show') {
      Object.assign(msg, { campaignId: this._campaignId, name: this._name, image: this._room?.image || '', layout: this._room?.layout ?? null, goods: this._room?.goods || [] });
    }
    game.socket.emit(SOCKET_CHANNEL, msg);
  }

  async close(options) {
    if (this._host && this._def && this._host.firstChild) this._def.destroy(this._host);
    if (this._onCloseCallback) this._onCloseCallback();
    return super.close(options);
  }
}

/**
 * Player side: open or close a shop room when a GM shows or hides it. Runs on
 * every non-GM client; messages from anyone but a GM are ignored.
 */
export function registerShopRoomSocket() {
  if (game.user.isGM) return;
  const open = new Map();
  game.socket.on(SOCKET_CHANNEL, (data) => {
    if (data?.type !== SHOP_ROOM_MESSAGE || !game.users.get(data.userId)?.isGM) return;
    const msg = sanitizeShopRoomMessage(data, getSetting('apiUrl'));
    if (!msg) return;
    const current = open.get(msg.shopId);
    if (msg.action === 'hide') {
      current?.close();
      return;
    }
    if (current) {
      current._room = msg;
      current._name = msg.name;
      current.refresh();
      current.bringToFront?.() ?? current.bringToTop?.();
      return;
    }
    const win = new ShopRoomWindow({
      api: null, campaignId: msg.campaignId, shopId: msg.shopId, name: msg.name, room: msg,
      onClose: () => open.delete(msg.shopId),
    });
    open.set(msg.shopId, win);
    win.render({ force: true });
  });
}
