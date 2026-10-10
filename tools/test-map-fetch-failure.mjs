#!/usr/bin/env node
/**
 * A map list that fails to fetch is unknown, not empty: the stored player
 * copy of that list is left as it was and the GM cache keeps its last copy.
 * Lists that arrive replace the old ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { apiUrl: 'http://localhost:8080', campaignId: 'camp-1', syncMaps: true };
globalThis.foundry ??= { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } } };
globalThis.CONST ??= { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
globalThis.Hooks ??= { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui ??= { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game ??= {
  settings: { get: (_m, k) => settings[k], set: (_m, k, v) => { settings[k] = v; }, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  journal: { contents: [] },
};

const { MapSync } = await import('../scripts/map-sync.mjs');
const { flagListsToWrite } = await import("../scripts/_map-flag-filter.mjs");

const MARKER = { id: 'mk1', name: 'Inn', x: 10, y: 10, visibility: 'everyone' };
const TOKEN = { id: 'tk1', name: 'Hero', x: 5, y: 5, is_hidden: false };
const LAYER = { id: 'ly1', name: 'Ground' };

/**
 * A MapSync whose API answers each list from `answers` (an Error rejects
 * like a server error) and whose page records the last flag update.
 */
function make({ answers, flags = {} }) {
  const ms = new MapSync();
  const page = {
    getFlag: (_s, k) => flags[k],
    update: async (u) => { page.updates = u; },
    updates: null,
  };
  ms.findPageByMapId = () => page;
  ms._logError = () => {};
  ms._noteShadows = async () => {};
  ms._api = {
    get: async (path) => {
      const kind = path.split('/').pop();
      const a = answers[kind];
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  };
  return { ms, page };
}

const fail = () => Object.assign(new Error('boom'), { status: 500 });
const KEY = (k) => `flags.chronicle-sync.${k}`;

test('flagListsToWrite: a failed list is never written; markers also need the drawings', () => {
  const cases = [
    [{}, { markers: true, drawings: true, tokens: true, layers: true }],
    [{ markers: false }, { markers: false, drawings: true, tokens: true, layers: true }],
    [{ tokens: false }, { markers: true, drawings: true, tokens: false, layers: true }],
    [{ layers: false }, { markers: true, drawings: true, tokens: true, layers: false }],
    [{ drawings: false }, { markers: false, drawings: false, tokens: true, layers: true }],
    [{ markers: false, drawings: false, tokens: false, layers: false }, { markers: false, drawings: false, tokens: false, layers: false }],
  ];
  for (const [known, want] of cases) assert.deepEqual(flagListsToWrite(known), want, JSON.stringify(known));
});

test('failed markers, tokens and layers leave the stored player copy alone', async () => {
  const { ms, page } = make({ answers: { markers: fail(), drawings: [], tokens: fail(), layers: fail(), fog: null } });
  const { complete } = await ms._refreshSubResources('m1');
  assert.equal(complete, false);
  for (const k of ['chronicleMarkers', 'chronicleTokens', 'chronicleLayers']) {
    assert.equal(KEY(k) in (page.updates || {}), false, k);
  }
  assert.deepEqual(page.updates[KEY('chronicleDrawings')], []);
});

test('a failed list keeps the GM cache copy', async () => {
  const { ms } = make({ answers: { markers: fail(), drawings: [], tokens: fail(), layers: fail(), fog: fail() } });
  ms._cache.set('m1', { markers: [MARKER], tokens: [TOKEN], layers: [LAYER], fog: { x: 1 } });
  await ms._refreshSubResources('m1');
  const c = ms._cache.get('m1');
  assert.deepEqual([c.markers, c.tokens, c.layers, c.fog], [[MARKER], [TOKEN], [LAYER], { x: 1 }]);
});

test('lists that arrive replace the old ones; Chronicle\'s null is empty', async () => {
  const { ms, page } = make({
    answers: { markers: null, drawings: [], tokens: [], layers: null, fog: null },
    flags: { chronicleMarkers: [MARKER] },
  });
  const { complete } = await ms._refreshSubResources('m1');
  assert.equal(complete, true);
  for (const k of ['chronicleMarkers', 'chronicleTokens', 'chronicleLayers']) assert.deepEqual(page.updates[KEY(k)], [], k);
});

test('one failed list does not hold back the others', async () => {
  const { ms, page } = make({ answers: { markers: [MARKER], drawings: [], tokens: fail(), layers: [LAYER], fog: null } });
  await ms._refreshSubResources('m1');
  assert.deepEqual(page.updates[KEY('chronicleMarkers')].map((m) => m.id), ['mk1']);
  assert.deepEqual(page.updates[KEY('chronicleLayers')], [LAYER]);
  assert.equal(KEY('chronicleTokens') in page.updates, false);
});

test('failed drawings still leave markers and drawings untouched', async () => {
  const { ms, page } = make({ answers: { markers: [MARKER], drawings: fail(), tokens: [], layers: [], fog: null } });
  await ms._refreshSubResources('m1');
  assert.equal(KEY('chronicleMarkers') in page.updates, false);
  assert.equal(KEY('chronicleDrawings') in page.updates, false);
});
