#!/usr/bin/env node
/**
 * Tests for the reconnect re-pull (FM-SYNC-HARDENING §2).
 *
 * Before this fix `_initialSyncDone` was a one-shot latch: once the first
 * sync completed it was never reset, so a WebSocket reconnect did NOT re-pull
 * changes made on Chronicle during the disconnect window — they were lost
 * until a world reload.
 *
 * The fix drives a debounced re-pull off the connection state machine:
 *   - a drop ('disconnected' / 'reconnecting') arms `_sawDisconnect`
 *   - a return to 'connected' AFTER initial sync schedules a debounced re-pull
 *   - flapping connections collapse to a single re-pull once the link settles
 *
 * These tests drive `_onConnectionStateChange` directly (the state machine is
 * the testable seam) with a stubbed `_performInitialSync` spy and node:test
 * fake timers for the debounce.
 *
 * Run: `node --test tools/test-sync-manager-reconnect.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --- Foundry global stubs for the settings.mjs import chain ---
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

const DEBOUNCE_MS = 3000;

/** Build a SyncManager whose initial sync is a counting spy. */
function makeManager() {
  const sm = new SyncManager();
  let syncCount = 0;
  sm._performInitialSync = async () => { syncCount += 1; };
  sm.logActivity = () => {};
  return { sm, calls: () => syncCount };
}

// ---------------------------------------------------------------------
// First connect must NOT trigger a reconnect re-pull
// ---------------------------------------------------------------------

test('first connect (no prior disconnect) does not schedule a re-pull', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();

  // Startup transitions: connecting → connected, before initial sync done.
  sm._onConnectionStateChange('connecting');
  sm._onConnectionStateChange('connected');
  t.mock.timers.tick(DEBOUNCE_MS + 100);

  assert.equal(calls(), 0, 'no re-pull on first connect');
});

test('connected after a drop but BEFORE initial sync done → no re-pull', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();

  sm._sawDisconnect = false;
  sm._initialSyncDone = false; // initial sync hasn't completed yet
  sm._onConnectionStateChange('disconnected');
  sm._onConnectionStateChange('connected');
  t.mock.timers.tick(DEBOUNCE_MS + 100);

  assert.equal(calls(), 0, 'gate requires _initialSyncDone before reconnect re-pull');
});

// ---------------------------------------------------------------------
// Genuine reconnect after initial sync → exactly one debounced re-pull
// ---------------------------------------------------------------------

test('reconnect after a drop re-pulls once, after the debounce window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();
  sm._initialSyncDone = true; // first sync already happened

  sm._onConnectionStateChange('disconnected');
  sm._onConnectionStateChange('connected');

  // Nothing fires until the debounce elapses.
  t.mock.timers.tick(DEBOUNCE_MS - 1);
  assert.equal(calls(), 0, 'no re-pull before debounce elapses');

  t.mock.timers.tick(2);
  // Allow the async _resyncAfterReconnect microtask to settle.
  await Promise.resolve();
  assert.equal(calls(), 1, 'exactly one re-pull after debounce');
});

test('flapping reconnect collapses to a single re-pull', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();
  sm._initialSyncDone = true;

  // Connection flaps several times; each 'connected' resets the debounce.
  for (let i = 0; i < 5; i++) {
    sm._onConnectionStateChange('reconnecting');
    sm._onConnectionStateChange('connected');
    t.mock.timers.tick(DEBOUNCE_MS - 500); // never lets the timer fire
  }
  assert.equal(calls(), 0, 'no re-pull while flapping');

  // Connection finally settles.
  t.mock.timers.tick(DEBOUNCE_MS + 100);
  await Promise.resolve();
  assert.equal(calls(), 1, 'one re-pull once the link settles');
});

test('a second independent reconnect re-pulls again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();
  sm._initialSyncDone = true;

  sm._onConnectionStateChange('disconnected');
  sm._onConnectionStateChange('connected');
  t.mock.timers.tick(DEBOUNCE_MS + 10);
  await Promise.resolve();
  assert.equal(calls(), 1);

  // Later, another drop + reconnect.
  sm._onConnectionStateChange('disconnected');
  sm._onConnectionStateChange('connected');
  t.mock.timers.tick(DEBOUNCE_MS + 10);
  await Promise.resolve();
  assert.equal(calls(), 2, 'each genuine reconnect re-pulls');
});

// ---------------------------------------------------------------------
// stop() cancels a pending re-pull
// ---------------------------------------------------------------------

test('stop() clears a pending reconnect re-pull', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sm, calls } = makeManager();
  sm._initialSyncDone = true;
  // stop() calls api.disconnect(); stub the ws away so it's a no-op.
  sm.api.disconnect = () => {};

  sm._onConnectionStateChange('disconnected');
  sm._onConnectionStateChange('connected'); // schedules the debounced re-pull
  sm.stop();
  t.mock.timers.tick(DEBOUNCE_MS + 100);

  assert.equal(calls(), 0, 'pending re-pull cancelled on stop()');
  assert.equal(sm._reconnectResyncTimer, null);
});

// ---------------------------------------------------------------------
// Static-source regression pins
// ---------------------------------------------------------------------

test('pin: start() registers an onStateChange listener for reconnect', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/sync-manager.mjs'), 'utf8');
  assert.ok(
    /this\.api\.onStateChange\(\(state\)\s*=>\s*this\._onConnectionStateChange\(state\)\)/.test(src),
    'start() must wire api.onStateChange → _onConnectionStateChange (FM-SYNC-HARDENING §2)',
  );
});

test('pin: reconnect re-pull is debounced (single timer, cleared on reschedule)', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/sync-manager.mjs'), 'utf8');
  const m = src.match(/_scheduleReconnectResync\(\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(m, '_scheduleReconnectResync not found');
  assert.ok(/clearTimeout\(this\._reconnectResyncTimer\)/.test(m[1]),
    'debounce must clear the prior timer so flapping collapses to one re-pull');
});
