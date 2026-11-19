#!/usr/bin/env node
/**
 * "Newest wins" compares when the rejected Foundry edit was made with
 * Chronicle's version, and a cleared text page clears Chronicle's text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal, installJournals, settings } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

const REMOTE_AT = '2026-10-03T04:00:10Z';

function make() {
  const js = new JournalSync();
  const puts = [];
  const applied = [];
  js._api = {
    get: async () => ({ id: 'e1', name: 'Remote', updated_at: REMOTE_AT }),
    put: async (p, b) => { puts.push([p, b]); return {}; },
    clearRetry: () => {},
  };
  js._syncManager = { _modules: [], logActivity: () => {}, recordUserOutcome: () => {} };
  js._onEntityUpdated = async (e) => { applied.push(e); };
  js._hidePushedSecrets = async () => {};
  return { js, puts, applied };
}

test('Newest wins keeps a Foundry edit made after Chronicle\'s change', async () => {
  settings.conflictResolution = 'newest';
  const j = makeJournal({ flags: { entityId: 'e1', lastSync: '2026-10-03T04:00:00Z' } });
  installJournals([j]);
  const { js, puts, applied } = make();
  const body = { entry: '<p>mine</p>', expected_updated_at: 'stale' };
  await js._handleConflict(j, 'e1', body, Date.parse(REMOTE_AT) + 5000);
  assert.equal(applied.length, 0);
  assert.deepEqual(puts, [['/entities/e1', { entry: '<p>mine</p>' }]], 'pushed without the version check');
});

test('Newest wins keeps Chronicle\'s change when it came after the Foundry edit', async () => {
  settings.conflictResolution = 'newest';
  const j = makeJournal({ flags: { entityId: 'e1', lastSync: '2026-10-03T04:00:00Z' } });
  installJournals([j]);
  const { js, puts, applied } = make();
  await js._handleConflict(j, 'e1', { entry: '<p>mine</p>' }, Date.parse(REMOTE_AT) - 5000);
  assert.equal(puts.length, 0);
  assert.equal(applied.length, 1);
});

test('an edit with no known time never overrides Chronicle', async () => {
  settings.conflictResolution = 'newest';
  const j = makeJournal({ flags: { entityId: 'e1', lastSync: '2099-01-01T00:00:00Z' } });
  installJournals([j]);
  const { js, puts, applied } = make();
  await js._handleConflict(j, 'e1', { entry: '<p>mine</p>' });
  assert.equal(puts.length, 0);
  assert.equal(applied.length, 1);
});
