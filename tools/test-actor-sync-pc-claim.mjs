#!/usr/bin/env node
/**
 * Tests for PC-CLAIM-4: actor-sync addon awareness.
 *
 * Tests that:
 *  1. SyncManager tracks addon state (_playerClaimingEnabled, _fetchAddonState,
 *     isPlayerClaimingEnabled).
 *  2. _fetchAddonState is called in _performInitialSync before module onInitialSync.
 *  3. ActorSync tracks _pcSubTypeId + _claimHintShown.
 *  4. _resolvePcSubTypeId matches preset_category and slug.
 *  5. _handleCreateActor gates owner_user_id and entity_type_id on addon state.
 *  6. _isCharacterEntity matches both character type and PC sub-type.
 *  7. The claiming-off hint fires at most once.
 *
 * Behavioral tests use minimal stubs; structural tests use source-pin analysis.
 *
 * Run: node --test tools/test-actor-sync-pc-claim.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const actorSyncSource = readFileSync(resolve(REPO_ROOT, 'scripts/actor-sync.mjs'), 'utf8');
const syncManagerSource = readFileSync(resolve(REPO_ROOT, 'scripts/sync-manager.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// SyncManager — structural checks
// ---------------------------------------------------------------------------

test('SyncManager has _playerClaimingEnabled property', () => {
  assert.ok(
    syncManagerSource.includes('_playerClaimingEnabled'),
    'Expected _playerClaimingEnabled in sync-manager.mjs',
  );
});

test('SyncManager has _fetchAddonState method', () => {
  assert.ok(
    syncManagerSource.includes('_fetchAddonState'),
    'Expected _fetchAddonState in sync-manager.mjs',
  );
});

test('SyncManager has isPlayerClaimingEnabled method', () => {
  assert.ok(
    syncManagerSource.includes('isPlayerClaimingEnabled'),
    'Expected isPlayerClaimingEnabled in sync-manager.mjs',
  );
});

test('_fetchAddonState looks for player-character-claiming slug', () => {
  assert.ok(
    syncManagerSource.includes("'player-character-claiming'"),
    'Expected slug "player-character-claiming" to be checked in _fetchAddonState',
  );
});

test('_performInitialSync calls _fetchAddonState before module onInitialSync', () => {
  const fetchIdx = syncManagerSource.indexOf('_fetchAddonState');
  const onInitIdx = syncManagerSource.indexOf("mod.onInitialSync === 'function'");
  assert.ok(fetchIdx !== -1, 'Expected _fetchAddonState to be defined');
  assert.ok(onInitIdx !== -1, 'Expected mod.onInitialSync loop in _performInitialSync');
  // The _fetchAddonState call in _performInitialSync appears before the onInitialSync loop.
  const callMatch = syncManagerSource.match(/await this\._fetchAddonState\(\)/);
  assert.ok(callMatch, 'Expected _fetchAddonState to be awaited in _performInitialSync');
  const callIdx = syncManagerSource.indexOf('await this._fetchAddonState()');
  assert.ok(
    callIdx < onInitIdx,
    '_fetchAddonState must be called before module onInitialSync loop',
  );
});

// ---------------------------------------------------------------------------
// ActorSync — structural checks
// ---------------------------------------------------------------------------

test('ActorSync has _pcSubTypeId property', () => {
  assert.ok(
    actorSyncSource.includes('_pcSubTypeId'),
    'Expected _pcSubTypeId in actor-sync.mjs',
  );
});

test('ActorSync has _claimHintShown property', () => {
  assert.ok(
    actorSyncSource.includes('_claimHintShown'),
    'Expected _claimHintShown in actor-sync.mjs',
  );
});

test('ActorSync has _resolvePcSubTypeId method', () => {
  assert.ok(
    actorSyncSource.includes('_resolvePcSubTypeId'),
    'Expected _resolvePcSubTypeId in actor-sync.mjs',
  );
});

test('_resolvePcSubTypeId checks preset_category and slug', () => {
  assert.ok(
    actorSyncSource.includes("'player_character'"),
    'Expected preset_category check for "player_character" in _resolvePcSubTypeId',
  );
  assert.ok(
    actorSyncSource.includes("'player-character'"),
    'Expected slug check for "player-character" in _resolvePcSubTypeId',
  );
});

test('ActorSync has _maybeShowClaimingHint method', () => {
  assert.ok(
    actorSyncSource.includes('_maybeShowClaimingHint'),
    'Expected _maybeShowClaimingHint in actor-sync.mjs',
  );
});

test('_handleCreateActor gates owner_user_id on claiming addon state', () => {
  assert.ok(
    actorSyncSource.includes('isPlayerClaimingEnabled'),
    'Expected isPlayerClaimingEnabled call in actor-sync.mjs',
  );
  assert.ok(
    actorSyncSource.includes('claimingEnabled'),
    'Expected claimingEnabled gate in actor-sync.mjs',
  );
});

test('_handleCreateActor uses _pcSubTypeId when addon on and owner set', () => {
  assert.ok(
    actorSyncSource.includes('_pcSubTypeId'),
    'Expected _pcSubTypeId to be used in entity_type_id selection',
  );
  // Verify the ternary pattern exists: claimingEnabled + ownerUserId + _pcSubTypeId -> PC type
  assert.ok(
    actorSyncSource.includes('claimingEnabled && ownerUserId && this._pcSubTypeId'),
    'Expected guard "claimingEnabled && ownerUserId && this._pcSubTypeId" for PC sub-type selection',
  );
});

test('_isCharacterEntity matches both character type ID and PC sub-type ID', () => {
  assert.ok(
    actorSyncSource.includes('this._pcSubTypeId && entity.entity_type_id === this._pcSubTypeId'),
    'Expected _isCharacterEntity to also match entity_type_id === _pcSubTypeId',
  );
});

test('_claimHintShown prevents repeated hints', () => {
  assert.ok(
    actorSyncSource.includes('!this._claimHintShown'),
    'Expected _claimHintShown guard to prevent repeated hint notifications',
  );
  assert.ok(
    actorSyncSource.includes('this._claimHintShown = true'),
    'Expected _claimHintShown to be set to true after showing hint',
  );
});

// ---------------------------------------------------------------------------
// Behavioral: pure PC sub-type detection logic
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the type-detection logic inside _resolvePcSubTypeId.
 * Extracted here as a pure function for direct testing.
 */
function findPcSubType(types) {
  return types.find(
    (t) => t.preset_category === 'player_character' || t.slug === 'player-character'
  ) ?? null;
}

test('findPcSubType matches by preset_category', () => {
  const types = [
    { id: 1, name: 'Characters', slug: 'character', preset_category: null },
    { id: 2, name: 'Player Characters', slug: 'player-characters', preset_category: 'player_character' },
  ];
  const match = findPcSubType(types);
  assert.equal(match?.id, 2, 'Should find type with preset_category=player_character');
});

test('findPcSubType matches by slug', () => {
  const types = [
    { id: 1, name: 'Characters', slug: 'character', preset_category: null },
    { id: 3, name: 'Heroes', slug: 'player-character', preset_category: null },
  ];
  const match = findPcSubType(types);
  assert.equal(match?.id, 3, 'Should find type with slug=player-character');
});

test('findPcSubType returns null when no PC sub-type exists', () => {
  const types = [
    { id: 1, name: 'Characters', slug: 'character', preset_category: null },
    { id: 4, name: 'NPCs', slug: 'npc', preset_category: null },
  ];
  assert.equal(findPcSubType(types), null, 'Should return null when no PC sub-type found');
});

// ---------------------------------------------------------------------------
// Behavioral: entity_type_id selection logic
// ---------------------------------------------------------------------------

/**
 * Pure extraction of the entity_type_id selection logic from _handleCreateActor.
 */
function selectEntityTypeId(claimingEnabled, ownerUserId, pcSubTypeId, characterTypeId) {
  return claimingEnabled && ownerUserId && pcSubTypeId ? pcSubTypeId : characterTypeId;
}

test('selectEntityTypeId uses PC sub-type when addon on + owner + sub-type resolved', () => {
  assert.equal(selectEntityTypeId(true, 'user-1', 2, 1), 2);
});

test('selectEntityTypeId uses character type when addon on but no owner', () => {
  assert.equal(selectEntityTypeId(true, null, 2, 1), 1);
});

test('selectEntityTypeId uses character type when addon on but no PC sub-type resolved', () => {
  assert.equal(selectEntityTypeId(true, 'user-1', null, 1), 1);
});

test('selectEntityTypeId uses character type when addon off (regardless of owner)', () => {
  assert.equal(selectEntityTypeId(false, 'user-1', 2, 1), 1);
});

test('selectEntityTypeId uses character type when all are null/false', () => {
  assert.equal(selectEntityTypeId(false, null, null, 1), 1);
});
