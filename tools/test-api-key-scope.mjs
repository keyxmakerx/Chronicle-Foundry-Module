#!/usr/bin/env node
/**
 * FM-SEC-KEY-SCOPE: the Chronicle API key must never be a world-scoped
 * Foundry setting, and the one-time migration must move a legacy world value
 * into client scope AND delete the world document.
 *
 * A world setting is synced to every connected client. config:false hides it
 * from the settings UI and nothing else: any player could run
 * game.settings.get('chronicle-sync','apiKey') and hold the Bearer token.
 *
 * Run: node --test tools/test-api-key-scope.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, '..', 'scripts', 'settings.mjs');

// Minimal Foundry globals so settings.mjs imports headless.
globalThis.game = globalThis.game || {};
globalThis.game.i18n = globalThis.game.i18n || { localize: (k) => k, format: (k) => k };
globalThis.game.modules = globalThis.game.modules || { get: () => null };
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
// settings.mjs imports two ApplicationV2 sheets that read this at load time.
globalThis.foundry = globalThis.foundry || { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (cls) => cls } }, utils: { escapeHTML: (s) => String(s) } };
globalThis.ui = globalThis.ui || { notifications: { warn: () => {}, info: () => {}, error: () => {} } };

test('apiKey is registered with client scope, never world', () => {
  const src = readFileSync(SETTINGS, 'utf8');
  const block = src.slice(src.indexOf("register(MODULE_ID, 'apiKey'"));
  const reg = block.slice(0, block.indexOf('});'));
  assert.match(reg, /scope:\s*'client'/,
    "apiKey must be scope:'client' — a world-scoped key is readable by every player");
  assert.doesNotMatch(reg, /scope:\s*'world'/);
});

test('migration moves a legacy world value into client scope and deletes the world document', async () => {
  const { migrateApiKeyToClientScope } = await import(SETTINGS);
  const sets = [];
  let deleted = false;
  globalThis.game.settings = {
    register: () => {},
    registerMenu: () => {},
    get: () => '',
    set: async (ns, key, value) => { sets.push([ns, key, value]); },
    storage: { get: (scope) => scope === 'world'
      ? { getSetting: (k) => k === 'chronicle-sync.apiKey' ? { value: 'legacy-secret', delete: async () => { deleted = true; } } : undefined }
      : undefined },
  };
  const handled = await migrateApiKeyToClientScope();
  assert.equal(handled, true);
  assert.deepEqual(sets, [['chronicle-sync', 'apiKey', 'legacy-secret']]);
  assert.equal(deleted, true, 'the world-side Setting document must be deleted, not just ignored — it is still synced to every client otherwise');
});

test('migration is a no-op with no legacy world document', async () => {
  const { migrateApiKeyToClientScope } = await import(SETTINGS);
  const sets = [];
  globalThis.game.settings = {
    register: () => {}, registerMenu: () => {}, get: () => '',
    set: async (...a) => { sets.push(a); },
    storage: { get: () => ({ getSetting: () => undefined }) },
  };
  assert.equal(await migrateApiKeyToClientScope(), false);
  assert.deepEqual(sets, []);
});

test('migration never overwrites a client value the GM already entered', async () => {
  const { migrateApiKeyToClientScope } = await import(SETTINGS);
  const sets = [];
  let deleted = false;
  globalThis.game.settings = {
    register: () => {}, registerMenu: () => {}, get: () => 'already-here',
    set: async (...a) => { sets.push(a); },
    storage: { get: () => ({ getSetting: () => ({ value: 'legacy-secret', delete: async () => { deleted = true; } }) }) },
  };
  assert.equal(await migrateApiKeyToClientScope(), true);
  assert.deepEqual(sets, [], 'an existing client value wins');
  assert.equal(deleted, true, 'the world copy still goes');
});
