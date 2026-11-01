#!/usr/bin/env node
/**
 * The Satchel's Crafting tab runs Chronicle's own Crafting block, vendored
 * under vendor/chronicle/, and relays a player's calls through the active
 * GM's client. These pin which block calls become which Chronicle calls,
 * that a relayed request is rebuilt from known fields only (so it can never
 * name another member), the checks on the answer, the GM's chat lines, the
 * GM-side wiring's order of checks, and the stand-in's routing.
 *
 * With CHRONICLE_DIR pointing at a Chronicle checkout, the vendored files are
 * also compared byte for byte with Chronicle's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

import {
  CRAFT_MESSAGE, changesPack, craftActionFor, craftingProbeVerdict, describeCraft, planCraftCall,
  sanitizeCraftReply, sanitizeCraftRequest,
} from '../scripts/_craft-relay.mjs';
import { createChronicleShim } from '../scripts/_shop-room-data.mjs';
import { generateRequestKeys } from '../scripts/_stash-crypto.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'chronicle');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const CAMP = '11111111-2222-3333-4444-555555555555';
const HERO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BASE = `/campaigns/${CAMP}/crafting`;
const { publicJwk } = await generateRequestKeys();

test('each of the block\'s calls becomes one relay action', () => {
  assert.deepEqual(craftActionFor(BASE, `${BASE}/characters/${HERO}`, 'GET'), { action: 'view', characterId: HERO });
  assert.deepEqual(craftActionFor(BASE, `${BASE}/characters/${HERO}/projects`, 'POST', { recipeId: 'r1', picks: { 1: 'i1' }, extra: 1 }),
    { action: 'start', characterId: HERO, body: { recipeId: 'r1', picks: { 1: 'i1' } } });
  assert.deepEqual(craftActionFor(BASE, `${BASE}/projects/p1/roll`, 'POST', { work: 'clean', bench: 'b1', version: 4 }),
    { action: 'roll', projectId: 'p1', body: { work: 'clean', bench: 'b1', version: 4 } });
  assert.deepEqual(craftActionFor(BASE, `${BASE}/projects/p1`, 'DELETE'), { action: 'cancel', projectId: 'p1' });
  assert.deepEqual(craftActionFor(BASE, `${BASE}/spoil-lines/12/take`, 'POST', { characterId: HERO }), { action: 'take', lineId: 12, characterId: HERO });
  assert.deepEqual(craftActionFor(BASE, `${BASE}/spoil-lines/12/study`, 'POST', { characterId: HERO }), { action: 'study', lineId: 12, characterId: HERO });
});

test('the Director\'s calls and anything else are not relayed', () => {
  for (const [url, method] of [
    [`${BASE}/spoils`, 'GET'], [`${BASE}/spoils`, 'POST'], [`${BASE}/spoil-lines/12/reveal`, 'POST'],
    [`${BASE}/spoil-lines/12`, 'DELETE'], [`${BASE}/recipes`, 'GET'], [`${BASE}/projects/p1/rolls`, 'POST'],
    [`${BASE}/characters/${HERO}`, 'POST'], [`${BASE}/projects/p1/roll`, 'GET'], ['/campaigns/other/crafting/spoils', 'GET'],
    [`${BASE}/characters/${HERO}/projects/x`, 'POST'], [`${BASE}/spoil-lines/12/take/more`, 'POST'],
  ]) assert.equal(craftActionFor(BASE, url, method, {}), null, `${method} ${url}`);
});

const req = (extra) => ({ type: CRAFT_MESSAGE, requestId: 'r1', publicKey: publicJwk, characterId: HERO, ...extra });

test('a request is rebuilt from the fields its action takes; a named member never passes', () => {
  const view = sanitizeCraftRequest(req({ action: 'view', actingUserId: 'gm', userId: 'gm', body: { actingUserId: 'gm' } }));
  assert.deepEqual(Object.keys(view).sort(), ['action', 'characterId', 'publicKey', 'requestId']);
  const start = sanitizeCraftRequest(req({ action: 'start', body: { recipeId: 'r1', picks: { 0: 'i1', 2: 'i2' }, actingUserId: 'gm' } }));
  assert.deepEqual(start.body, { recipeId: 'r1', picks: { 0: 'i1', 2: 'i2' } });
  const roll = sanitizeCraftRequest(req({ action: 'roll', projectId: 'p1', body: { work: 'steady', version: 3, actingUserId: 'gm' } }));
  assert.deepEqual(roll.body, { work: 'steady', bench: '', version: 3 });
  const take = sanitizeCraftRequest(req({ action: 'take', lineId: 7, body: { characterId: 'someone-else' } }));
  assert.deepEqual({ lineId: take.lineId, characterId: take.characterId, body: take.body }, { lineId: 7, characterId: HERO, body: undefined });
  assert.ok(sanitizeCraftRequest(req({ action: 'cancel', projectId: 'p1' })));
  assert.ok(sanitizeCraftRequest(req({ action: 'study', lineId: '9' })));
});

test('a malformed request is dropped', () => {
  const bad = [
    req({ action: 'reveal' }), req({ action: 'view', type: 'stash:request' }),
    req({ action: 'view', publicKey: null }), req({ action: 'view', characterId: '../x' }), req({ action: 'view', requestId: '' }),
    req({ action: 'start', body: { recipeId: '' } }), req({ action: 'start', body: { recipeId: 'r', picks: { x: 'i' } } }),
    req({ action: 'start', body: { recipeId: 'r', picks: { '01': 'i' } } }), req({ action: 'start', body: { recipeId: 'r', picks: { 100: 'i' } } }),
    req({ action: 'start', body: { recipeId: 'r', picks: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [i, 'i'])) } }),
    req({ action: 'roll', projectId: 'p', body: { work: 'magic', version: 1 } }), req({ action: 'roll', projectId: 'p', body: { version: 1 } }), req({ action: 'roll', projectId: 'p', body: { work: 'clean' } }),
    req({ action: 'roll', projectId: 'p', body: { work: 'clean', bench: 'a b', version: 1 } }), req({ action: 'roll', body: { version: 1 } }),
    req({ action: 'cancel' }), req({ action: 'take', lineId: 0 }), req({ action: 'take', lineId: -3 }), req({ action: 'study', lineId: 1.5 }),
    null, 'craft',
  ];
  for (const m of bad) assert.equal(sanitizeCraftRequest(m), null, JSON.stringify(m)?.slice(0, 120));
});

test('the Chronicle call names the member only when relayed for a player', () => {
  const r = (extra) => sanitizeCraftRequest(req(extra));
  assert.deepEqual(planCraftCall(r({ action: 'view' }), 'u 1'), { method: 'GET', path: `/crafting/characters/${HERO}?actingUserId=u%201` });
  assert.deepEqual(planCraftCall(r({ action: 'view' })), { method: 'GET', path: `/crafting/characters/${HERO}` });
  assert.deepEqual(planCraftCall(r({ action: 'start', body: { recipeId: 'r1' } }), 'u1'),
    { method: 'POST', path: `/crafting/characters/${HERO}/projects`, body: { recipeId: 'r1', picks: {}, actingUserId: 'u1' } });
  assert.deepEqual(planCraftCall(r({ action: 'roll', projectId: 'p1', body: { work: 'clean', bench: 'b1', version: 2 } }), 'u1'),
    { method: 'POST', path: '/crafting/projects/p1/roll', body: { work: 'clean', bench: 'b1', version: 2, actingUserId: 'u1' } });
  assert.deepEqual(planCraftCall(r({ action: 'cancel', projectId: 'p1' }), 'u1'), { method: 'DELETE', path: '/crafting/projects/p1?actingUserId=u1' });
  assert.deepEqual(planCraftCall(r({ action: 'take', lineId: 5 }), 'u1'),
    { method: 'POST', path: '/crafting/spoil-lines/5/take', body: { characterId: HERO, actingUserId: 'u1' } });
  assert.deepEqual(planCraftCall(r({ action: 'study', lineId: 5 })),
    { method: 'POST', path: '/crafting/spoil-lines/5/study', body: { characterId: HERO } });
});

test('an answer is checked before the block reads it', () => {
  assert.deepEqual(sanitizeCraftReply({ status: 200, body: { hero: 'Mira' } }, 'take'), { status: 200, body: { hero: 'Mira' } });
  assert.deepEqual(sanitizeCraftReply({ status: 204, body: null }, 'cancel'), { status: 204, body: null });
  assert.equal(sanitizeCraftReply({ status: 99, body: {} }, 'take'), null);
  assert.equal(sanitizeCraftReply({ status: 200, body: [1] }, 'take'), null);
  assert.equal(sanitizeCraftReply({ status: 200, body: 'x' }, 'take'), null);
  const big = { text: 'x'.repeat(70 * 1024) };
  assert.equal(sanitizeCraftReply({ status: 200, body: big }, 'take'), null, 'a write answer is small');
  assert.ok(sanitizeCraftReply({ status: 200, body: big }, 'view'), 'the hero\'s view may be large');
});

test('the GM hears about takes, harvests, studies and finished projects only', () => {
  assert.equal(describeCraft({ action: 'take', who: 'Sam', result: { hero: 'Mira Ashdown', item: 'Troll tooth', got: '2 × Troll tooth' } }),
    'Mira Ashdown (Sam) took 2 × Troll tooth.');
  assert.equal(describeCraft({ action: 'take', who: 'Mira Ashdown', result: { hero: 'Mira Ashdown', item: 'Drake hide', got: '2 × Drake hide', dice: [7, 4], total: 13 } }),
    'Mira Ashdown harvested Drake hide (rolled 13): 2 × Drake hide.');
  assert.equal(describeCraft({ action: 'take', result: { hero: 'Mira', item: 'Drake hide', got: 'nothing', dice: [1, 2], total: 3 } }),
    'Mira harvested Drake hide (rolled 3) and got nothing.');
  assert.equal(describeCraft({ action: 'study', result: { hero: 'Mira', total: 14, known: true, item: 'Remnant ash' } }),
    'Mira studied a find (rolled 14) and identified it as Remnant ash.');
  assert.equal(describeCraft({ action: 'study', result: { hero: 'Mira', total: 6, lost: true } }), 'Mira studied a find (rolled 6) and it was lost.');
  assert.equal(describeCraft({ action: 'study', result: { hero: 'Mira', total: 9 } }), 'Mira studied a find (rolled 9) and didn\'t identify it.');
  assert.equal(describeCraft({ action: 'roll', result: { project: { hero: 'Mira', name: 'Healing potion', status: 'made', makes: '1 × Healing potion' } } }),
    'Mira finished Healing potion: 1 × Healing potion.');
  assert.equal(describeCraft({ action: 'roll', result: { project: { hero: 'Mira', status: 'active' } } }), '');
  for (const action of ['view', 'start', 'cancel']) assert.equal(describeCraft({ action, result: {} }), '');
});

test('the actor is re-read when the pack changed', () => {
  assert.equal(changesPack('take', {}), true);
  assert.equal(changesPack('start', {}), true);
  assert.equal(changesPack('roll', { project: { status: 'made' } }), true);
  assert.equal(changesPack('roll', { project: { status: 'active' } }), false);
  assert.equal(changesPack('study', { known: true }), false);
  assert.equal(changesPack('view', {}), false);
});

test('the probe hides the tab only for an old Chronicle or crafting switched off', () => {
  assert.equal(craftingProbeVerdict({}), true);
  assert.equal(craftingProbeVerdict({ error: { status: 404 } }), false);
  assert.equal(craftingProbeVerdict({ error: { status: 403, code: 'addon_disabled' } }), false);
  assert.equal(craftingProbeVerdict({ error: { status: 403, code: 'forbidden' } }), null, 'a key that is not the Director\'s says nothing');
  assert.equal(craftingProbeVerdict({ error: { status: 502 } }), null);
});

test('the stand-in routes a prefix to its handler and leaves the shop\'s paths alone', async () => {
  const shim = createChronicleShim();
  const seen = [];
  shim.setRoute(`${BASE}/`, (url, method, body) => { seen.push([url, method, body]); return { status: 201, body: { ok: 1 } }; });
  const res = await shim.apiFetch(`${BASE}/characters/${HERO}/projects`, { method: 'post', body: { recipeId: 'r' } });
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.deepEqual(seen, [[`${BASE}/characters/${HERO}/projects`, 'POST', { recipeId: 'r' }]]);
  shim.setRoute(`${BASE}/`, null);
  assert.equal((await shim.apiFetch(`${BASE}/characters/${HERO}`)).status, 404);
});

test('the stand-in mounts a loaded widget and reports one that is not loaded', () => {
  const shim = createChronicleShim();
  const calls = [];
  shim.register('known', { init: (el, cfg) => calls.push(['init', cfg]), destroy: () => calls.push(['destroy']) });
  const fired = [];
  const el = (slug) => ({
    dataset: { campaignId: CAMP, entityId: HERO },
    getAttribute: () => slug,
    dispatchEvent: (e) => fired.push([e.type, e.detail, e.bubbles]),
  });
  const known = el('known');
  shim.mountWidget(known);
  shim.destroyWidget(known);
  assert.deepEqual(calls, [['init', { campaignId: CAMP, entityId: HERO }], ['destroy']]);
  shim.mountWidget(el('craft_bench'));
  assert.deepEqual(fired, [['chronicle:missing-widget', { widget: 'craft_bench' }, true]]);
});

test('the vendored block registers itself on the stand-in', () => {
  const shim = createChronicleShim();
  const sandbox = { Chronicle: shim, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['crafting_lib.js', 'crafting_tray.js', 'crafting_block.js']) vm.runInContext(readFileSync(join(VENDOR, f), 'utf8'), sandbox);
  const def = shim.widgets.get('crafting-block');
  assert.equal(typeof def?.init, 'function');
  assert.equal(typeof def?.destroy, 'function');
  // The calls the block makes, which craftActionFor must know.
  const block = readFileSync(join(VENDOR, 'crafting_block.js'), 'utf8');
  for (const call of ["api('GET', '/characters/'", "api('POST', '/projects/' + encodeURIComponent(pid) + '/roll'",
    "api('POST', '/spoil-lines/' + encodeURIComponent(lid) + '/take'", "api('POST', '/spoil-lines/' + encodeURIComponent(lid) + '/study'",
    "api('POST', '/characters/' + encodeURIComponent(eid) + '/projects'", "api('DELETE', '/projects/' + encodeURIComponent(pid))"]) {
    assert.ok(block.includes(call), `the block still calls ${call}`);
  }
  assert.match(block, /var base = '\/campaigns\/' \+ encodeURIComponent\(cid\) \+ '\/crafting';/);
  assert.match(block, /Chronicle\.mountWidget\(benchEl\);/);
});

test('the GM side checks the sender, the member and ownership before calling Chronicle', () => {
  const src = read('scripts/crafting-relay.mjs');
  const handle = src.slice(src.indexOf('async handleRequest('), src.indexOf('async run('));
  const order = ['sanitizeCraftRequest(data)', 'user.isGM', 'chronicleUserFor(getUserMappings(), senderId)', 'this._userOwns(user, req.characterId)', 'this.run(req, acting, user)'];
  let at = -1;
  for (const step of order) {
    const i = handle.indexOf(step);
    assert.ok(i > at, `${step} comes in order`);
    at = i;
  }
  // Only the active GM answers, answers count only from a GM, and they are encrypted to the asker.
  assert.match(src, /if \(isAnsweringGM\(game\.user, game\.users\.activeGM\)\) instance\?\.handleRequest\(data, senderId\);/);
  assert.match(src, /game\.users\.get\(senderId\)\?\.isGM === true && data\.toUserId === game\.user\.id/);
  assert.match(src, /encryptReply\(req\.publicKey, res\)/);
  // The tab can only speak for its own hero.
  const tab = read('scripts/crafting-tab.mjs');
  assert.match(tab, /a\.characterId !== undefined && a\.characterId !== entityId/);
  assert.match(tab, /craftRequest\(\{ \.\.\.a, characterId: entityId \}\)/);
});

test('the narrow-window rules are Chronicle\'s phone rules for the block', () => {
  const mine = read('styles/crafting.css');
  const from = mine.indexOf('@container (max-width: 720px)');
  const narrow = mine.slice(from, mine.indexOf('\n}\n', from));
  const phone = ['crafting.css', 'spoils.css'].map((f) => {
    const css = readFileSync(join(VENDOR, f), 'utf8');
    return css.slice(css.lastIndexOf('@media (max-width: 720px)'));
  }).join('\n');
  const rules = [...narrow.matchAll(/\.cs-craft ([^,{]+?)\s*(?=[,{])/g)];
  assert.ok(rules.length >= 8, 'the narrow rules are there');
  for (const [, selector] of rules) assert.ok(phone.includes(selector.trim()), `${selector.trim()} is one of Chronicle's phone rules`);
});

const chronicleDir = process.env.CHRONICLE_DIR;
const crafting = chronicleDir && join(resolve(chronicleDir), 'internal', 'plugins', 'crafting', 'static');
test('vendored files match Chronicle (needs CHRONICLE_DIR)', { skip: !(crafting && existsSync(crafting)) && 'CHRONICLE_DIR not set' }, () => {
  for (const [f, from] of [['crafting_lib.js', 'js'], ['crafting_tray.js', 'js'], ['crafting_block.js', 'js'], ['crafting.css', 'css'], ['spoils.css', 'css']]) {
    assert.equal(readFileSync(join(VENDOR, f), 'utf8'), readFileSync(join(crafting, from, f), 'utf8'),
      `vendor/chronicle/${f} differs from Chronicle's; copy it again from internal/plugins/crafting/static/${from}/`);
  }
});
