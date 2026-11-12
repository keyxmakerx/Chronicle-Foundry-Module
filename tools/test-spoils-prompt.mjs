#!/usr/bin/env node
/**
 * Tests for the end-of-combat spoils prompt: the pure decisions in
 * scripts/_spoils-prompt.mjs, and scripts/spoils-prompt.mjs driven through
 * Foundry's deleteCombat hook with a stand-in combat, scene, dialog and
 * Chronicle. The rendered dialog itself needs a live Foundry client.
 *
 * Pins: nothing drops until "Put in the tray"; unticked rows stay out; a
 * combat of an encounter with stages still to come holds the defeated and
 * asks after the last stage or on "The whole fight is over"; a held creature
 * counts once; one call per confirmed prompt, never retried; heroes never
 * drop; a campaign with no drop lists sees nothing.
 *
 * Run: node --test tools/test-spoils-prompt.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  dropSummaries, dropText, fightBody, fightResult, fightRows, firstHp, heldCreatures, isDefeated, promptRows, stagesToCome,
} from '../scripts/_spoils-prompt.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---- Pure decisions --------------------------------------------------------

test('defeated: marked in the tracker, or Stamina or hit points at 0 or below', () => {
  assert.equal(isDefeated({ marked: true, hp: 12 }), true);
  assert.equal(isDefeated({ marked: false, hp: 0 }), true);
  assert.equal(isDefeated({ marked: false, hp: -3 }), true);
  assert.equal(isDefeated({ marked: false, hp: 1 }), false);
  assert.equal(isDefeated({ marked: false, hp: null }), false, 'no hit points is not 0 hit points');
  assert.equal(firstHp([undefined, null, '0', 7, 0]), 7, 'only real numbers count');
  assert.equal(firstHp([undefined, null]), null);
});

test('rows: one per page, counted once per creature, heroes and the standing left out', () => {
  const rows = fightRows([
    { id: 'a', name: 'Troll', pageId: 't1', defeated: true },
    { id: 'b', name: 'Bog rat 1', pageId: 'r1', defeated: true },
    { id: 'c', name: 'Bog rat 2', pageId: 'r1', defeated: false },
    { id: 'b', name: 'Bog rat 1', pageId: 'r1', defeated: false },
    { id: 'd', name: 'Cave bandit', defeated: true },
    { id: 'e', name: 'Mira', pageId: 'm1', defeated: true, playerOwned: true },
    { id: 'f', name: 'Goblin', pageId: 'g1', defeated: false },
  ]);
  assert.deepEqual(rows, [
    { key: 'page:t1', pageId: 't1', name: 'Troll', down: 1, copies: 1 },
    { key: 'page:r1', pageId: 'r1', name: 'Bog rat 1', down: 1, copies: 2 },
    { key: 'name:cave bandit', pageId: '', name: 'Cave bandit', down: 1, copies: 1 },
  ]);
});

test('held creatures: the defeated only, once each', () => {
  assert.deepEqual(heldCreatures([
    { id: 'a', name: 'Troll', pageId: 't1', defeated: true },
    { id: 'a', name: 'Troll', pageId: 't1', defeated: true },
    { id: 'b', name: 'Bog rat', pageId: 'r1', defeated: false },
    { id: 'c', name: 'Mira', defeated: true, playerOwned: true },
  ]), [{ id: 'a', name: 'Troll', pageId: 't1', defeated: true }]);
});

test('stages to come: those not started in this fight', () => {
  const stages = [{ id: 's1' }, { id: 's2' }];
  assert.equal(stagesToCome(stages, undefined), 2);
  assert.equal(stagesToCome(stages, { started: ['s1'] }), 1);
  assert.equal(stagesToCome(stages, { started: ['s1', 's2'] }), 0);
  assert.equal(stagesToCome([], { started: [] }), 0);
});

const WORDS = { harvest: '(harvest)', study: '(study first)', anItem: 'an item', also: 'plus what {name} drops' };
const SPOILS_PAGE = {
  items: [{ id: 'i1', name: 'Troll tooth' }, { id: 'i2', name: 'Drake hide' }, { id: 'i3', name: 'Rat pelt' }],
  drops: [
    { pageId: 't1', page: 'Troll', lines: [{ itemId: 'i1', mode: 'take', qty: 2 }, { itemId: 'i2', mode: 'harvest' }] },
    { pageId: 'r1', page: 'Bog rat', alsoName: 'Troll', lines: [{ itemId: 'i1', mode: 'take', qty: 1 }, { itemId: 'i3', mode: 'harvest', study: true }, { itemId: 'gone', mode: 'take', qty: 1 }] },
  ],
};

test('drop text reads as the signed mockup does', () => {
  const s = dropSummaries(SPOILS_PAGE);
  assert.equal(dropText(s.get('t1'), WORDS), '2 Troll tooth · Drake hide (harvest)');
  assert.equal(dropText(s.get('r1'), WORDS), 'Troll tooth · Rat pelt (harvest) (study first) · an item, plus what Troll drops');
  assert.equal(dropSummaries({}).size, 0);
});

test('prompt rows: a creature with no page, or a page with no drop list, cannot be ticked', () => {
  const view = promptRows([
    { key: 'page:t1', pageId: 't1', name: 'Troll 1', down: 1 },
    { key: 'page:x', pageId: 'x', name: 'Wolf', down: 2 },
    { key: 'name:cave bandit', pageId: '', name: 'Cave bandit', down: 1 },
  ], dropSummaries(SPOILS_PAGE));
  assert.deepEqual(view.map(({ key, name, can, why }) => ({ key, name, can, why })), [
    { key: 'page:t1', name: 'Troll', can: true, why: '' },
    { key: 'page:x', name: 'Wolf', can: false, why: 'NoDrops' },
    { key: 'name:cave bandit', name: 'Cave bandit', can: false, why: 'NoPage' },
  ]);
});

test('fight body: ticked rows with a page only; null when none', () => {
  const rows = [
    { key: 'page:t1', pageId: 't1', name: 'Troll', down: 2, copies: 1 },
    { key: 'page:r1', pageId: 'r1', name: 'Bog rat', down: 1, copies: 3 },
    { key: 'name:x', pageId: '', name: 'X', down: 1, copies: 1 },
  ];
  assert.deepEqual(fightBody('Bog road (Foundry)', rows, new Set(['page:t1', 'name:x'])), {
    name: 'Bog road (Foundry)', creatures: [{ pageId: 't1', name: 'Troll', down: 2, copies: 2 }],
  });
  assert.equal(fightBody('f', rows, new Set(['name:x'])), null);
  assert.equal(fightBody('f', rows, new Set()), null);
  assert.deepEqual(fightResult({ lines: ['a', 3, ''], spoils: 2 }), { lines: ['a'], spoils: 2 });
  assert.deepEqual(fightResult(null), { lines: [], spoils: 0 });
});

// ---- The flow, through deleteCombat ----------------------------------------

const FLAG = 'chronicle-sync';
const hooks = {};
const posts = [];
const gets = [];
const toasts = [];
const chats = [];
const dialogs = [];
let answers = [];
let chronicle = {};

function flagStore() {
  const flags = {};
  return {
    flags,
    getFlag: (scope, key) => flags[scope]?.[key],
    async setFlag(scope, key, value) {
      const parts = key.split('.');
      let o = (flags[scope] ??= {});
      for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
      o[parts.at(-1)] = structuredClone(value);
    },
    async unsetFlag(scope, key) {
      const parts = key.split('.');
      let o = flags[scope];
      for (const p of parts.slice(0, -1)) o = o?.[p];
      if (o) delete o[parts.at(-1)];
    },
  };
}

const scene = { id: 'sc1', name: 'Bog road', ...flagStore() };

function actor({ hp = null, page = '', player = false } = {}) {
  return {
    hasPlayerOwner: player,
    system: { attributes: { hp: { value: hp } } },
    getFlag: (scope, key) => (scope === FLAG && key === 'creatureEntityId' ? page : undefined),
  };
}

function combatant(id, name, { hp, page, player, defeated = false, enc } = {}) {
  return {
    id: `cb-${id}`,
    tokenId: id,
    name,
    isDefeated: defeated,
    actor: actor({ hp, page, player }),
    token: { name, getFlag: (scope, key) => (scope === FLAG && key === 'encounterToken' ? enc : undefined) },
  };
}

let combatSeq = 0;
function combat(combatants, { started = true } = {}) {
  return { id: `c${++combatSeq}`, started, scene, combatants };
}

const gm = { id: 'gm', isGM: true };
globalThis.game = {
  user: gm,
  users: { activeGM: gm },
  scenes: { get: () => scene },
  settings: { get: (_m, key) => (key === 'craftingAvailable' ? chronicle.available !== false : null), register() {} },
  i18n: {
    localize: (k) => k,
    format: (k, data) => `${k}${Object.entries(data).map(([a, b]) => ` ${a}=${b}`).join('')}`,
  },
};
globalThis.Hooks = { on: (name, fn) => { (hooks[name] ??= []).push(fn); }, once() {} };
globalThis.ui = { notifications: { info: (m) => toasts.push(['info', m]), error: (m) => toasts.push(['error', m]) } };
globalThis.ChatMessage = { create: (m) => chats.push(m), getWhisperRecipients: () => [{ id: 'gm' }] };
globalThis.foundry = {
  utils: { getProperty: (o, p) => p.split('.').reduce((a, k) => a?.[k], o) },
  applications: { api: {
    ApplicationV2: class {},
    HandlebarsApplicationMixin: (c) => c,
    DialogV2: {
      // Presses the next scripted answer; `untick` leaves those rows out.
      async wait({ window, content, buttons }) {
        dialogs.push({ title: window.title, content });
        const a = answers.shift();
        if (!a) return null;
        const checked = [...content.matchAll(/value="([^"]+)" checked/g)].map((m) => m[1].replace(/&quot;/g, '"'))
          .filter((v) => !(a.untick ?? []).includes(v)).map((value) => ({ value }));
        const button = buttons.find((b) => b.action === a.press);
        return button.callback(null, null, { element: { querySelectorAll: () => checked } });
      },
    },
  } },
};

const { CraftingSync } = await import('../scripts/crafting-relay.mjs');
const { registerSpoilsPrompt } = await import('../scripts/spoils-prompt.mjs');

const sync = new CraftingSync();
await sync.init({
  async get(path) {
    gets.push(path);
    if (path === '/crafting/spoils') return chronicle.spoils ?? SPOILS_PAGE;
    const enc = chronicle.encounters?.[decodeURIComponent(path.replace('/encounters/', ''))];
    if (!enc) throw Object.assign(new Error('not found'), { status: 404 });
    return enc;
  },
  async post(path, body) {
    posts.push({ path, body });
    if (chronicle.postFails) throw Object.assign(new Error('boom'), { status: 500, serverMessage: 'Chronicle is down.' });
    return { lines: ['Troll left spoils in the tray: 2 × Troll tooth, Drake hide to harvest.'], spoils: body.creatures.length };
  },
});
registerSpoilsPrompt();

async function endCombat(c) {
  for (const fn of hooks.deleteCombat) fn(c);
  await new Promise((r) => setTimeout(r, 10));
}

function reset(opts = {}) {
  posts.length = 0; gets.length = 0; toasts.length = 0; chats.length = 0; dialogs.length = 0;
  answers = opts.answers ?? [];
  chronicle = opts.chronicle ?? {};
  game.user = gm;
  game.users.activeGM = gm;
}

const plainFight = () => combat([
  combatant('a', 'Troll', { hp: 0, page: 't1' }),
  combatant('b', 'Bog rat 1', { hp: 4, page: 'r1', defeated: true }),
  combatant('c', 'Bog rat 2', { hp: 0, page: 'r1' }),
  combatant('d', 'Cave bandit', { hp: 0 }),
  combatant('e', 'Mira Ashdown', { hp: 0, page: 'm1', player: true }),
  combatant('f', 'Goblin', { hp: 5, page: 'g1' }),
]);

test('a combat ends: one prompt, the ticked rows go in with one call, and the GMs are told', async () => {
  reset({ answers: [{ press: 'put', untick: [] }] });
  await endCombat(plainFight());
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'CHRONICLE.Spoils.Title');
  const html = dialogs[0].content;
  assert.match(html, /value="page:t1" checked/);
  assert.match(html, /value="page:r1" checked/);
  assert.match(html, /value="name:cave bandit" disabled/, 'a creature with no page is shown but cannot be ticked');
  assert.doesNotMatch(html, /Mira|Goblin/, 'heroes and creatures still standing are not listed');
  assert.match(html, /2 Troll tooth · Drake hide CHRONICLE\.Spoils\.Harvest/);
  assert.match(html, /CHRONICLE\.Spoils\.Down n=2/);
  assert.deepEqual(posts, [{ path: '/crafting/fights', body: {
    name: 'CHRONICLE.Spoils.FightName name=Bog road',
    creatures: [{ pageId: 't1', name: 'Troll', down: 1, copies: 1 }, { pageId: 'r1', name: 'Bog rat 1', down: 2, copies: 2 }],
  } }]);
  assert.deepEqual(toasts, [['info', 'CHRONICLE.Spoils.Done n=2']]);
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0].whisper, ['gm']);
  assert.match(chats[0].content, /Troll left spoils in the tray/);
});

test('an unticked row stays out; "Not now" and closing the window send nothing', async () => {
  reset({ answers: [{ press: 'put', untick: ['page:r1'] }] });
  await endCombat(plainFight());
  assert.deepEqual(posts.map((p) => p.body.creatures.map((c) => c.pageId)), [['t1']]);

  reset({ answers: [{ press: 'later' }] });
  await endCombat(plainFight());
  assert.equal(dialogs.length, 1);
  assert.deepEqual(posts, []);

  reset({ answers: [] });
  await endCombat(plainFight());
  assert.equal(dialogs.length, 1);
  assert.deepEqual(posts, []);
});

test('nothing is asked off the answering GM, for a combat never started, with crafting off, or with no drop lists', async () => {
  reset({ answers: [{ press: 'put' }] });
  game.users.activeGM = { id: 'other-gm', isGM: true };
  await endCombat(plainFight());
  game.user = { id: 'p1', isGM: false };
  await endCombat(plainFight());
  reset({ answers: [{ press: 'put' }] });
  await endCombat(combat(plainFight().combatants, { started: false }));
  reset({ answers: [{ press: 'put' }], chronicle: { available: false } });
  await endCombat(plainFight());
  reset({ answers: [{ press: 'put' }], chronicle: { spoils: { drops: [], items: [] } } });
  await endCombat(plainFight());
  assert.deepEqual(dialogs, []);
  assert.deepEqual(posts, []);
});

test('a failed call says so and is not retried', async () => {
  reset({ answers: [{ press: 'put' }], chronicle: { postFails: true } });
  await endCombat(plainFight());
  assert.equal(posts.length, 1);
  assert.deepEqual(toasts, [['error', 'CHRONICLE.Spoils.Failed reason=Chronicle is down.']]);
});

const ENC = {
  id: 'e1',
  name: 'Bridge ambush',
  creatures: [{ id: 'row-t', entityId: 't1', name: 'Troll', count: 1 }, { id: 'row-r', entityId: 'r1', name: 'Bog rat', count: 2 }],
  stages: [{ id: 's1', when: { kind: 'manual' }, arrive: ['row-r'] }],
};
const ref = (rowId, n = 1) => ({ encounterId: 'e1', rowId, n });

test('stages still to come: the defeated are held, then asked about after the last stage, each counted once', async () => {
  reset({ answers: [{ press: 'hold' }], chronicle: { encounters: { e1: ENC } } });
  await endCombat(combat([
    combatant('a', 'Troll', { hp: 0, enc: ref('row-t') }),
    combatant('e', 'Mira Ashdown', { hp: 3, page: 'm1', player: true }),
  ]));
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'CHRONICLE.Spoils.HoldTitle');
  assert.match(dialogs[0].content, /HoldOne name=Bridge ambush/);
  assert.deepEqual(posts, []);
  assert.ok(!gets.includes('/crafting/spoils'), 'holding reads no drop lists');
  assert.deepEqual(scene.flags[FLAG].craftingHeld.e1.creatures, [{ id: 'a', name: 'Troll', pageId: 't1', defeated: true }]);

  // The stage starts; the next combat of the encounter has the Troll's token again.
  await scene.setFlag(FLAG, 'encounterStages.e1', { started: ['s1'], notYet: {} });
  reset({ answers: [{ press: 'put' }], chronicle: { encounters: { e1: ENC } } });
  await endCombat(combat([
    combatant('a', 'Troll', { hp: 0, enc: ref('row-t') }),
    combatant('r1', 'Bog rat', { hp: 0, enc: ref('row-r', 1) }),
    combatant('r2', 'Bog rat', { hp: 2, enc: ref('row-r', 2) }),
  ]));
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'CHRONICLE.Spoils.Title');
  assert.deepEqual(posts.map((p) => p.body), [{
    name: 'CHRONICLE.Spoils.FightName name=Bridge ambush',
    creatures: [{ pageId: 't1', name: 'Troll', down: 1, copies: 1 }, { pageId: 'r1', name: 'Bog rat', down: 1, copies: 2 }],
  }]);
  assert.equal(scene.flags[FLAG].craftingHeld.e1, undefined, 'the held creatures are cleared once asked about');
});

test('"The whole fight is over" asks at once; "Not now" after holding clears the held', async () => {
  await scene.setFlag(FLAG, 'encounterStages.e1', { started: [], notYet: {} });
  reset({ answers: [{ press: 'over' }, { press: 'put' }], chronicle: { encounters: { e1: ENC } } });
  await endCombat(combat([combatant('a', 'Troll', { hp: 0, enc: ref('row-t') })]));
  assert.deepEqual(dialogs.map((d) => d.title), ['CHRONICLE.Spoils.HoldTitle', 'CHRONICLE.Spoils.Title']);
  assert.equal(posts.length, 1);

  reset({ answers: [{ press: 'hold' }], chronicle: { encounters: { e1: ENC } } });
  await endCombat(combat([combatant('a', 'Troll', { hp: 0, enc: ref('row-t') })]));
  assert.ok(scene.flags[FLAG].craftingHeld.e1);
  reset({ answers: [{ press: 'over' }, { press: 'later' }], chronicle: { encounters: { e1: ENC } } });
  await endCombat(combat([combatant('b', 'Bog rat', { hp: 0, enc: ref('row-r') })]));
  assert.match(dialogs[1].content, /value="page:t1" checked/, 'the held Troll is in the prompt');
  assert.deepEqual(posts, []);
  assert.equal(scene.flags[FLAG].craftingHeld.e1, undefined);
});

test('wiring: registered with crafting, and every string it uses is in lang/en.json', () => {
  assert.match(read('scripts/module.mjs'), /registerSpoilsPrompt\(\);/);
  const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Spoils;
  const src = read('scripts/spoils-prompt.mjs');
  const keys = new Set([...src.matchAll(/\b[tf]\('([A-Za-z]+)'/g)].map((m) => m[1]));
  for (const k of ['NoPage', 'NoDrops']) keys.add(k);
  for (const k of keys) assert.ok(typeof lang[k] === 'string', `CHRONICLE.Spoils.${k} missing`);
  // The held creatures are cleared before the one call, so nothing re-sends it.
  assert.ok(src.indexOf('await clearHeld(scene, encIds);\n  if (!ticked') < src.indexOf("api.post('/crafting/fights'"));
});
