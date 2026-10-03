#!/usr/bin/env node
/**
 * Change-feed catch-up: the feed walk and collapse rules, SyncManager's
 * cursor (read before modules apply, saved only when every feed area
 * succeeded, per campaign), and JournalSync applying only the listed pages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, makeJournal, installJournals } from './_journal-test-env.mjs';
import { walkChangeFeed, collapseChanges, cursorFor, feedForArea, MAX_FEED_PAGES } from '../scripts/_change-feed.mjs';

const { SyncManager } = await import('../scripts/sync-manager.mjs');
const { JournalSync } = await import('../scripts/journal-sync.mjs');

const ch = (seq, resourceId, op = 'updated', type = 'entity') => ({ seq, type, resourceId, op });

// --- walkChangeFeed ---

test('walk follows hasMore and returns the last next', async () => {
  const calls = [];
  const res = await walkChangeFeed(async (since) => {
    calls.push(since);
    return since === 5
      ? { changes: [ch(7, 'a'), ch(9, 'b')], next: 9, hasMore: true }
      : { changes: [ch(12, 'c')], next: 12, hasMore: false };
  }, 5);
  assert.deepEqual(calls, [5, 9]);
  assert.deepEqual(res.changes.map((c) => c.seq), [7, 9, 12]);
  assert.equal(res.next, 12);
  assert.equal(res.complete, true);
  assert.equal(res.resetRequired, false);
});

test('resetRequired returns the head with no changes', async () => {
  const res = await walkChangeFeed(async () => ({ changes: [], next: 400, resetRequired: true }), 3);
  assert.deepEqual(res, { changes: [], next: 400, resetRequired: true, complete: true, types: null });
});

test('a response without next is an error, not a cursor of NaN', async () => {
  await assert.rejects(walkChangeFeed(async () => ({ changes: [] }), 0));
});

test('no forward progress ends the walk instead of looping', async () => {
  let n = 0;
  const res = await walkChangeFeed(async () => { n++; return { changes: [], next: 4, hasMore: true }; }, 4);
  assert.equal(n, 1);
  assert.equal(res.next, 4);
});

test('the page bound stops the walk and says so, keeping a valid cursor', async () => {
  const res = await walkChangeFeed(async (since) => ({ changes: [ch(since + 1, 'x')], next: since + 1, hasMore: true }), 0);
  assert.equal(res.complete, false);
  assert.equal(res.next, MAX_FEED_PAGES);
  assert.equal(res.changes.length, MAX_FEED_PAGES);
});

// --- collapseChanges / cursorFor / feedForArea ---

test('collapse keeps one outcome per resource, filtered by type', () => {
  const out = collapseChanges([
    ch(1, 'a', 'created'), ch(2, 'a', 'updated'),
    ch(3, 'b', 'updated'), ch(4, 'b', 'deleted'),
    ch(5, 'c', 'updated'),
    ch(6, 'd', 'created'), ch(7, 'd', 'deleted'),
    ch(8, 'm', 'updated', 'map'),
  ], 'entity');
  assert.deepEqual([...out], [['a', 'created'], ['b', 'deleted'], ['c', 'updated'], ['d', 'deleted']]);
});

test('a cursor belongs to one campaign', () => {
  assert.deepEqual(cursorFor({ campaignId: 'c1', seq: 5, areas: ['journals'], createdAfter: 'T0' }, 'c1'), { seq: 5, areas: ['journals'], createdAfter: 'T0', types: [] });
  assert.equal(cursorFor({ campaignId: 'c1', seq: 5 }, 'c1').createdAfter, null);
  assert.equal(cursorFor({ campaignId: 'c1', seq: 5 }, 'c2'), null);
  assert.equal(cursorFor(null, 'c1'), null);
  assert.equal(cursorFor({ campaignId: 'c1', seq: 'x' }, 'c1'), null);
});

test('an area gets the delta only if it was syncing when the cursor moved', () => {
  const feed = { mode: 'delta', changes: [ch(1, 'a')], next: 1 };
  assert.equal(feedForArea(feed, { seq: 0, areas: ['journals'] }, 'journals').mode, 'delta');
  assert.equal(feedForArea(feed, { seq: 0, areas: [] }, 'journals').mode, 'full');
  assert.equal(feedForArea({ mode: 'full', changes: [], next: 1 }, { seq: 0, areas: ['journals'] }, 'journals').mode, 'full');
  assert.equal(feedForArea(null, null, 'journals').mode, 'full');
});

// --- SyncManager cursor ---

function makeManager({ feed, modules }) {
  const sm = new SyncManager();
  const urls = [];
  sm.api = {
    get: async (p) => {
      urls.push(p);
      if (p.startsWith('/sync/changes')) return feed(p);
      return { mappings: [], has_more: false, server_time: 'T' };
    },
  };
  sm.fetchAndCacheMembers = async () => {};
  sm.logActivity = () => {};
  sm._modules = modules;
  return { sm, urls };
}

function feedModule(area = 'journals', { fail = false } = {}) {
  const seen = [];
  return {
    seen,
    feedArea: area,
    feedActive: () => true,
    onInitialSync: async (opts) => { seen.push(opts?.feed); if (fail) throw new Error('boom'); },
  };
}

test('no cursor: walk to the head, rescan, save the head', async () => {
  settings.campaignId = 'c1';
  settings.changeFeedCursor = null;
  const mod = feedModule();
  const { sm, urls } = makeManager({ feed: () => ({ changes: [ch(10, 'a')], next: 10, hasMore: false }), modules: [mod] });
  assert.equal(await sm._performInitialSync(), true);
  assert.match(urls.find((u) => u.startsWith('/sync/changes')), /since=0/);
  assert.deepEqual(mod.seen, [{ mode: 'full' }]);
  assert.deepEqual(settings.changeFeedCursor, { campaignId: 'c1', seq: 10, areas: ['journals'], createdAfter: 'T', types: [] });
});

test('a saved cursor hands the area its changes and advances', async () => {
  settings.changeFeedCursor = { campaignId: 'c1', seq: 10, areas: ['journals'], createdAfter: 'T0' };
  const mod = feedModule();
  const { sm, urls } = makeManager({ feed: () => ({ changes: [ch(11, 'a')], next: 11, hasMore: false }), modules: [mod] });
  await sm._performInitialSync();
  assert.match(urls.find((u) => u.startsWith('/sync/changes')), /since=10/);
  assert.deepEqual(mod.seen, [{ mode: 'delta', changes: [ch(11, 'a')], createdAfter: 'T0' }]);
  assert.equal(settings.changeFeedCursor.seq, 11);
});

test('a failed area keeps the old cursor and its "created after", so a new page is still new on replay', async () => {
  settings.changeFeedCursor = { campaignId: 'c1', seq: 10, areas: ['journals'], createdAfter: 'T0' };
  settings.lastSyncTime = 'T0';
  const failing = feedModule('journals', { fail: true });
  const { sm } = makeManager({ feed: () => ({ changes: [ch(11, 'a', 'created')], next: 11, hasMore: false }), modules: [failing] });
  await sm._performInitialSync();
  assert.equal(settings.changeFeedCursor.seq, 10);
  // The sync time moved on regardless; the replay must not use it.
  assert.equal(settings.lastSyncTime, 'T');
  const retry = feedModule();
  const again = makeManager({ feed: () => ({ changes: [ch(11, 'a', 'created')], next: 11, hasMore: false }), modules: [retry] });
  await again.sm._performInitialSync();
  assert.equal(retry.seen[0].createdAfter, 'T0');
  settings.lastSyncTime = '';
});

test('a walk cut short advances the cursor but keeps its "created after"', async () => {
  settings.changeFeedCursor = { campaignId: 'c1', seq: 0, areas: ['journals'], createdAfter: 'T0' };
  const { sm } = makeManager({ feed: (p) => { const since = Number(new URL('http://x' + p).searchParams.get('since')); return { changes: [ch(since + 1, 'x')], next: since + 1, hasMore: true }; }, modules: [feedModule()] });
  await sm._performInitialSync();
  assert.equal(settings.changeFeedCursor.seq, MAX_FEED_PAGES);
  assert.equal(settings.changeFeedCursor.createdAfter, 'T0');
});

test('another campaign\'s cursor is ignored', async () => {
  settings.changeFeedCursor = { campaignId: 'other', seq: 99, areas: ['journals'] };
  const mod = feedModule();
  const { sm, urls } = makeManager({ feed: () => ({ changes: [], next: 3, hasMore: false }), modules: [mod] });
  await sm._performInitialSync();
  assert.match(urls.find((u) => u.startsWith('/sync/changes')), /since=0/);
  assert.deepEqual(mod.seen, [{ mode: 'full' }]);
  assert.deepEqual(settings.changeFeedCursor, { campaignId: 'c1', seq: 3, areas: ['journals'], createdAfter: 'T', types: [] });
});

test('no feed on the server: rescan and save nothing', async () => {
  settings.changeFeedCursor = null;
  const mod = feedModule();
  const { sm } = makeManager({ feed: () => { throw Object.assign(new Error('nf'), { status: 404 }); }, modules: [mod] });
  assert.equal(await sm._performInitialSync(), true);
  assert.deepEqual(mod.seen, [{ mode: 'full' }]);
  assert.equal(settings.changeFeedCursor, null);
});

test('an area switched off is left out of the saved cursor', async () => {
  settings.changeFeedCursor = { campaignId: 'c1', seq: 10, areas: ['journals'] };
  const off = { feedArea: 'journals', feedActive: () => false, seen: [], onInitialSync: async (o) => { off.seen.push(o); } };
  const { sm } = makeManager({ feed: () => ({ changes: [], next: 12, hasMore: false }), modules: [off] });
  await sm._performInitialSync();
  assert.deepEqual(off.seen, [undefined]);
  assert.deepEqual(settings.changeFeedCursor, { campaignId: 'c1', seq: 12, areas: [], createdAfter: 'T', types: [] });
  settings.changeFeedCursor = null;
});

// --- JournalSync._catchUpFromFeed ---

function makeJournalSync({ entities = {}, fail = new Set() } = {}) {
  const js = new JournalSync();
  const gets = [];
  js._api = {
    get: async (path) => {
      gets.push(path);
      const id = path.split('/').pop();
      if (fail.has(id)) throw Object.assign(new Error('boom'), { status: 500 });
      if (!entities[id]) throw Object.assign(new Error('nf'), { status: 404 });
      return entities[id];
    },
  };
  js._syncManager = { _modules: [] };
  js._isHandledByActorSync = () => false;
  js._isExcluded = () => false;
  const updated = []; const created = []; const setAside = [];
  js._onEntityUpdated = async (e) => { updated.push(e.id); };
  js._createJournalFromEntity = async (e) => { created.push(e.id); };
  js._setAsideIfGone = async (j, eid, opts) => { setAside.push([eid, !!opts?.knownGone]); };
  return { js, gets, updated, created, setAside };
}

test('delta: only listed pages are fetched; versions already seen are skipped', async () => {
  installJournals([
    makeJournal({ id: 'j1', flags: { entityId: 'e-same', chronicleUpdatedAt: 'U1' } }),
    makeJournal({ id: 'j2', flags: { entityId: 'e-changed', chronicleUpdatedAt: 'U1' } }),
    makeJournal({ id: 'j3', flags: { entityId: 'e-untouched', chronicleUpdatedAt: 'U1' } }),
  ]);
  const { js, gets, updated, created } = makeJournalSync({ entities: {
    'e-same': { id: 'e-same', updated_at: 'U1' },
    'e-changed': { id: 'e-changed', updated_at: 'U2' },
    'e-new': { id: 'e-new', updated_at: 'U1', created_at: '2026-05-02T00:00:00Z' },
  } });
  settings.lastSyncTime = '2026-05-01T00:00:00Z';
  await js.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e-same'), ch(2, 'e-changed'), ch(3, 'e-new', 'created')] } });
  settings.lastSyncTime = '';
  assert.deepEqual(gets.sort(), ['/entities/e-changed', '/entities/e-new', '/entities/e-same']);
  assert.deepEqual(updated, ['e-changed']);
  assert.deepEqual(created, ['e-new']);
});

test('delta: a replayed create for a page older than the last sync is not recreated', async () => {
  // The feed replays entries an earlier connect applied; the GM has since
  // deleted that journal here and kept the page.
  installJournals([]);
  const { js, created } = makeJournalSync({ entities: { e1: { id: 'e1', updated_at: 'U', created_at: '2026-04-01T00:00:00Z' } } });
  settings.lastSyncTime = '2026-05-01T00:00:00Z';
  await js.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e1', 'created')] } });
  settings.lastSyncTime = '';
  assert.deepEqual(created, []);
});

test('delta: an update to a page with no journal does not recreate it', async () => {
  // The GM deleted the journal here and kept the Chronicle page.
  installJournals([]);
  const { js, created } = makeJournalSync({ entities: { e1: { id: 'e1', updated_at: 'U2' } } });
  await js.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e1', 'updated')] } });
  assert.deepEqual(created, []);
});

test('delta: deletes and vanished pages go to the set-aside check', async () => {
  installJournals([
    makeJournal({ id: 'j1', flags: { entityId: 'e-del' } }),
    makeJournal({ id: 'j2', flags: { entityId: 'e-vanished' } }),
  ]);
  const { js, setAside } = makeJournalSync();
  await js.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e-del', 'deleted'), ch(2, 'e-vanished', 'updated'), ch(3, 'e-nojournal', 'deleted')] } });
  assert.deepEqual(setAside, [['e-del', false], ['e-vanished', true]]);
});

test('delta: a failed fetch throws so the cursor is not advanced', async () => {
  const { js, updated } = makeJournalSync({ entities: { e2: { id: 'e2', updated_at: 'U2' } }, fail: new Set(['e1']) });
  installJournals([
    makeJournal({ id: 'j1', flags: { entityId: 'e1', chronicleUpdatedAt: 'U1' } }),
    makeJournal({ id: 'j2', flags: { entityId: 'e2', chronicleUpdatedAt: 'U1' } }),
  ]);
  await assert.rejects(js.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e1'), ch(2, 'e2')] } }));
  // The other page still applied; the replay will skip it by version.
  assert.deepEqual(updated, ['e2']);
});

test('an area needing a resource type gets the delta only if the server recorded it when the cursor was saved', () => {
  const feed = { mode: 'delta', changes: [ch(1, 'hero', 'updated', 'relation')], next: 1 };
  assert.equal(feedForArea(feed, { seq: 0, areas: ['items'], types: ['entity', 'relation'] }, 'items', 'relation').mode, 'delta');
  assert.equal(feedForArea(feed, { seq: 0, areas: ['items'], types: ['entity'] }, 'items', 'relation').mode, 'full');
  assert.equal(feedForArea(feed, { seq: 0, areas: ['items'] }, 'items', 'relation').mode, 'full');
});

test('the walk reports the recorded types; an older server reports none', async () => {
  const pages = [{ changes: [], next: 3, hasMore: false, types: ['entity', 'relation', 7] }];
  assert.deepEqual((await walkChangeFeed(async () => pages[0], 0)).types, ['entity', 'relation']);
  assert.equal((await walkChangeFeed(async () => ({ changes: [], next: 3, hasMore: false }), 0)).types, null);
});

test('the saved cursor keeps the types the server recorded, and an area needing one waits a connect for it', async () => {
  settings.campaignId = 'c1';
  settings.changeFeedCursor = { campaignId: 'c1', seq: 10, areas: ['items'], createdAfter: 'T0' };
  const mod = { ...feedModule('items'), feedType: 'relation' };
  const { sm } = makeManager({ feed: () => ({ changes: [ch(11, 'hero', 'updated', 'relation')], next: 11, hasMore: false, types: ['entity', 'relation'] }), modules: [mod] });
  assert.equal(await sm._performInitialSync(), true);
  assert.deepEqual(mod.seen, [{ mode: 'full' }], 'cursor from before the server recorded relations');
  assert.deepEqual(settings.changeFeedCursor.types, ['entity', 'relation']);

  mod.seen.length = 0;
  const again = makeManager({ feed: () => ({ changes: [ch(12, 'hero', 'updated', 'relation')], next: 12, hasMore: false, types: ['entity', 'relation'] }), modules: [mod] });
  assert.equal(await again.sm._performInitialSync(), true);
  assert.equal(mod.seen[0].mode, 'delta');
});
