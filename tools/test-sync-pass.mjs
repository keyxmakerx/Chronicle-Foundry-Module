#!/usr/bin/env node
/**
 * The connect catch-up runs one pass at a time, and a pass that failed is
 * tried again while the connection stays up.
 *
 * Run: `node --test tools/test-sync-pass.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
  },
};
globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };

const { SyncManager } = await import('../scripts/sync-manager.mjs');

/** A manager whose pass body is a spy answering `results` in turn. */
function makeManager(results) {
  const sm = new SyncManager();
  let runs = 0;
  sm._runInitialSync = async () => {
    const result = results[Math.min(runs, results.length - 1)];
    runs += 1;
    return result;
  };
  sm._started = true;
  sm.api = { state: 'connected' };
  return { sm, runs: () => runs };
}

/** Let the pass's promise chain settle. */
const settle = () => new Promise((done) => setImmediate(done));

test('two callers at once share one pass', async () => {
  const { sm, runs } = makeManager([true]);
  const [a, b] = await Promise.all([sm._performInitialSync(), sm._performInitialSync()]);
  assert.equal(runs(), 1);
  assert.equal(a, true);
  assert.equal(b, true);
  await sm._performInitialSync();
  assert.equal(runs(), 2, 'a later call starts a new pass');
});

test('a failed pass is tried again after 30 seconds, and a good one stops the retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, runs } = makeManager([false, true]);
  assert.equal(await sm._performInitialSync(), false);
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(runs(), 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(runs(), 2);
  assert.equal(sm._initialSyncDone, true);
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(runs(), 2, 'no retry after a pass that worked');
});

test('retries stop after three, and never run while disconnected or stopped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, runs } = makeManager([false]);
  await sm._performInitialSync();
  for (const delay of [30_000, 60_000, 120_000, 600_000]) {
    t.mock.timers.tick(delay);
    await settle();
  }
  assert.equal(runs(), 4, 'the first pass and three retries');

  const down = makeManager([false]);
  await down.sm._performInitialSync();
  down.sm.api.state = 'reconnecting';
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(down.runs(), 1);
});
