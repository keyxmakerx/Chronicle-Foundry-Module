/**
 * Pure helpers for the shop room window: the stand-in for Chronicle's page
 * globals that lets the vendored shop_room.js widget run inside Foundry, and
 * the check on a "show this shop" message before a player's client draws it.
 * Unit-tested by tools/test-shop-room.mjs.
 */

import { _isAllowedImageHost } from './_url-validation.mjs';
import { isPublicJwk } from './_stash-crypto.mjs';

/** Socket message type for showing and hiding a shop room to players. */
export const SHOP_ROOM_MESSAGE = 'shop-room';

// Limits on a shown shop, well above anything Chronicle saves (its room
// layout is capped at 64 KiB), so a bad message cannot stall a client.
const MAX_GOODS = 500;
const MAX_LAYOUT_CHARS = 128 * 1024;
const MAX_NAME = 200;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The endpoints the widget fetches. They are the Chronicle page's own paths,
 * because the widget derives the room's random seed from the room endpoint:
 * the same path means a shop with no saved room is generated exactly as it
 * is on the Chronicle shop page.
 */
export function shopEndpoints(campaignId, shopId) {
  return {
    room: `/campaigns/${campaignId}/armory/shops/${shopId}/room`,
    relations: `/campaigns/${campaignId}/entities/${shopId}/relations`,
    buyers: `/campaigns/${campaignId}/armory/shops/${shopId}/buyers`,
    buy: `/campaigns/${campaignId}/armory/shops/${shopId}/buy`,
  };
}

/**
 * A stand-in for the `Chronicle` page global the widget expects. `register`
 * keeps the widget definition; `apiFetch` answers the widget's reads from
 * data the window already holds, and hands its two buying calls to the
 * window's `onAction(kind, body)`, which answers `{status, body, goods?}`.
 * A shop with no `onAction` has no buyers, so the widget shows no basket.
 */
export function createChronicleShim() {
  const widgets = new Map();
  const data = new Map();
  const actions = new Map();
  const answer = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  return {
    widgets,
    register(slug, def) { widgets.set(slug, def); },
    setShop(campaignId, shopId, room, onAction) {
      const ep = shopEndpoints(campaignId, shopId);
      data.set(ep.room, { layout: room.layout ?? null });
      data.set(ep.relations, room.goods || []);
      if (onAction) {
        actions.set(ep.buyers, (body) => onAction('buyers', body));
        actions.set(ep.buy, (body) => onAction('buy', body));
      } else {
        actions.delete(ep.buyers);
        actions.delete(ep.buy);
      }
    },
    async apiFetch(url, opts = {}) {
      const method = (opts.method || 'GET').toUpperCase();
      const act = actions.get(url);
      if (act && method === (url.endsWith('/buy') ? 'POST' : 'GET')) {
        const res = await act(opts.body);
        // Fresh stock after a sale, so the widget's reload shows it.
        if (url.endsWith('/buy') && Array.isArray(res?.goods)) data.set(url.replace(/\/armory\/shops\/([^/]+)\/buy$/, '/entities/$1/relations'), res.goods);
        return answer(res?.status || 502, res?.body ?? {});
      }
      // Foundry never saves a room; arranging stays on the Chronicle page.
      if (method !== 'GET') return answer(405, {});
      return data.has(url) ? answer(200, data.get(url)) : answer(404, {});
    },
  };
}

/**
 * Check a shop room message before drawing it. Players have no API key, so
 * this message is all they get; it comes over the module socket from another
 * client and is treated as untrusted. Returns a cleaned copy, or null.
 */
export function sanitizeShopRoomMessage(msg, apiUrl) {
  if (!msg || typeof msg !== 'object' || msg.type !== SHOP_ROOM_MESSAGE) return null;
  if (!ID_RE.test(String(msg.shopId || ''))) return null;
  if (msg.action === 'hide') return { action: 'hide', shopId: msg.shopId };
  if (msg.action !== 'show' || !ID_RE.test(String(msg.campaignId || ''))) return null;

  let layout = msg.layout ?? null;
  if (layout !== null) {
    if (typeof layout !== 'object' || Array.isArray(layout)) return null;
    if (JSON.stringify(layout).length > MAX_LAYOUT_CHARS) return null;
  }
  if (!Array.isArray(msg.goods) || msg.goods.length > MAX_GOODS) return null;
  const goods = msg.goods.filter((g) => g && typeof g === 'object' && !Array.isArray(g));

  let image = typeof msg.image === 'string' ? msg.image : '';
  if (image && !(/^https?:/i.test(image) && _isAllowedImageHost(image, apiUrl))) image = '';

  return {
    action: 'show',
    campaignId: msg.campaignId,
    shopId: msg.shopId,
    name: String(msg.name || '').slice(0, MAX_NAME) || 'Shop',
    image,
    layout,
    goods,
  };
}

// Limits on a basket, the same as Chronicle's buy route.
const MAX_BASKET_LINES = 50;
const MAX_LINE_QTY = 99;
const MAX_REPLY_CHARS = 64 * 1024;

/**
 * Check a player's buying request before the GM's client acts on it. The
 * request names only a shop, a character and goods with quantities; who is
 * buying comes from the socket's own sender, never from the message, and
 * prices always come from Chronicle. The request carries the public half of
 * a one-off key, so the answer (which shows a character's coins) can be
 * encrypted to the asking client alone. Returns a cleaned copy, or null.
 */
export function sanitizeShopBuyRequest(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== SHOP_ROOM_MESSAGE) return null;
  if (msg.action !== 'buyers' && msg.action !== 'buy') return null;
  if (!ID_RE.test(String(msg.requestId || '')) || !ID_RE.test(String(msg.shopId || ''))) return null;
  if (!isPublicJwk(msg.publicKey)) return null;
  const out = { action: msg.action, requestId: msg.requestId, shopId: msg.shopId, publicKey: msg.publicKey };
  if (msg.action === 'buyers') return out;

  const b = msg.body;
  if (!b || typeof b !== 'object' || !ID_RE.test(String(b.buyerEntityId || ''))) return null;
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_BASKET_LINES) return null;
  const items = [];
  for (const it of b.items) {
    const relationId = Number(it?.relationId);
    const quantity = Number(it?.quantity);
    if (!Number.isInteger(relationId) || relationId <= 0) return null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) return null;
    items.push({ relationId, quantity });
  }
  out.body = { buyerEntityId: b.buyerEntityId, items };
  return out;
}

/**
 * Check the GM's answer to a buying request, once decrypted, before the
 * player's widget reads it. Returns `{requestId, toUserId, status, body,
 * goods?}`, or null.
 */
export function sanitizeShopBuyReply(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== SHOP_ROOM_MESSAGE || msg.action !== 'reply') return null;
  if (!ID_RE.test(String(msg.requestId || '')) || typeof msg.toUserId !== 'string') return null;
  const status = Number(msg.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  if (!msg.body || typeof msg.body !== 'object' || Array.isArray(msg.body)) return null;
  if (JSON.stringify(msg.body).length > MAX_REPLY_CHARS) return null;
  const out = { requestId: msg.requestId, toUserId: msg.toUserId, status, body: msg.body };
  if (msg.goods !== undefined) {
    if (!Array.isArray(msg.goods) || msg.goods.length > MAX_GOODS) return null;
    out.goods = msg.goods.filter((g) => g && typeof g === 'object' && !Array.isArray(g));
  }
  return out;
}

/**
 * The GM's chat line for one sale: who bought what, where, and what it cost.
 * Plain text; the caller escapes it.
 */
export function describeSale({ who, character, shop, items, goods, result }) {
  const names = new Map((goods || []).map((g) => [String(g.id), g.targetEntityName || g.metadata?.custom_name || 'item']));
  const list = (items || []).map((it) => `${it.quantity}× ${names.get(String(it.relationId)) || 'item'}`).join(', ');
  const cost = result?.spent != null ? ` for ${result.spent} ${result.currency || ''}`.trimEnd() : '';
  const left = result?.moneyLeft != null ? ` ${character} has ${result.moneyLeft} ${result.currency || ''}`.trimEnd() + ' left.' : '';
  const by = who && who !== character ? ` (${who})` : '';
  return `${character}${by} bought ${list || 'goods'} at ${shop}${cost}.${left}`;
}
