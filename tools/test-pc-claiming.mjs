#!/usr/bin/env node
/**
 * Tests for PC-CLAIM-4: addon-gated PC sub-type resolution and entity routing.
 *
 * Covers:
 *   - _findPcSubtypeId(): pure helper that locates the "Player Characters"
 *     child type in the /entity-types response list.
 *   - _pickEntityTypeId(): pure helper that selects the correct entity_type_id
 *     for a new Chronicle entity based on addon state and owner presence.
 *   - ActorSync._isCharacterEntity(): accepts both the parent character type
 *     and the PC sub-type; rejects unrelated types.
 *   - ActorSync.hasPlayerOwnedPcs(): detects player-owned actors for the hint.
 *   - SyncManager.isPcClaimingEnabled() / _fetchAddons(): addon detection.
 *
 * Run: `node --test tools/test-pc-claiming.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Foundry global stubs (must be set before the first import of module code)
// ---------------------------------------------------------------------------

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
  },
};
globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.Actor = globalThis.Actor || { create: async () => ({ id: 'a1' }) };
globalThis.ui = globalThis.ui || {
  notifications: { info: () => {}, warn: () => {}, error: () => {} },
};

// Mutable actors/users store — tests write to these before calling.
const actorsContents = [];
const usersStore = {};

globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  system: { id: 'dnd5e' },
  actors: { contents: actorsContents },
  users: { get: (id) => usersStore[id] ?? null },
};

const { _findPcSubtypeId, _pickEntityTypeId, ActorSync } =
  await import('../scripts/actor-sync.mjs');
const { SyncManager } = await import('../scripts/sync-manager.mjs');

// ---------------------------------------------------------------------------
// _findPcSubtypeId
// ---------------------------------------------------------------------------

test('_findPcSubtypeId: empty types → null', () => {
  assert.equal(_findPcSubtypeId([], 5), null);
});

test('_findPcSubtypeId: null parentTypeId → null', () => {
  assert.equal(_findPcSubtypeId([{ id: 8, slug: 'player-characters', parent_id: null }], null), null);
});

test('_findPcSubtypeId: child with wrong parent → null', () => {
  const types = [{ id: 8, slug: 'player-characters', name: 'Player Characters', parent_id: 99 }];
  assert.equal(_findPcSubtypeId(types, 5), null);
});

test('_findPcSubtypeId: matches by parent_id + name "Player Characters"', () => {
  const types = [
    { id: 5, slug: 'character', name: 'Character', parent_id: null },
    { id: 8, slug: 'player-characters', name: 'Player Characters', parent_id: 5 },
    { id: 9, slug: 'npc', name: 'NPC', parent_id: 5 },
  ];
  assert.equal(_findPcSubtypeId(types, 5), 8);
});

test('_findPcSubtypeId: matches by parent_type_id field variant', () => {
  const types = [{ id: 8, slug: 'player-characters', name: 'Player Characters', parent_type_id: 5 }];
  assert.equal(_findPcSubtypeId(types, 5), 8);
});

test('_findPcSubtypeId: normalises slug underscores', () => {
  const types = [{ id: 8, slug: 'player_characters', name: 'Player Characters', parent_id: 5 }];
  assert.equal(_findPcSubtypeId(types, 5), 8);
});

test('_findPcSubtypeId: ignores non-PC children', () => {
  const types = [
    { id: 9, slug: 'npc', name: 'NPC', parent_id: 5 },
    { id: 10, slug: 'monster', name: 'Monster', parent_id: 5 },
  ];
  assert.equal(_findPcSubtypeId(types, 5), null);
});

test('_findPcSubtypeId: startsWith "player character" name variant', () => {
  const types = [{ id: 8, slug: 'pc', name: 'Player Character Sheet', parent_id: 5 }];
  assert.equal(_findPcSubtypeId(types, 5), 8);
});

// ---------------------------------------------------------------------------
// _pickEntityTypeId
// ---------------------------------------------------------------------------

test('_pickEntityTypeId: player owner + sub-type resolved → sub-type', () => {
  assert.equal(_pickEntityTypeId(5, 8, 'chronicle-u1'), 8);
});

test('_pickEntityTypeId: player owner but no sub-type → parent type', () => {
  assert.equal(_pickEntityTypeId(5, null, 'chronicle-u1'), 5);
});

test('_pickEntityTypeId: no owner (addon off) → parent type regardless of sub-type', () => {
  assert.equal(_pickEntityTypeId(5, 8, null), 5);
});

test('_pickEntityTypeId: no owner, no sub-type → parent type', () => {
  assert.equal(_pickEntityTypeId(5, null, null), 5);
});

// ---------------------------------------------------------------------------
// ActorSync._isCharacterEntity
// ---------------------------------------------------------------------------

/** Build a minimal ActorSync with known IDs. */
function makeSync({ charId = 5, pcId = null, slug = 'character' } = {}) {
  const s = new ActorSync();
  s._characterTypeId = charId;
  s._pcSubtypeId = pcId;
  s._adapter = slug ? { characterTypeSlug: slug } : null;
  return s;
}

test('_isCharacterEntity: parent type ID → true', () => {
  const s = makeSync({ charId: 5, pcId: null });
  assert.ok(s._isCharacterEntity({ entity_type_id: 5 }));
});

test('_isCharacterEntity: PC sub-type ID → true', () => {
  const s = makeSync({ charId: 5, pcId: 8 });
  assert.ok(s._isCharacterEntity({ entity_type_id: 8 }));
});

test('_isCharacterEntity: unrelated type ID → false', () => {
  const s = makeSync({ charId: 5, pcId: 8 });
  assert.ok(!s._isCharacterEntity({ entity_type_id: 99 }));
});

test('_isCharacterEntity: NPC type ID → false', () => {
  const s = makeSync({ charId: 5, pcId: null });
  assert.ok(!s._isCharacterEntity({ entity_type_id: 3 }));
});

test('_isCharacterEntity: slug fallback when no entity_type_id', () => {
  const s = makeSync({ charId: 5 });
  assert.ok(s._isCharacterEntity({ type_slug: 'character' }));
  assert.ok(!s._isCharacterEntity({ type_slug: 'npc' }));
});

test('_isCharacterEntity: type_name fallback when no IDs or slug', () => {
  const s = makeSync({ charId: null, pcId: null, slug: null });
  assert.ok(s._isCharacterEntity({ type_name: 'Player Characters' }));
  assert.ok(!s._isCharacterEntity({ type_name: 'Monster' }));
});

test('_isCharacterEntity: entity with only PC sub-type name → true via fallback', () => {
  // No IDs resolved yet, no type_slug — type_name contains "character"
  const s = makeSync({ charId: null, pcId: null, slug: null });
  assert.ok(s._isCharacterEntity({ type_name: 'Player Characters' }));
});

// ---------------------------------------------------------------------------
// ActorSync.hasPlayerOwnedPcs
// ---------------------------------------------------------------------------

function makeActorStub({ type = 'character', ownership = {} }) {
  return { type, ownership };
}

test('hasPlayerOwnedPcs: no actors → false', () => {
  actorsContents.length = 0;
  const s = makeSync();
  s._adapter = { actorType: 'character', characterTypeSlug: 'character' };
  assert.ok(!s.hasPlayerOwnedPcs());
});

test('hasPlayerOwnedPcs: actor owned only by GM → false', () => {
  actorsContents.length = 0;
  usersStore['gm1'] = { isGM: true };
  actorsContents.push(makeActorStub({ ownership: { gm1: 3 } }));
  const s = makeSync();
  s._adapter = { actorType: 'character', characterTypeSlug: 'character' };
  assert.ok(!s.hasPlayerOwnedPcs());
});

test('hasPlayerOwnedPcs: actor owned by a player → true', () => {
  actorsContents.length = 0;
  usersStore['p1'] = { isGM: false };
  actorsContents.push(makeActorStub({ ownership: { p1: 3 } }));
  const s = makeSync();
  s._adapter = { actorType: 'character', characterTypeSlug: 'character' };
  assert.ok(s.hasPlayerOwnedPcs());
});

test('hasPlayerOwnedPcs: ownership level OBSERVER (not OWNER) → false', () => {
  actorsContents.length = 0;
  usersStore['p2'] = { isGM: false };
  actorsContents.push(makeActorStub({ ownership: { p2: 2 } })); // OBSERVER = 2
  const s = makeSync();
  s._adapter = { actorType: 'character', characterTypeSlug: 'character' };
  assert.ok(!s.hasPlayerOwnedPcs());
});

test('hasPlayerOwnedPcs: wrong actor type is ignored', () => {
  actorsContents.length = 0;
  usersStore['p3'] = { isGM: false };
  actorsContents.push(makeActorStub({ type: 'npc', ownership: { p3: 3 } }));
  const s = makeSync();
  s._adapter = { actorType: 'character', characterTypeSlug: 'character' }; // type mismatch
  assert.ok(!s.hasPlayerOwnedPcs());
});

// ---------------------------------------------------------------------------
// SyncManager.isPcClaimingEnabled / _fetchAddons
// ---------------------------------------------------------------------------

test('isPcClaimingEnabled: false by default', () => {
  const sm = new SyncManager();
  assert.ok(!sm.isPcClaimingEnabled());
});

test('_fetchAddons: enables flag when addon present and enabled', async () => {
  const sm = new SyncManager();
  sm.api.getAddons = async () => [
    { slug: 'player-character-claiming', enabled: true },
    { slug: 'calendar', enabled: true },
  ];
  sm.logActivity = () => {};
  await sm._fetchAddons();
  assert.ok(sm.isPcClaimingEnabled());
});

test('_fetchAddons: remains false when addon is missing', async () => {
  const sm = new SyncManager();
  sm.api.getAddons = async () => [{ slug: 'calendar', enabled: true }];
  sm.logActivity = () => {};
  await sm._fetchAddons();
  assert.ok(!sm.isPcClaimingEnabled());
});

test('_fetchAddons: remains false when addon enabled=false', async () => {
  const sm = new SyncManager();
  sm.api.getAddons = async () => [{ slug: 'player-character-claiming', enabled: false }];
  sm.logActivity = () => {};
  await sm._fetchAddons();
  assert.ok(!sm.isPcClaimingEnabled());
});

test('_fetchAddons: gracefully degrades when endpoint throws', async () => {
  const sm = new SyncManager();
  sm.api.getAddons = async () => { throw new Error('404 Not Found'); };
  sm.logActivity = () => {};
  await sm._fetchAddons(); // must not throw
  assert.ok(!sm.isPcClaimingEnabled());
});
