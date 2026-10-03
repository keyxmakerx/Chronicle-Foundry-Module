#!/usr/bin/env node
/**
 * A journal's recorded Chronicle version only moves forward: a stale copy
 * (an echo built before a later save) is ignored, a push result older than
 * what is recorded does not roll it back, and a permissions push reads back
 * the version it stamped. Identical permissions are not pushed again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal, installJournals } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

const T1 = '2026-10-03T04:00:01Z';
const T2 = '2026-10-03T04:00:02Z';

function make({ get = async () => ({}) } = {}) {
  const js = new JournalSync();
  const puts = [];
  js._api = { get, put: async (p, b) => { puts.push([p, b]); return {}; } };
  js._syncManager = { _modules: [], getChronicleUserId: (fid) => (fid === 'u1' ? 'cu1' : null), logActivity: () => {} };
  js._isHandledByActorSync = () => false;
  js._isExcluded = () => false;
  js._buildOwnership = async () => ({ default: 2 });
  js._syncPagesToJournal = async () => {};
  js._syncPlayerNotesPage = async () => {};
  return { js, puts };
}

test('a copy older than the recorded version is ignored', async () => {
  const j = makeJournal({ id: 'j1', name: 'Now', flags: { entityId: 'e1', chronicleUpdatedAt: T2 } });
  installJournals([j]);
  const { js } = make();
  await js._onEntityUpdated({ id: 'e1', name: 'Before', updated_at: T1 });
  assert.equal(j.name, 'Now');
  assert.equal(j.flags.chronicleUpdatedAt, T2);
});

test('an equal or newer copy still applies', async () => {
  const j = makeJournal({ id: 'j1', name: 'Old', flags: { entityId: 'e1', chronicleUpdatedAt: T1 } });
  installJournals([j]);
  const { js } = make();
  await js._onEntityUpdated({ id: 'e1', name: 'Same second', updated_at: T1 });
  assert.equal(j.name, 'Same second');
  await js._onEntityUpdated({ id: 'e1', name: 'Newer', updated_at: T2 });
  assert.equal(j.name, 'Newer');
  assert.equal(j.flags.chronicleUpdatedAt, T2);
});

test('a push result never rolls the recorded version back', async () => {
  const j = makeJournal({ id: 'j1', flags: { entityId: 'e1', chronicleUpdatedAt: T2 } });
  const { js } = make();
  await js._recordPush(j, { updated_at: T1 });
  assert.equal(j.flags.chronicleUpdatedAt, T2);
  await js._recordPush(j, { updated_at: '2026-10-03T04:00:03Z' });
  assert.equal(j.flags.chronicleUpdatedAt, '2026-10-03T04:00:03Z');
});

test('a permissions push reads back the version it stamped, and is not repeated', async () => {
  const j = makeJournal({ id: 'j1', flags: { entityId: 'e1', chronicleUpdatedAt: T1 } });
  const { js, puts } = make({ get: async () => ({ id: 'e1', updated_at: T2 }) });
  await js._pushPermissions('e1', { default: 2 }, false, 'Page', j);
  assert.equal(puts.length, 1);
  assert.equal(j.flags.chronicleUpdatedAt, T2);
  await js._pushPermissions('e1', { default: 2 }, false, 'Page', j);
  assert.equal(puts.length, 1, 'identical permissions not pushed again');
  await js._pushPermissions('e1', { default: 2, u1: 3 }, false, 'Page', j);
  assert.equal(puts.length, 2, 'changed permissions pushed');
});
