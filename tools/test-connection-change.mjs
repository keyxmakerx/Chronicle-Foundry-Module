#!/usr/bin/env node
/**
 * Pins what saving a changed connection does (scripts/_connection-change.mjs
 * and SyncManager.applyConnection): start when sync never started, reconnect
 * for a new address or key, and ask for a reload only for a new campaign.
 * Also pins that start() never initialises the parts twice.
 *
 * Run: `node --test tools/test-connection-change.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionAction } from '../scripts/_connection-change.mjs';

const settings = { campaignId: 'camp-a' };
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: { get: (_m, key) => settings[key] ?? '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
  user: { isGM: true },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };

const { SyncManager } = await import('../scripts/sync-manager.mjs');

test('connectionAction: never started → start', () => {
  assert.equal(connectionAction({ started: false, startedCampaign: null, campaign: 'camp-a' }), 'start');
});

test('connectionAction: same campaign → reconnect', () => {
  assert.equal(connectionAction({ started: true, startedCampaign: 'camp-a', campaign: ' camp-a ' }), 'reconnect');
});

test('connectionAction: different campaign → reload', () => {
  assert.equal(connectionAction({ started: true, startedCampaign: 'camp-a', campaign: 'camp-b' }), 'reload');
});

/** A manager whose start body and socket are recorded, not run. */
function makeManager({ startSucceeds = true } = {}) {
  const sm = new SyncManager();
  const calls = [];
  sm._startOnce = async () => {
    calls.push('start');
    await new Promise((r) => setTimeout(r, 5));
    if (startSucceeds) { sm._started = true; sm._startedCampaign = settings.campaignId; }
  };
  sm.api.disconnect = () => calls.push('disconnect');
  sm.api.connect = () => calls.push('connect');
  sm.logActivity = () => {};
  return { sm, calls };
}

test('applyConnection starts a sync that never started', async () => {
  settings.campaignId = 'camp-a';
  const { sm, calls } = makeManager();
  assert.equal(await sm.applyConnection(), 'started');
  assert.deepEqual(calls, ['start']);
});

test('applyConnection reports off when the start stopped early', async () => {
  const { sm, calls } = makeManager({ startSucceeds: false });
  assert.equal(await sm.applyConnection(), 'off');
  assert.deepEqual(calls, ['start']);
});

test('applyConnection reconnects for the same campaign, without starting again', async () => {
  settings.campaignId = 'camp-a';
  const { sm, calls } = makeManager();
  await sm.start();
  calls.length = 0;
  assert.equal(await sm.applyConnection(), 'reconnected');
  assert.deepEqual(calls, ['disconnect', 'connect']);
});

test('applyConnection asks for a reload when the campaign changed', async () => {
  settings.campaignId = 'camp-a';
  const { sm, calls } = makeManager();
  await sm.start();
  settings.campaignId = 'camp-b';
  calls.length = 0;
  assert.equal(await sm.applyConnection(), 'reload');
  assert.deepEqual(calls, [], 'a running sync is left alone');
  settings.campaignId = 'camp-a';
});

test('two overlapping starts run the start body once', async () => {
  const { sm, calls } = makeManager();
  await Promise.all([sm.start(), sm.start()]);
  await sm.start();
  assert.deepEqual(calls, ['start']);
});

test('a start that stopped early can run again later', async () => {
  const { sm, calls } = makeManager({ startSucceeds: false });
  await sm.start();
  await sm.start();
  assert.deepEqual(calls, ['start', 'start']);
});

test('players never start or reconnect', async () => {
  const { sm, calls } = makeManager();
  game.user.isGM = false;
  try {
    assert.equal(await sm.applyConnection(), 'off');
  } finally {
    game.user.isGM = true;
  }
  assert.deepEqual(calls, []);
});
