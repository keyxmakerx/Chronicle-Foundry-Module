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
 *
 * Buying is the widget's own basket. On the GM's client it calls Chronicle
 * directly. A player's basket goes over the socket to the GM's client, which
 * buys through Chronicle as the Chronicle member that player is matched to,
 * so Chronicle applies that member's own rules (their characters, downtime).
 * The GM sees each sale as a whispered chat line.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { getSetting, getUserMappings } from './settings.mjs';
import { _isAllowedImageHost } from './_url-validation.mjs';
import { decryptReply, encryptReply, generateRequestKeys } from './_stash-crypto.mjs';
import {
  createChronicleShim, describeSale, sanitizeShopBuyReply, sanitizeShopBuyRequest,
  sanitizeShopRoomMessage, shopEndpoints, MAX_ROOM_REPLY_CHARS, SHOP_ROOM_MESSAGE,
} from './_shop-room-data.mjs';

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const VENDOR = `modules/${MODULE_ID}/vendor/chronicle`;

// How long a player waits for the GM's client to answer. The buyers read
// holds up the room's first draw, so it gives up sooner (no basket) than a
// purchase does.
const REQUEST_TIMEOUT_MS = { buyers: 8000, open: 10000, buy: 20000 };
// After a sale the widget reloads its own goods and shows what was bought;
// a room update arriving in this window updates the data without redrawing,
// so that line stays on screen.
const QUIET_MS = 5000;

let shim = null;
let widgetLoad = null;
/** Player side: buying requests waiting for the GM's answer, by request id. */
const pending = new Map();
/** Player side: each waiting request's private key and answer size limit, by request id. */
const replyKeys = new Map();
/** Player side: open shop rooms, by shop id. */
const playerRooms = new Map();
/** Tells the sync manager how a player's relayed request went (userId, error?). */
export const RELAY_OUTCOME_HOOK = 'chronicleRelayOutcome';
/** GM side: answers players' buying requests; set by the shop widget. */
let buyRelay = null;

/**
 * Set the GM-side handler for players' buying requests:
 * `(user, request) => Promise<{status, body, goods?}>`.
 */
export function setShopBuyRelay(fn) {
  buyRelay = fn;
}

const t = (key) => game.i18n.localize(`CHRONICLE.ShopRoom.${key}`);

/**
 * Player side: ask the GM's client to make a buying call for this user. The
 * answer shows a character's coins and every client may see socket traffic,
 * so it comes back encrypted to a key only this request holds.
 */
async function requestFromGM(shopId, action, body) {
  if (!game.users.activeGM) return { status: 503, body: { message: t('NoGM') } };
  const requestId = foundry.utils.randomID(16);
  const pair = await generateRequestKeys();
  replyKeys.set(requestId, { key: pair.privateKey, limit: action === 'open' ? MAX_ROOM_REPLY_CHARS : undefined });
  return new Promise((resolve) => {
    const finish = (reply) => {
      clearTimeout(timer);
      pending.delete(requestId);
      replyKeys.delete(requestId);
      resolve(reply);
    };
    // A purchase may still go through after the wait ends, so the player is
    // told to check before buying again rather than simply to retry.
    const timer = setTimeout(() => finish({ status: 504, body: { message: t(action === 'buy' ? 'GMNoAnswerBuy' : 'GMNoAnswer') } }),
      REQUEST_TIMEOUT_MS[action] || REQUEST_TIMEOUT_MS.buy);
    pending.set(requestId, finish);
    game.socket.emit(SOCKET_CHANNEL, {
      type: SHOP_ROOM_MESSAGE, action, requestId, shopId, userId: game.user.id, publicKey: pair.publicJwk, body,
    });
  });
}

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
   * @param {boolean} [opts.selfOpened] - A player opened it from the shop's journal, so the GM's "Stop showing" leaves it open.
   * @param {boolean} [opts.closed] - No GM is online to serve the room; the window says the shop is closed.
   * @param {Function} [opts.onClose]
   */
  constructor({ api, campaignId, shopId, name, room, selfOpened, closed, onClose }) {
    super({ id: `chronicle-shop-room-${shopId}`, window: { title: name } });
    this._api = api;
    this._campaignId = campaignId;
    this._shopId = shopId;
    this._name = name;
    this._room = room || null;
    this.selfOpened = !!selfOpened;
    this._closed = !!closed;
    this._onCloseCallback = onClose;
    this._host = null;
    this._def = null;
    this._shown = false;
    this._quietUntil = 0;
    this._mountedLayout = undefined;
    /** Character names from the last buyers answers, for the GM's sale line. */
    this._buyerNames = new Map();
  }

  get shopId() { return this._shopId; }

  /** Whether the GM is showing this shop to players. */
  get shown() { return this._shown; }

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
    if (this._closed) {
      this._showClosed();
      return;
    }
    try {
      this._def = this._def || await loadShopRoomWidget();
      if (this._api) this._room = await this._fetchRoom();
      if (!this._room) return;
      const onAction = (kind, body) => this._onAction(kind, body);
      shim.setShop(this._campaignId, this._shopId, this._room, onAction);
      const layoutKey = JSON.stringify(this._room.layout ?? null);
      // Just after a sale the widget has already reloaded its goods; redraw
      // only if the room itself changed.
      if (!(Date.now() < this._quietUntil && layoutKey === this._mountedLayout)) {
        const ok = await canLoadImage(this._room.image);
        this._mount(ok ? this._room.image : '');
        this._mountedLayout = layoutKey;
      }
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

  /** The widget's buying calls: Chronicle directly for the GM, the GM's client for a player. */
  async _onAction(kind, body) {
    if (this._api) return this.runAction(kind, body, null, game.user.name);
    // The sale's own stock update can reach this client before the answer
    // does; it must not redraw the widget while the basket is in flight.
    if (kind === 'buy') this._quietUntil = Infinity;
    let reply;
    try {
      reply = await requestFromGM(this._shopId, kind, body);
    } catch (err) {
      console.error('Chronicle: could not send a shop buying request', err);
      reply = { status: 502, body: { message: t('BuyFailed') } };
    } finally {
      if (kind === 'buy') this._quietUntil = Date.now() + QUIET_MS;
    }
    if (kind === 'buy' && reply.status < 400 && reply.goods && this._room) this._room.goods = reply.goods;
    return reply;
  }

  /**
   * Make one buying call to Chronicle (GM only). `actingUserId` is the
   * Chronicle member a player's request is made for; Chronicle then applies
   * that member's own rules. `who` names the Foundry user for the sale line.
   * @returns {Promise<{status: number, body: object, goods?: object[]}>}
   */
  async runAction(kind, body, actingUserId, who) {
    const base = `/armory/shops/${this._shopId}`;
    try {
      if (kind === 'buyers') {
        const q = actingUserId ? `?actingUserId=${encodeURIComponent(actingUserId)}` : '';
        const view = await this._api.get(`${base}/buyers${q}`);
        for (const b of view?.buyers || []) this._buyerNames.set(b.id, b.name);
        return { status: 200, body: view || {} };
      }
      // Hold redraws while the GM's own basket is in flight, as for a player.
      if (!actingUserId) this._quietUntil = Infinity;
      let result;
      try {
        result = await this._api.post(`${base}/buy`, actingUserId ? { ...body, actingUserId } : body);
      } finally {
        if (!actingUserId) this._quietUntil = Date.now() + QUIET_MS;
      }
      const goodsBefore = this._room?.goods || [];
      let goods;
      try {
        this._room = await this._fetchRoom();
        goods = this._room.goods;
        // A room served only for a player's journal button has no widget here.
        shim?.setShop(this._campaignId, this._shopId, this._room, (k, b) => this._onAction(k, b));
      } catch (err) {
        console.warn('Chronicle: could not re-read the shop after a sale', err);
      }
      // A request outside downtime is not a sale yet; the GM approves it on
      // Chronicle's Stashes page.
      if (result?.status === 'bought') this._announceSale(describeSale({
        who, character: this._buyerNames.get(body?.buyerEntityId) || t('SomeCharacter'),
        shop: this._name, items: body?.items, goods: goodsBefore, result,
      }));
      return { status: 200, body: result || {}, goods };
    } catch (err) {
      return { status: err.status || 502, body: { message: err.serverMessage || err.data?.message || t('BuyFailed') } };
    }
  }

  /** Whisper a sale to the GMs; chat is a courtesy and never fails the sale. */
  _announceSale(line) {
    try {
      const div = document.createElement('div');
      div.textContent = line;
      ChatMessage.create({
        content: `<p>${div.innerHTML}</p>`,
        whisper: ChatMessage.getWhisperRecipients('GM').map((u) => u.id),
        speaker: { alias: 'Chronicle' },
      });
    } catch (err) {
      console.debug('Chronicle: shop sale chat line failed', err?.message);
    }
  }

  /** No GM is online, so there is no room to draw. */
  _showClosed() {
    if (!this._host) return;
    const p = document.createElement('p');
    p.className = 'chronicle-shop-closed';
    const b = document.createElement('b');
    b.textContent = t('ClosedTitle');
    p.append(b, t('ClosedNoGM'));
    this._host.replaceChildren(p);
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
    // Players' copies close with the GM's, so none is left that can't buy.
    if (this._shown) {
      this._shown = false;
      this._emit('hide');
    }
    if (this._host && this._def && this._host.firstChild) this._def.destroy(this._host);
    if (this._onCloseCallback) this._onCloseCallback();
    return super.close(options);
  }
}

/**
 * The shop room socket. Players open, refresh and close rooms the GM shows or
 * hides, and get the GM's answers to their buying requests. The active GM
 * answers players' buying requests through the relay the shop widget sets.
 * Who sent a message is taken from Foundry's own sender id, never from the
 * message, so a player cannot buy as someone else.
 */
export function registerShopRoomSocket() {
  const open = playerRooms;
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (data?.type !== SHOP_ROOM_MESSAGE) return;
    if (game.user.isGM) {
      onBuyRequest(data, senderId);
      return;
    }
    // Shows, hides and answers count only from a GM.
    if (!game.users.get(senderId ?? data.userId)?.isGM) return;
    if (data.action === 'reply') {
      onBuyReply(data);
      return;
    }
    const msg = sanitizeShopRoomMessage(data, getSetting('apiUrl'));
    if (!msg) return;
    const current = open.get(msg.shopId);
    if (msg.action === 'hide') {
      // A room the player opened from the journal stays open.
      if (!current?.selfOpened) current?.close();
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

/** Player side: open the GM's encrypted answer to one of this client's requests. */
async function onBuyReply(data) {
  if (data.toUserId !== game.user.id || typeof data.requestId !== 'string') return;
  const waiting = replyKeys.get(data.requestId);
  const done = pending.get(data.requestId);
  if (!waiting || !done) return;
  try {
    const inner = await decryptReply(waiting.key, data.envelope);
    const reply = sanitizeShopBuyReply({ ...inner, type: SHOP_ROOM_MESSAGE, action: 'reply', requestId: data.requestId, toUserId: data.toUserId }, waiting.limit);
    if (reply) done(reply);
  } catch (err) {
    console.warn('Chronicle: could not read the GM\'s shop answer', err);
  }
}

/** GM side: answer one player's buying request. Only the active GM answers. */
async function onBuyRequest(data, senderId) {
  if (!game.users.activeGM?.isSelf) return;
  const req = sanitizeShopBuyRequest(data);
  if (!req) return;
  const toUserId = senderId ?? data.userId;
  const answer = async ({ status, body, goods }) => {
    try {
      const envelope = await encryptReply(req.publicKey, { status, body, goods });
      game.socket.emit(SOCKET_CHANNEL, {
        type: SHOP_ROOM_MESSAGE, action: 'reply', requestId: req.requestId, toUserId, userId: game.user.id, envelope,
      });
    } catch (err) {
      console.error('Chronicle: could not answer a shop buying request', err);
    }
  };
  const user = game.users.get(senderId);
  // Without Foundry's sender id the buyer can't be known, so nothing is bought.
  if (!user || senderId !== data.userId || user.isGM) {
    answer({ status: 403, body: { message: t('NoSender') } });
    return;
  }
  if (!buyRelay) {
    answer({ status: 404, body: { message: t('NotShown') } });
    return;
  }
  try {
    const result = await buyRelay(user, req);
    // Bookkeeping only, keyed on the socket sender; runAction reports a failed
    // Chronicle call as a status of 400 or more rather than throwing.
    Hooks.callAll(RELAY_OUTCOME_HOOK, senderId, Number(result?.status) >= 400 ? { status: result.status } : undefined);
    await answer(result);
  } catch (err) {
    console.error('Chronicle: shop buying request failed', err);
    Hooks.callAll(RELAY_OUTCOME_HOOK, senderId, err);
    answer({ status: 502, body: { message: t('BuyFailed') } });
  }
}

/**
 * The Chronicle member a Foundry user is matched to in Chronicle Sync's user
 * matching, or null.
 */
export function chronicleUserFor(foundryUserId) {
  const hit = Object.entries(getUserMappings()).find(([, fId]) => fId === foundryUserId);
  return hit ? hit[0] : null;
}

/**
 * Player side: open a shop from its journal entry. The active GM's client
 * serves the room (players have no API key) after checking this user can see
 * that journal; with no GM online the window says the shop is closed.
 */
export async function openShopFromJournal(shopId, name) {
  const existing = playerRooms.get(shopId);
  if (existing) {
    existing.bringToFront?.() ?? existing.bringToTop?.();
    return;
  }
  const reply = await requestFromGM(shopId, 'open');
  const closed = reply.status === 503;
  const room = reply.status < 400
    ? sanitizeShopRoomMessage({ ...reply.body, type: SHOP_ROOM_MESSAGE, action: 'show', shopId }, getSetting('apiUrl'))
    : null;
  if (!room && !closed) {
    ui.notifications.warn(reply.body?.message || t('LoadFailed'));
    return;
  }
  if (playerRooms.has(shopId)) return; // The GM showed it meanwhile.
  const win = new ShopRoomWindow({
    api: null, campaignId: room?.campaignId || '', shopId, name: room?.name || name, room,
    selfOpened: true, closed, onClose: () => playerRooms.delete(shopId),
  });
  playerRooms.set(shopId, win);
  win.render({ force: true });
}

/**
 * An "Open shop" button in the title bar of every shop journal the user can
 * see (players: Observer, not Owner). The GM opens the room as from the
 * journal's menu; a player asks the GM's client for it.
 * @param {(shopId: string, name: string) => void} openAsGM
 */
export function registerShopJournalButton(openAsGM) {
  const add = (app, html) => {
    const journal = app?.document;
    if (journal?.documentName !== 'JournalEntry') return;
    if (journal.getFlag(FLAG_SCOPE, 'entityType') !== 'Shop') return;
    const shopId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!shopId || !journal.testUserPermission(game.user, 'OBSERVER')) return;
    // The GM's client serves players only from entries they can't edit.
    if (!game.user.isGM && journal.testUserPermission(game.user, 'OWNER')) return;
    const root = app.element instanceof HTMLElement ? app.element : app.element?.[0] ?? (html instanceof HTMLElement ? html : html?.[0]);
    const header = app.window?.header ?? root?.querySelector('.window-header');
    if (!header || header.querySelector('.chronicle-shop-open')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-control chronicle-shop-open';
    btn.innerHTML = '<i class="fa-solid fa-cart-shopping"></i> ';
    btn.append(t('OpenShopButton'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (game.user.isGM) openAsGM(shopId, journal.name);
      else openShopFromJournal(shopId, journal.name);
    });
    const close = app.window?.close ?? header.querySelector('[data-action="close"], a.close, .header-button.close');
    header.insertBefore(btn, close?.parentElement === header ? close : null);
  };
  // Foundry v13+ journal sheets, then v12's.
  Hooks.on('renderJournalEntrySheet', add);
  Hooks.on('renderJournalSheet', add);
}
