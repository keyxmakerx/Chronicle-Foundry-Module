#!/usr/bin/env node
/**
 * The shop room window runs Chronicle's own shop_room widget, vendored under
 * vendor/chronicle/, against a stand-in for Chronicle's page globals. These
 * pin the stand-in's answers, the check on a "show this shop" socket message
 * (players draw only what passes it), the widget contract the stand-in relies
 * on, and that the vendored drawing engine still runs.
 *
 * With CHRONICLE_DIR pointing at a Chronicle checkout, the vendored files are
 * also compared byte for byte with Chronicle's, so a Chronicle change to the
 * room shows up here as a failure until the copy is refreshed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(REPO_ROOT, 'vendor', 'chronicle');
const { createChronicleShim, sanitizeShopRoomMessage, shopEndpoints, SHOP_ROOM_MESSAGE } = await import('../scripts/_shop-room-data.mjs');

const API_URL = 'https://chronicle.example.com';
const CAMP = '11111111-2222-3333-4444-555555555555';
const SHOP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('endpoints are the Chronicle shop page paths, so a generated room matches', () => {
  const ep = shopEndpoints(CAMP, SHOP);
  assert.equal(ep.room, `/campaigns/${CAMP}/armory/shops/${SHOP}/room`);
  assert.equal(ep.relations, `/campaigns/${CAMP}/entities/${SHOP}/relations`);
});

test('shim answers the widget from the window data and refuses writes', async () => {
  const shim = createChronicleShim();
  const goods = [{ id: 7, relationType: 'sells', metadata: { price: 5 } }];
  shim.setShop(CAMP, SHOP, { layout: { v: 1 }, goods });
  const ep = shopEndpoints(CAMP, SHOP);

  const room = await shim.apiFetch(ep.room);
  assert.equal(room.ok, true);
  assert.deepEqual(await room.json(), { layout: { v: 1 } });
  assert.deepEqual(await (await shim.apiFetch(ep.relations)).json(), goods);

  const put = await shim.apiFetch(ep.room, { method: 'PUT', body: {} });
  assert.equal(put.ok, false);
  assert.equal(put.status, 405);
  assert.equal((await shim.apiFetch('/campaigns/x/armory/shops/y/room')).status, 404);

  shim.setShop(CAMP, SHOP, { goods: [] });
  assert.deepEqual(await (await shim.apiFetch(ep.room)).json(), { layout: null }, 'no saved room is null');

  shim.register('shop_room', { init() {} });
  assert.ok(shim.widgets.get('shop_room'));
});

const show = (over = {}) => ({
  type: SHOP_ROOM_MESSAGE, action: 'show', campaignId: CAMP, shopId: SHOP, name: 'The Gilded Anvil',
  image: `${API_URL}/media/abc`, layout: { v: 1 }, goods: [{ id: 1 }], userId: 'gm', ...over,
});

test('sanitize: a good show message passes', () => {
  const m = sanitizeShopRoomMessage(show(), API_URL);
  assert.equal(m.action, 'show');
  assert.equal(m.name, 'The Gilded Anvil');
  assert.equal(m.image, `${API_URL}/media/abc`);
  assert.deepEqual(m.goods, [{ id: 1 }]);
});

test('sanitize: hide needs only a shop id', () => {
  assert.deepEqual(sanitizeShopRoomMessage({ type: SHOP_ROOM_MESSAGE, action: 'hide', shopId: SHOP }, API_URL), { action: 'hide', shopId: SHOP });
});

test('sanitize: rejects malformed messages', () => {
  const bad = [
    null,
    'x',
    show({ type: 'map-viewer' }),
    show({ action: 'open' }),
    show({ shopId: '../etc' }),
    show({ campaignId: '' }),
    show({ layout: [1, 2] }),
    show({ layout: 'room' }),
    show({ layout: { big: 'x'.repeat(200 * 1024) } }),
    show({ goods: 'all' }),
    show({ goods: Array.from({ length: 501 }, (_, i) => ({ id: i })) }),
  ];
  for (const m of bad) assert.equal(sanitizeShopRoomMessage(m, API_URL), null, JSON.stringify(m)?.slice(0, 80));
});

test('sanitize: drops a picture from another host and non-object goods, caps the name', () => {
  const m = sanitizeShopRoomMessage(show({ image: 'https://evil.example.net/x.png', goods: [{ id: 1 }, 'x', null, [2]], name: 'n'.repeat(500) }), API_URL);
  assert.equal(m.image, '');
  assert.deepEqual(m.goods, [{ id: 1 }]);
  assert.equal(m.name.length, 200);
  assert.equal(sanitizeShopRoomMessage(show({ image: 'javascript:alert(1)' }), API_URL).image, '');
  assert.equal(sanitizeShopRoomMessage(show({ name: '' }), API_URL).name, 'Shop');
  assert.equal(sanitizeShopRoomMessage(show({ layout: null }), API_URL).layout, null);
});

test('vendored widget keeps the contract the shim relies on', () => {
  const src = readFileSync(join(VENDOR, 'shop_room.js'), 'utf8');
  assert.match(src, /Chronicle\.register\('shop_room'/);
  assert.match(src, /Chronicle\.apiFetch\(ds\.roomEndpoint\)/);
  assert.match(src, /Chronicle\.apiFetch\(ds\.relationsEndpoint\)/);
  assert.match(src, /ds\.roomEndpoint \|\| ''\)\.split\('\/shops\/'\)/, 'room seed comes from the room endpoint');
  for (const key of ['shopName', 'shopImage', 'canArrange', 'campaignUrl']) assert.ok(src.includes(`ds.${key}`), key);
  // Saving goes through apiFetch with PUT, which the shim refuses.
  assert.match(src, /Chronicle\.apiFetch\(ds\.roomEndpoint, \{ method: 'PUT'/);
});

test('vendored drawing engine runs and draws a room', () => {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(VENDOR, 'shop_room_icons.js'), 'utf8'), sandbox);
  vm.runInContext(readFileSync(join(VENDOR, 'shop_room.js'), 'utf8'), sandbox);
  const SR = sandbox.ShopRoom;
  assert.ok(SR && typeof SR.createRoom === 'function');
  const S = { roomType: 'general', pal: 'oak', setting: 'room', fx: 'full', size: 'm', full: 'normal', deco: 'some', keep: true,
    seeds: { room: 1, goods: 1, deco: 1 }, pieces: [], ov: {}, portrait: null, lines: [], mode: 'shop', its: [], key: SR.keyOf(`${SHOP}/room`), name: 'Shop', dark: false };
  const room = SR.createRoom(S);
  room.generate();
  S.its = SR.shopItems([{ id: 1, targetEntityId: 'i', targetEntityName: 'Rope', metadata: { price: 1 } }], {}, room.MAT, sandbox.ShopRoomIcons);
  const out = room.draw();
  assert.match(out.svg, /^<defs>/);
});

const chronicleDir = process.env.CHRONICLE_DIR;
const chronicleWidgets = chronicleDir && join(resolve(chronicleDir), 'static', 'js', 'widgets');
test('vendored files match Chronicle (needs CHRONICLE_DIR)', { skip: !(chronicleWidgets && existsSync(chronicleWidgets)) && 'CHRONICLE_DIR not set' }, () => {
  for (const f of ['shop_room.js', 'shop_room_icons.js']) {
    assert.equal(readFileSync(join(VENDOR, f), 'utf8'), readFileSync(join(chronicleWidgets, f), 'utf8'),
      `vendor/chronicle/${f} differs from Chronicle's; copy it again from static/js/widgets/`);
  }
});
