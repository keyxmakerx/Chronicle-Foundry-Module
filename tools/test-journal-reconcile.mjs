#!/usr/bin/env node
/**
 * Connect-time journal catch-up: pages changed in Chronicle while Foundry
 * was away are applied, unchanged ones are skipped, and journals whose page
 * is gone are set aside only after a complete walk and a definite 404.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, makeJournal, installJournals } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

function make({ entities, getById = async (p) => ({ id: p.split('/').pop() }) }) {
  const js = new JournalSync();
  js._api = {
    get: async (path) => (path.startsWith('/entities?') ? (new URL('http://x' + path).searchParams.get('page') === '1' ? entities : []) : getById(path)),
  };
  js._syncManager = { _modules: [] };
  js._isHandledByActorSync = () => false;
  js._isExcluded = () => false;
  const updated = []; const created = [];
  js._onEntityUpdated = async (e) => { updated.push(e.id); };
  js._createJournalFromEntity = async (e) => { created.push(e.id); };
  return { js, updated, created };
}

test('changed pages update, unchanged ones are skipped, new ones are created', async () => {
  const same = makeJournal({ id: 'a', flags: { entityId: 'e-same', chronicleUpdatedAt: 'U1' } });
  const old = makeJournal({ id: 'b', flags: { entityId: 'e-old', chronicleUpdatedAt: 'U1' } });
  installJournals([same, old]);
  settings.lastSyncTime = '2026-05-01T00:00:00Z';
  const { js, updated, created } = make({ entities: [
    { id: 'e-same', updated_at: 'U1' }, { id: 'e-old', updated_at: 'U2' },
    { id: 'e-new', updated_at: 'U1', created_at: '2026-05-02T00:00:00Z' },
  ] });
  await js.onInitialSync();
  assert.deepEqual(updated, ['e-old']);
  assert.deepEqual(created, ['e-new']);
  settings.lastSyncTime = '';
});

test('a page older than the last sync with no journal is not recreated', async () => {
  // The GM deleted its journal here and kept the Chronicle page.
  installJournals([]);
  settings.lastSyncTime = '2026-05-01T00:00:00Z';
  const { js, created } = make({ entities: [
    { id: 'e-deleted-here', updated_at: 'U', created_at: '2026-04-01T00:00:00Z' },
    { id: 'e-no-date', updated_at: 'U' },
  ] });
  await js.onInitialSync();
  await js.onInitialSync();
  assert.deepEqual(created, []);
  settings.lastSyncTime = '';
});

test('a first connect creates nothing; importing is the wizard\'s job', async () => {
  installJournals([]);
  const { js, created } = make({ entities: [{ id: 'e1', updated_at: 'U', created_at: '2026-04-01T00:00:00Z' }] });
  await js.onInitialSync();
  assert.deepEqual(created, []);
});

test('a journal whose page returns 404 is set aside; other errors leave it alone', async () => {
  const gone = makeJournal({ id: 'g', flags: { entityId: 'e-gone' } });
  const flaky = makeJournal({ id: 'f', flags: { entityId: 'e-flaky' } });
  const kept = makeJournal({ id: 'k', flags: { entityId: 'e-kept' } });
  installJournals([gone, flaky, kept]);
  globalThis.game.folders = { find: () => ({ id: 'removed' }), contents: [] };
  const { js } = make({
    entities: [{ id: 'e-kept', updated_at: 'U' }],
    getById: async (path) => {
      if (path.endsWith('e-gone')) throw Object.assign(new Error('nf'), { status: 404 });
      if (path.endsWith('e-flaky')) throw Object.assign(new Error('boom'), { status: 500 });
      return {};
    },
  });
  await js.onInitialSync();
  assert.equal(gone.updates.at(-1)?.data.folder, 'removed');
  assert.equal(flaky.updates.length, 0);
  assert.equal(kept.updates.length, 0);
});

test('a failed entity list never sets anything aside', async () => {
  const j = makeJournal({ id: 'g', flags: { entityId: 'e-gone' } });
  installJournals([j]);
  const js = new JournalSync();
  js._api = { get: async () => { throw Object.assign(new Error('down'), { status: 503 }); } };
  js._syncManager = { _modules: [] };
  await assert.rejects(js.onInitialSync());
  assert.equal(j.updates.length, 0);
});

test('with syncJournals off the catch-up does nothing', async () => {
  settings.syncJournals = false;
  const { js, updated } = make({ entities: [{ id: 'x', updated_at: 'U' }] });
  await js.onInitialSync();
  assert.deepEqual(updated, []);
  settings.syncJournals = true;
});

test('a sync mapping whose journal was deleted here does not recreate it', async () => {
  installJournals([]);
  const { js, created } = make({ entities: [] });
  let fetched = 0;
  js._api.get = async () => { fetched++; return { id: 'e1', name: 'Gone' }; };
  await js.onSyncMapping({ chronicle_type: 'entity', chronicle_id: 'e1', external_id: 'deleted-journal' });
  assert.deepEqual(created, []);
  assert.equal(fetched, 0);
});
