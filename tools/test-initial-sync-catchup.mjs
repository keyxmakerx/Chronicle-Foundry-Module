#!/usr/bin/env node
/**
 * SyncManager initial sync: follows has_more on /sync/pull, saves the FIRST
 * page's server_time only after the whole walk succeeded, and the first
 * sync is latched done only on success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';
import { unwrapEntityList } from '../scripts/_entity-page-walk.mjs';

const { SyncManager } = await import('../scripts/sync-manager.mjs');

const row = (n) => ({ chronicle_type: 'entity', chronicle_id: `e${n}`, updated_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z` });

function make(pull) {
  const sm = new SyncManager();
  const routed = [];
  sm.api = { get: async (p) => pull(p) };
  sm.fetchAndCacheMembers = async () => {};
  sm.logActivity = () => {};
  sm._modules = [{ onSyncMapping: async (m) => { routed.push(m.chronicle_id); } }];
  return { sm, routed };
}

test('has_more pages are all routed and lastSyncTime is the first server_time', async () => {
  settings.lastSyncTime = '';
  const urls = [];
  const { sm, routed } = make(async (p) => {
    urls.push(p);
    return urls.length === 1
      ? { mappings: [row(1), row(2)], has_more: true, server_time: 'T-first' }
      : { mappings: [row(3)], has_more: false, server_time: 'T-last' };
  });
  assert.equal(await sm._performInitialSync(), true);
  assert.deepEqual(routed, ['e1', 'e2', 'e3']);
  assert.equal(urls.length, 2);
  // Resumes just before the last row's time so ties at the page edge are kept.
  const resume = new Date(Date.parse(row(2).updated_at) - 1).toISOString();
  assert.match(urls[1], new RegExp(encodeURIComponent(resume)));
  assert.match(urls[0], /limit=1000/);
  assert.equal(settings.lastSyncTime, 'T-first');
});

test('an incomplete walk does not advance lastSyncTime and reports failure', async () => {
  settings.lastSyncTime = 'OLD';
  const { sm } = make(async () => ({ mappings: [], has_more: true, server_time: 'T' }));
  assert.equal(await sm._performInitialSync(), false);
  assert.equal(settings.lastSyncTime, 'OLD');
});

test('a failed pull leaves the first sync unlatched so the next connect retries it', async () => {
  settings.lastSyncTime = 'OLD';
  let fail = true;
  const { sm } = make(async () => {
    if (fail) throw new Error('down');
    return { mappings: [], server_time: 'T' };
  });
  await sm._onSyncStatus({ status: 'connected' });
  assert.equal(sm._initialSyncDone, false);
  assert.equal(settings.lastSyncTime, 'OLD');
  fail = false;
  await sm._onSyncStatus({ status: 'connected' });
  assert.equal(sm._initialSyncDone, true);
});

test('unwrapEntityList accepts bare arrays and data/entities envelopes', () => {
  assert.deepEqual(unwrapEntityList([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(unwrapEntityList({ data: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(unwrapEntityList({ entities: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(unwrapEntityList(null), []);
});
