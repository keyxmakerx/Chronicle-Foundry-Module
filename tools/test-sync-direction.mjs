#!/usr/bin/env node
/**
 * Direction and "Sync changes as they happen": which parts see a Chronicle
 * message, what a Foundry change does (sent, kept for "Sync now", or left in
 * Foundry), and what "Sync now" sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal, installJournals, settings } from './_journal-test-env.mjs';

const { SyncManager } = await import('../scripts/sync-manager.mjs');
const { JournalSync } = await import('../scripts/journal-sync.mjs');

globalThis.Hooks.callAll = () => {};

function setUp({ journals = 'both', live = true } = {}) {
  settings.syncDirections = JSON.stringify({ journals, maps: 'both', calendar: 'both', characters: 'both', shops: 'both' });
  settings.autoSync = live;
  settings.heldChanges = '[]';
  settings.conflictResolution = 'chronicle';
}

function makeManager(opts) {
  setUp(opts);
  const sm = new SyncManager();
  sm.logActivity = () => {};
  sm._recordApplied = () => {};
  sm.fetchAndCacheMembers = async () => {};
  return sm;
}

const part = (syncPart, log) => ({
  syncPart,
  onMessage: (msg) => { log.push(`${syncPart ?? 'tool'}:${msg.type}`); },
  onInitialSync: async () => { log.push(`${syncPart ?? 'tool'}:catch-up`); },
});
const MSG = { type: 'entity.updated', resourceId: 'e1', payload: { id: 'e1' } };

test('a part set to From Foundry does not see Chronicle\'s messages; other parts do', () => {
  const sm = makeManager({ journals: 'push' });
  const log = [];
  sm._modules = [part('journals', log), part('characters', log), part(undefined, log)];
  sm._routeMessage(MSG);
  assert.deepEqual(log, ['characters:entity.updated', 'tool:entity.updated']);
  assert.deepEqual(sm.heldCounts(), { foundry: 0, chronicle: 0 }, 'a blocked direction is not counted as waiting');
});

test('with live sync off, document parts wait and are counted once per page; the calendar still hears', () => {
  const sm = makeManager({ live: false });
  const log = [];
  sm._modules = [part('journals', log), part('calendar', log), part(undefined, log)];
  sm._routeMessage(MSG);
  sm._routeMessage(MSG);
  assert.deepEqual(log, ['calendar:entity.updated', 'tool:entity.updated', 'calendar:entity.updated', 'tool:entity.updated']);
  assert.equal(sm.heldCounts().chronicle, 1);
});

test('with live sync off, an automatic catch-up serves only the parts that never wait and saves no cursor', async () => {
  const sm = makeManager({ live: false });
  const log = [];
  sm._modules = [part('journals', log), part('calendar', log), part(undefined, log)];
  sm.api = { get: async () => { throw new Error('nothing is read for a waiting pass'); } };
  assert.equal(await sm._runInitialSync(), true);
  assert.deepEqual(log, ['calendar:catch-up', 'tool:catch-up']);
  assert.equal(settings.lastSyncTime, '');
});

test('Sync now sends each waiting change through its part, keeps one that fails, then catches up', async () => {
  const sm = makeManager({ live: false });
  const sent = [];
  sm._modules = [{
    syncPart: 'journals', heldKinds: ['journal.update'],
    sendHeld: async (change) => {
      assert.equal(sm.pushGate('journals'), 'send', 'nothing waits during Sync now');
      if (change.key === 'journal:bad') throw new Error('down');
      sent.push(change.key);
    },
  }];
  let passes = 0;
  sm._performInitialSync = async () => { passes += 1; return true; };
  sm.holdChange({ key: 'journal:a', part: 'journals', kind: 'journal.update', label: 'A' });
  sm.holdChange({ key: 'journal:bad', part: 'journals', kind: 'journal.update', label: 'Bad' });
  sm.holdChange({ key: 'journal:b', part: 'journals', kind: 'journal.update', label: 'B' });
  const result = await sm.syncNow();
  assert.deepEqual(sent, ['journal:a', 'journal:b']);
  assert.deepEqual(result, { sent: 2, failed: 1, pulled: true });
  assert.equal(passes, 1);
  assert.deepEqual(sm.heldChanges().map((r) => r.key), ['journal:bad']);
  assert.deepEqual(JSON.parse(settings.heldChanges).map((r) => r.key), ['journal:bad'], 'the list is saved, so a reload keeps it');
  assert.equal(sm.pushGate('journals'), 'hold', 'changes wait again afterwards');
});

// ---- journals ----

const page = (content) => ({ id: 'p1', type: 'text', sort: 1, text: { content }, getFlag: () => undefined });

function makeJournals(opts) {
  const sm = makeManager(opts);
  const js = new JournalSync();
  const calls = [];
  js._api = {
    get: async () => ({ id: 'e1', name: 'Remote', entry_html: '<p>remote</p>', updated_at: '2026-10-03T04:00:10Z' }),
    put: async (p, b) => { calls.push(['PUT', p, b]); return {}; },
    post: async (p, b) => { calls.push(['POST', p, b]); return { id: 'e9', updated_at: 'v1' }; },
    delete: async (p) => { calls.push(['DELETE', p]); },
    clearRetry: () => {}, queueForRetry: () => {},
  };
  js._syncManager = sm;
  sm.ensureMapping = async () => {};
  sm.recordUserOutcome = () => {};
  js._hidePushedSecrets = async () => {};
  js._recordPush = async () => {};
  js._pushPermissions = async () => {};
  js._resolveCreateTypeId = async () => 3;
  const scheduled = [];
  js._journalPushDebouncer = { schedule: (id) => scheduled.push(id), cancel() {}, flush() {}, flushAll() {}, has: () => false };
  return { sm, js, calls, scheduled };
}

test('From Chronicle: a Foundry journal edit, new journal and delete send nothing and keep nothing', async () => {
  const { sm, js, calls, scheduled } = makeJournals({ journals: 'pull' });
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>x</p>')] });
  const fresh = makeJournal({ id: 'j2', pages: [page('<p>y</p>')] });
  installJournals([j, fresh]);
  await js._handleUpdateJournal(j, { name: 'N' }, {}, 'gm');
  await js._handleCreateJournal(fresh, {}, 'gm');
  await js._handleDeleteJournal(j, {}, 'gm');
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(sm.heldChanges(), []);
});

test('live sync off: edits to one journal become one waiting change that remembers what changed', async () => {
  const { sm, js, calls, scheduled } = makeJournals({ live: false });
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>x</p>')] });
  installJournals([j]);
  await js._handleUpdateJournal(j, { name: 'N' }, {}, 'gm');
  await js._handleUpdateJournal(j, {}, {}, 'gm');
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, []);
  const held = sm.heldChanges();
  assert.equal(held.length, 1);
  assert.equal(held[0].kind, 'journal.update');
  assert.equal(held[0].data.name, true, 'the rename from the first edit is kept');
  assert.equal(held[0].data.ownership, false);

  sm._syncingNow = true;
  await js.sendHeld(held[0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/entities/e1');
  assert.equal(calls[0][2].name, j.name);
  assert.equal(calls[0][2].entry, '<p>x</p>');
  assert.equal('is_private' in calls[0][2], false, 'sharing was not changed, so it is not sent');
});

test('live sync off: a new journal waits and is made on Sync now; deleted first, nothing is sent', async () => {
  const { sm, js, calls } = makeJournals({ live: false });
  const fresh = makeJournal({ id: 'j2', name: 'Fresh', pages: [page('<p>y</p>')] });
  installJournals([fresh]);
  await js._handleCreateJournal(fresh, {}, 'gm');
  assert.deepEqual(sm.heldChanges().map((r) => r.kind), ['journal.create']);
  assert.deepEqual(calls, []);

  const copy = { ...sm.heldChanges()[0] };
  await js._handleDeleteJournal(fresh, {}, 'gm');
  assert.deepEqual(sm.heldChanges(), [], 'the journal went before it was ever sent');

  sm._syncingNow = true;
  await js.sendHeld(copy);
  assert.equal(calls[0][0], 'POST');
  assert.equal(fresh.flags.entityId, 'e9');
});

test('live sync off: deleting a linked journal replaces its waiting edit with a waiting delete', async () => {
  const { sm, js } = makeJournals({ live: false });
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>x</p>')] });
  installJournals([j]);
  await js._handleUpdateJournal(j, {}, {}, 'gm');
  await js._handleDeleteJournal(j, {}, 'gm');
  const held = sm.heldChanges();
  assert.deepEqual(held.map((r) => [r.kind, r.data.entityId]), [['journal.delete', 'e1']]);
});

test('a waiting edit is not sent to a page the journal no longer links to', async () => {
  const { sm, js, calls } = makeJournals({ live: false });
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>x</p>')] });
  installJournals([j]);
  await js._handleUpdateJournal(j, {}, {}, 'gm');
  j.flags.entityId = 'other';
  sm._syncingNow = true;
  await js.sendHeld(sm.heldChanges()[0]);
  assert.deepEqual(calls, []);
});

test('From Foundry: a conflict keeps the Foundry edit whatever the conflict setting says', async () => {
  const { js, calls } = makeJournals({ journals: 'push' });
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>mine</p>')] });
  installJournals([j]);
  let applied = 0;
  js._onEntityUpdated = async () => { applied += 1; };
  await js._handleConflict(j, 'e1', { entry: '<p>mine</p>', expected_updated_at: 'stale' }, 0);
  assert.equal(applied, 0);
  assert.deepEqual(calls, [['PUT', '/entities/e1', { entry: '<p>mine</p>' }]]);
});
