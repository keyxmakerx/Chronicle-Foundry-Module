#!/usr/bin/env node
/**
 * Tests for the shared entity-list page walk (scripts/_entity-page-walk.mjs).
 *
 * The regression: both callers that need "every entity in the campaign" —
 * JournalSync.resyncAll and the dashboard's _buildEntityGroups — stopped
 * after five pages of 100. That is a hard 500-entity ceiling with no signal.
 * Entities past it were not synced late; they were never seen, and the GM was
 * shown a completed resync and a full-looking dashboard either way.
 *
 * Chronicle's server-side sync pull carried the matching ceiling, fixed in
 * sweep R4 stage 18. Fixing the server and leaving the client capped at 500
 * would have left the operator exactly as stuck.
 *
 * Run: `node --test tools/test-entity-page-walk.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  walkEntityPages,
  ENTITY_PAGE_SIZE,
  MAX_ENTITY_PAGES,
} from '../scripts/_entity-page-walk.mjs';

/** Serves `total` entities in pages, recording how many requests it saw. */
function pagedServer(total) {
  const calls = [];
  return {
    calls,
    fetchPage: async (page, perPage) => {
      calls.push(page);
      const start = (page - 1) * perPage;
      if (start >= total) return { data: [] };
      const out = [];
      for (let i = start; i < Math.min(start + perPage, total); i++) {
        out.push({ id: `ent-${String(i).padStart(5, '0')}` });
      }
      return { data: out };
    },
  };
}

const unwrap = (r) => (Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []));

test('walks past the old five-page ceiling and returns every entity', async () => {
  const total = 1234; // Well past 5 x 100.
  const server = pagedServer(total);

  const { entities, truncated } = await walkEntityPages(server.fetchPage, unwrap);

  assert.equal(entities.length, total,
    'the walk must return every entity; the old cap returned 500 and reported success');
  assert.equal(truncated, false);
  assert.equal(entities[0].id, 'ent-00000');
  assert.equal(entities[total - 1].id, `ent-0${total - 1}`,
    'the last entity in the campaign must arrive');
  // No duplicates.
  assert.equal(new Set(entities.map((e) => e.id)).size, total);
});

test('a short page ends the walk without an extra request', async () => {
  const server = pagedServer(42);
  const { entities, truncated } = await walkEntityPages(server.fetchPage, unwrap);
  assert.equal(entities.length, 42);
  assert.equal(truncated, false);
  assert.deepEqual(server.calls, [1], 'a single short page must not be followed by a probe');
});

test('an exact page multiple costs one confirming request and does not over-report', async () => {
  const server = pagedServer(ENTITY_PAGE_SIZE * 2);
  const { entities, truncated } = await walkEntityPages(server.fetchPage, unwrap);
  assert.equal(entities.length, ENTITY_PAGE_SIZE * 2);
  assert.equal(truncated, false);
  assert.deepEqual(server.calls, [1, 2, 3],
    'a full final page cannot be distinguished from more without asking');
});

test('an empty campaign yields nothing and is not reported as truncated', async () => {
  const server = pagedServer(0);
  const { entities, truncated } = await walkEntityPages(server.fetchPage, unwrap);
  assert.deepEqual(entities, []);
  assert.equal(truncated, false);
});

test('hitting the safety bound REPORTS truncation instead of swallowing it', async () => {
  // A server that always answers with a full page — the runaway case the
  // bound exists for. The old loop hit its bound and said nothing.
  const alwaysFull = async (page, perPage) => ({
    data: Array.from({ length: perPage }, (_, i) => ({ id: `p${page}-${i}` })),
  });

  const { entities, truncated } = await walkEntityPages(alwaysFull, unwrap, { maxPages: 3 });

  assert.equal(truncated, true,
    'a walk that stopped early must say so; a silent ceiling is the defect');
  assert.equal(entities.length, 3 * ENTITY_PAGE_SIZE);
});

test('the shipped bound is far above the old one', () => {
  assert.ok(MAX_ENTITY_PAGES > 5,
    'the whole point is that 500 entities is not the ceiling any more');
  assert.ok(MAX_ENTITY_PAGES * ENTITY_PAGE_SIZE >= 20000,
    'the bound should sit past any real campaign');
});

test('the walk honours a custom page size', async () => {
  const server = pagedServer(25);
  const { entities } = await walkEntityPages(server.fetchPage, unwrap, { pageSize: 10 });
  assert.equal(entities.length, 25);
  assert.deepEqual(server.calls, [1, 2, 3]);
});

test('a normalizer that returns undefined does not throw', async () => {
  const { entities, truncated } = await walkEntityPages(
    async () => ({ unexpected: true }),
    () => undefined,
  );
  assert.deepEqual(entities, []);
  assert.equal(truncated, false);
});

test('neither caller keeps a hard-coded five-page ceiling', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['../scripts/journal-sync.mjs', '../scripts/sync-dashboard.mjs']) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/page\s*<=\s*5\b/.test(src),
      `${file} still caps its entity walk at five pages`);
    assert.ok(src.includes('walkEntityPages'),
      `${file} must use the shared walk so the two cannot drift apart again`);
  }
});
