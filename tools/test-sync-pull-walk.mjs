#!/usr/bin/env node
/** walkSyncPull follows has_more by advancing `since`, and reports incomplete walks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { walkSyncPull } from '../scripts/_sync-pull-walk.mjs';

const row = (n) => ({ id: `m${n}`, updated_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z` });

test('pages until has_more is false and keeps the FIRST server_time', async () => {
  const seen = [];
  const pages = [
    { mappings: [row(1), row(2)], has_more: true, server_time: 'T1' },
    { mappings: [row(3)], has_more: false, server_time: 'T2' },
  ];
  const out = await walkSyncPull(async (since) => { seen.push(since); return pages[seen.length - 1]; }, 'START');
  assert.deepEqual(seen, ['START', '2026-01-01T00:00:01.999Z']);
  assert.equal(out.mappings.length, 3);
  assert.equal(out.serverTime, 'T1');
  assert.equal(out.complete, true);
});

test('has_more with no forward progress stops and is incomplete', async () => {
  const out = await walkSyncPull(async () => ({ mappings: [row(1)], has_more: true, server_time: 'T' }), row(1).updated_at);
  assert.equal(out.complete, false);
});

test('has_more with an empty page is incomplete, not a loop', async () => {
  const out = await walkSyncPull(async () => ({ mappings: [], has_more: true }), 'S');
  assert.equal(out.complete, false);
});

test('a single short page is complete', async () => {
  const out = await walkSyncPull(async () => ({ mappings: [row(1)], server_time: 'T' }), 'S');
  assert.deepEqual([out.complete, out.serverTime, out.mappings.length], [true, 'T', 1]);
});

test('rows sharing the page-edge timestamp are not skipped, and repeats are dropped', async () => {
  const t = '2026-01-01T00:00:05Z';
  const a = { id: 'a', updated_at: t }; const b = { id: 'b', updated_at: t }; const c = { id: 'c', updated_at: t };
  // Server: strict updated_at > since, three rows per page; the tie straddles
  // the first page's edge.
  const all = [row(1), a, b, c, row(9)];
  const out = await walkSyncPull(async (since) => {
    const rows = all.filter((r) => Date.parse(r.updated_at) > Date.parse(since));
    return { mappings: rows.slice(0, 3), has_more: rows.length > 3, server_time: 'T' };
  }, '2026-01-01T00:00:00Z');
  assert.deepEqual(out.mappings.map((r) => r.id), ['m1', 'a', 'b', 'c', 'm9']);
  assert.equal(out.complete, true);
});

test('more ties than a page holds steps past them instead of looping', async () => {
  const t = '2026-01-01T00:00:05Z';
  const all = [{ id: 'a', updated_at: t }, { id: 'b', updated_at: t }, { id: 'c', updated_at: t }, row(9)];
  let calls = 0;
  const out = await walkSyncPull(async (since) => {
    calls++;
    const rows = all.filter((r) => Date.parse(r.updated_at) > Date.parse(since));
    return { mappings: rows.slice(0, 2), has_more: rows.length > 2, server_time: 'T' };
  }, '2026-01-01T00:00:00Z');
  assert.ok(calls < 10);
  assert.ok(out.mappings.some((r) => r.id === 'm9'));
});
