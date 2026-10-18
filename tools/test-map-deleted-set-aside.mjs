#!/usr/bin/env node
/** A map deleted in Chronicle never deletes its JournalEntry: it is set aside or archived. */
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { apiUrl: 'http://localhost:8080', campaignId: 'camp-1', syncMaps: true };
const removed = { id: 'removed-folder', type: 'JournalEntry', getFlag: (_s, k) => k === 'removedFolder' };
globalThis.foundry ??= { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } } };
globalThis.CONST ??= { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
globalThis.Hooks ??= { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui ??= { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game ??= {};
Object.assign(globalThis.game, {
  settings: { get: (_m, k) => settings[k], set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  folders: { find: (fn) => (fn(removed) ? removed : null) },
});

const { MapSync } = await import('../scripts/map-sync.mjs');

function make(pins) {
  const calls = { deleted: false, entryUpdates: [], pageUpdates: [] };
  const entry = {
    name: 'Cellar Map',
    update: async (u) => { calls.entryUpdates.push(u); },
    delete: async () => { calls.deleted = true; },
  };
  const page = {
    name: 'Cellar',
    parent: entry,
    getFlag: (_s, k) => (k === 'pins' ? pins : undefined),
    update: async (u) => { calls.pageUpdates.push(u); },
  };
  const ms = new MapSync();
  ms.findPageByMapId = () => page;
  return { ms, calls };
}

test('no pins: the entry is unlinked and filed in the removed folder, not deleted', async () => {
  const { ms, calls } = make([]);
  await ms._onMapDeleted({ id: 'm1' });
  assert.equal(calls.deleted, false);
  assert.equal(calls.pageUpdates.length, 1);
  assert.ok('flags.chronicle-sync.-=mapId' in calls.pageUpdates[0]);
  assert.equal(calls.entryUpdates.length, 1);
  assert.equal(calls.entryUpdates[0].folder, 'removed-folder');
});

test('with pins: the entry is renamed (archived) and kept', async () => {
  const { ms, calls } = make([{ id: 'p' }]);
  await ms._onMapDeleted({ id: 'm1' });
  assert.equal(calls.deleted, false);
  assert.deepEqual(calls.entryUpdates, [{ name: 'Cellar Map (archived)' }]);
});
