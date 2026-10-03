/**
 * Pure helpers for the shop room window: the stand-in for Chronicle's page
 * globals that lets the vendored shop_room.js widget run inside Foundry, and
 * the check on a "show this shop" message before a player's client draws it.
 * Unit-tested by tools/test-shop-room.mjs.
 */

import { _isAllowedImageHost } from './_url-validation.mjs';

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
  };
}

/**
 * A stand-in for the `Chronicle` page global the widget expects. `register`
 * keeps the widget definition; `apiFetch` answers the widget's two reads from
 * data the window already holds, so the widget never reaches the network.
 */
export function createChronicleShim() {
  const widgets = new Map();
  const data = new Map();
  const answer = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  return {
    widgets,
    register(slug, def) { widgets.set(slug, def); },
    setShop(campaignId, shopId, room) {
      const ep = shopEndpoints(campaignId, shopId);
      data.set(ep.room, { layout: room.layout ?? null });
      data.set(ep.relations, room.goods || []);
    },
    apiFetch(url, opts = {}) {
      // Foundry never saves a room; arranging stays on the Chronicle page.
      if ((opts.method || 'GET').toUpperCase() !== 'GET') return answer(405, {});
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
