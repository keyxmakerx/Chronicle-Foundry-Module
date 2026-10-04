#!/usr/bin/env node
/**
 * Unit tests for the wire-visibility helpers in `scripts/calendar-sync.mjs`.
 *
 * The wire value is kebab `'gm-only'`, not the storage-side underscore
 * `'gm_only'` — Chronicle stores `gm_only` and translates both ways, but the
 * wire value is the canonical contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub Foundry globals that calendar-sync.mjs transitively imports
// (calendar-sync imports settings.mjs → imports update-info.mjs, which
// references `foundry.applications.api` at module top level). The pure
// helpers we're testing don't touch any of these — the stubs only need to
// satisfy import-time references.
globalThis.foundry = globalThis.foundry || {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (base) => base,
    },
  },
};
globalThis.game = globalThis.game || {
  settings: { get: () => null, register: () => {}, registerMenu: () => {} },
  i18n:     { localize: (k) => k, format: (k) => k },
  user:     { isGM: true },
  modules:  { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const {
  WIRE_VISIBILITY,
  isWireVisibilityGmOnly,
  isChronicleEventPublic,
} = await import('../scripts/calendar-sync.mjs');

// ---------------------------------------------------------------------
// WIRE_VISIBILITY constants
// ---------------------------------------------------------------------

test('WIRE_VISIBILITY pins canonical kebab strings', () => {
  assert.equal(WIRE_VISIBILITY.EVERYONE, 'everyone');
  assert.equal(WIRE_VISIBILITY.GM_ONLY,  'gm-only');
  // The constant must be frozen so a later PR can't quietly mutate it.
  assert.ok(Object.isFrozen(WIRE_VISIBILITY));
});

test('WIRE_VISIBILITY does NOT contain the storage-side underscore', () => {
  // Negative pin: if a future patch reintroduces `gm_only` as a wire
  // value this test breaks first.
  const values = Object.values(WIRE_VISIBILITY);
  assert.ok(!values.includes('gm_only'),
    `wire enum must never contain storage form 'gm_only', got: ${values.join(', ')}`);
});

// ---------------------------------------------------------------------
// isWireVisibilityGmOnly — consumption (Chronicle → Foundry)
// ---------------------------------------------------------------------

test('consume: kebab "gm-only" is GM-only', () => {
  assert.equal(isWireVisibilityGmOnly('gm-only'), true);
});

test('consume: underscore "gm_only" is still recognized (defensive)', () => {
  // The wire form is kebab, but if Chronicle ever leaks the storage form,
  // we still treat it as GM-only rather than silently flipping the note
  // public. Pins defensive behavior.
  assert.equal(isWireVisibilityGmOnly('gm_only'), true);
});

test('consume: "everyone" is NOT GM-only', () => {
  assert.equal(isWireVisibilityGmOnly('everyone'), false);
});

test('consume: missing / unknown values are NOT GM-only', () => {
  assert.equal(isWireVisibilityGmOnly(null), false);
  assert.equal(isWireVisibilityGmOnly(undefined), false);
  assert.equal(isWireVisibilityGmOnly(''), false);
  assert.equal(isWireVisibilityGmOnly('public'), false);
});

// ---------------------------------------------------------------------
// isChronicleEventPublic — Chronicle → Foundry, fail closed
// ---------------------------------------------------------------------

test('isChronicleEventPublic: everyone with no rules is public', () => {
  assert.equal(isChronicleEventPublic({ visibility: 'everyone' }), true);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: null }), true);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: '' }), true);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: '{}' }), true);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: '{"allowed_users":[]}' }), true);
  // Pre-contract servers sent no visibility and only public events.
  assert.equal(isChronicleEventPublic({ name: 'Old' }), true);
});

test('isChronicleEventPublic: GM-only in either form is not public', () => {
  assert.equal(isChronicleEventPublic({ visibility: 'gm-only' }), false);
  assert.equal(isChronicleEventPublic({ visibility: 'gm_only' }), false);
  assert.equal(isChronicleEventPublic({ visibility: 'dm_only' }), false);
});

test('isChronicleEventPublic: an everyone event restricted to some players is not public', () => {
  assert.equal(isChronicleEventPublic({
    visibility: 'everyone',
    visibility_rules: '{"allowed_users":["u-1"]}',
  }), false);
  assert.equal(isChronicleEventPublic({
    visibility: 'everyone',
    visibility_rules: '{"denied_users":["u-2"]}',
  }), false);
  assert.equal(isChronicleEventPublic({
    visibility: 'everyone',
    visibility_rules: { allowed_users: ['u-1'] },
  }), false);
});

test('isChronicleEventPublic: unknown or unreadable values fail closed', () => {
  assert.equal(isChronicleEventPublic(null), false);
  assert.equal(isChronicleEventPublic({ visibility: 'specific' }), false);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: 'not json' }), false);
  assert.equal(isChronicleEventPublic({ visibility: 'everyone', visibility_rules: '[1]' }), false);
});
