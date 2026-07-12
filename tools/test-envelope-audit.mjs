#!/usr/bin/env node
/**
 * Regression pins for FM-ENVELOPE-AUDIT — the follow-up sweep flagged by
 * PR #77 (FM-CAL-BACKCATALOG-FIX) re-verify item 5.
 *
 * PR #77 fixed the calendar back-catalog silently importing nothing because
 * Chronicle wraps list responses in `{"data":[…],"total":N}` while the module
 * expected a bare array. This dispatch audited EVERY remaining list-consuming
 * `get()` caller against the real Chronicle handler shape. The verdict: zero
 * remaining mismatches — every list caller already unwraps defensively. See
 * the PR body caller table for the full evidence.
 *
 * These tests are regression PINS, not fixes: they stub the REAL Chronicle
 * response shape (envelope for `/entity-types`, `/systems`, `/addons`; bare
 * array + `.data` envelope for map sub-resources) and assert that the two
 * callers PR #77 explicitly flagged — plus the least-defensive envelope caller
 * — still extract the list correctly. If a future refactor drops the `.data`
 * unwrap at any of these sites, the corresponding test fails (verified by
 * temporary revert during authoring).
 *
 * Consumer-verified handler shapes (Chronicle @ this session's checkout):
 *   /entity-types → ENVELOPE  {data,total}  internal/plugins/syncapi/api_handler.go:249-251 (ListEntityTypes)
 *   /systems      → ENVELOPE  {data,total}  internal/plugins/syncapi/api_handler.go:1067-1069 (ListSystems)
 *   /addons       → ENVELOPE  {data,total}  internal/plugins/syncapi/api_handler.go:1198-1200 (ListAddons)
 *   /maps/:id/*   → BARE array               internal/plugins/syncapi/map_api_handler.go (ListMarkers/… c.JSON of a slice)
 *
 * Run: `node --test tools/test-envelope-audit.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Foundry global stubs (must be set before the first import of module code).
// Mirrors tools/test-pc-claiming.mjs so the modules import headlessly.
// ---------------------------------------------------------------------------

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
    sheets: { ActorSheetV2: class {} },
    ux: { TextEditor: { enrichHTML: async (x) => x } },
  },
  utils: { mergeObject: (a, b) => ({ ...a, ...b }) },
};
globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.Actor = globalThis.Actor || { create: async () => ({ id: 'a1' }) };
globalThis.ui = globalThis.ui || {
  notifications: { info: () => {}, warn: () => {}, error: () => {} },
};
globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  system: { id: 'dnd5e' },
  actors: { contents: [] },
  users: { get: () => null },
  journal: { find: () => null, contents: [] },
};

const { ActorSync } = await import('../scripts/actor-sync.mjs');
const { SyncManager } = await import('../scripts/sync-manager.mjs');
const { MapSync } = await import('../scripts/map-sync.mjs');

/** The real Chronicle list envelope: {data:[…], total:N}. */
const envelope = (arr) => ({ data: arr, total: arr.length });

// ---------------------------------------------------------------------------
// actor-sync.mjs:631 — GET /entity-types (ENVELOPE)   [PR #77 flagged caller #1]
// _resolveCharacterTypeId reads `result?.data || result || []`.
// ---------------------------------------------------------------------------

/** Build an ActorSync with a known character slug and a stubbed API. */
function makeActorSync(getImpl) {
  const s = new ActorSync();
  s._adapter = { characterTypeSlug: 'character' };
  s._api = { get: getImpl };
  return s;
}

test('actor-sync /entity-types: REAL envelope {data,total} → character type resolves', async () => {
  const s = makeActorSync(async (path) => {
    assert.equal(path, '/entity-types');
    return envelope([
      { id: 7, slug: 'character', name: 'Character' },
      { id: 9, slug: 'npc', name: 'NPC' },
    ]);
  });
  await s._resolveCharacterTypeId();
  assert.equal(s._characterTypeId, 7, 'must unwrap .data from the envelope and match the character type');
});

test('actor-sync /entity-types: bare array (legacy shape) → still resolves', async () => {
  const s = makeActorSync(async () => [{ id: 7, slug: 'character', name: 'Character' }]);
  await s._resolveCharacterTypeId();
  assert.equal(s._characterTypeId, 7, 'bare-array fallback (result || []) must still work');
});

test('actor-sync /entity-types: empty envelope {data:[],total:0} → no match, no throw', async () => {
  const s = makeActorSync(async () => envelope([]));
  await s._resolveCharacterTypeId();
  assert.ok(!s._characterTypeId, 'an empty list resolves to no character type (not a crash)');
});

// ---------------------------------------------------------------------------
// sync-manager.mjs:456 — GET /systems (ENVELOPE)   [least-defensive caller]
// _detectSystem reads `result.data || []` (envelope-only unwrap).
// ---------------------------------------------------------------------------

test('sync-manager /systems: REAL envelope {data,total} → system matched by foundry_system_id', async () => {
  const sm = new SyncManager();
  sm.logActivity = () => {};
  sm.api.get = async (path) => {
    assert.equal(path, '/systems');
    return envelope([
      { id: 'dnd5e', name: 'D&D 5e', foundry_system_id: 'dnd5e', enabled: true },
      { id: 'pf2e', name: 'Pathfinder 2e', foundry_system_id: 'pf2e', enabled: true },
    ]);
  };
  await sm._detectSystem();
  assert.equal(sm._matchedSystem, 'dnd5e', 'must unwrap .data and match on foundry_system_id');
});

// ---------------------------------------------------------------------------
// sync-manager.mjs:423 — getAddons() → GET /addons (ENVELOPE)
// _fetchAddons reads `Array.isArray(addons) ? addons : (addons?.data ?? [])`.
// The existing test-pc-claiming.mjs only stubs the BARE-array shape; this pins
// the REAL envelope path.
// ---------------------------------------------------------------------------

test('sync-manager /addons: REAL envelope {data,total} → PC-claiming addon detected', async () => {
  const sm = new SyncManager();
  sm.logActivity = () => {};
  sm.api.getAddons = async () => envelope([
    { slug: 'player-character-claiming', enabled: true },
    { slug: 'calendar', enabled: true },
  ]);
  await sm._fetchAddons();
  assert.ok(sm.isPcClaimingEnabled(), 'must unwrap .data from the addons envelope to see the addon');
});

// ---------------------------------------------------------------------------
// map-sync.mjs:908 / :1052 — GET /maps/:id/{markers,drawings,tokens,layers}
// Sub-resources are BARE arrays; _coerceArray also tolerates a .data envelope.
// ---------------------------------------------------------------------------

test('map-sync _coerceArray: bare array (real sub-resource shape) → passthrough', () => {
  const ms = new MapSync();
  assert.deepEqual(ms._coerceArray([{ id: 'm1' }, { id: 'm2' }]), [{ id: 'm1' }, { id: 'm2' }]);
});

test('map-sync _coerceArray: {data:[…]} envelope → unwrapped', () => {
  const ms = new MapSync();
  assert.deepEqual(ms._coerceArray(envelope([{ id: 'm1' }])), [{ id: 'm1' }]);
});

test('map-sync _coerceArray: null / non-array object → empty array (never throws)', () => {
  const ms = new MapSync();
  assert.deepEqual(ms._coerceArray(null), []);
  assert.deepEqual(ms._coerceArray(undefined), []);
  assert.deepEqual(ms._coerceArray({ nope: true }), []);
});
