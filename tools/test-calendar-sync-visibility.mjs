#!/usr/bin/env node
/**
 * Unit tests for the wire-visibility helpers in `scripts/calendar-sync.mjs`.
 *
 * Pins the FM-CAL-EDITOR-PR2 carry-in fix A: Foundry must emit kebab
 * `'gm-only'` on the wire, not the storage-side underscore `'gm_only'`
 * that PR 1's calendar-sync was using by mistake.
 *
 * The wire contract lives at:
 *   cordinator/decisions/2026-05-17-calendar-sync-wire-contract.md
 *
 * Chronicle PR #316's translation layer rescued the drift today (since
 * Chronicle stores `gm_only` and translates both ways), but the wire
 * value is the canonical contract and this test pins it.
 *
 * Run: `node --test tools/test-calendar-sync-visibility.mjs`
 *
 * No mocking framework — uses Node's built-in `node:test` (Node ≥ 18).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub Foundry globals that calendar-sync.mjs transitively imports
// (calendar-sync imports settings.mjs → imports update-info.mjs +
// sync-calendar.mjs, which both reference `foundry.applications.api`
// at module top level). The pure helpers we're testing don't touch
// any of these — the stubs only need to satisfy import-time references.
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
  chronicleVisibilityFromCalendariaNote,
  isWireVisibilityGmOnly,
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
// chronicleVisibilityFromCalendariaNote — emission (Foundry → Chronicle)
// ---------------------------------------------------------------------

test('emit: gmOnly:true note → wire "gm-only" (kebab)', () => {
  const v = chronicleVisibilityFromCalendariaNote({ gmOnly: true });
  assert.equal(v, 'gm-only');
  // Negative pin: the underscore form must NEVER be emitted.
  assert.notEqual(v, 'gm_only');
});

test('emit: gmOnly:false note → wire "everyone"', () => {
  assert.equal(chronicleVisibilityFromCalendariaNote({ gmOnly: false }), 'everyone');
});

test('emit: visibility:"hidden" note → wire "gm-only"', () => {
  const v = chronicleVisibilityFromCalendariaNote({ visibility: 'hidden' });
  assert.equal(v, 'gm-only');
});

test('emit: visibility:"secret" note → wire "gm-only"', () => {
  const v = chronicleVisibilityFromCalendariaNote({ visibility: 'secret' });
  assert.equal(v, 'gm-only');
});

test('emit: visibility:"visible" note → wire "everyone"', () => {
  assert.equal(chronicleVisibilityFromCalendariaNote({ visibility: 'visible' }), 'everyone');
});

test('emit: gmOnly takes precedence over visibility', () => {
  // gmOnly:false should override visibility:'hidden' (the operator
  // explicitly set gmOnly).
  assert.equal(
    chronicleVisibilityFromCalendariaNote({ gmOnly: false, visibility: 'hidden' }),
    'everyone',
  );
  assert.equal(
    chronicleVisibilityFromCalendariaNote({ gmOnly: true, visibility: 'visible' }),
    'gm-only',
  );
});

test('emit: flagData-nested visibility surfaces', () => {
  assert.equal(
    chronicleVisibilityFromCalendariaNote({ flagData: { visibility: 'hidden' } }),
    'gm-only',
  );
});

test('emit: null / non-object / empty defaults to "everyone"', () => {
  assert.equal(chronicleVisibilityFromCalendariaNote(null), 'everyone');
  assert.equal(chronicleVisibilityFromCalendariaNote(undefined), 'everyone');
  assert.equal(chronicleVisibilityFromCalendariaNote('string'), 'everyone');
  assert.equal(chronicleVisibilityFromCalendariaNote({}), 'everyone');
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
// Regression: full Foundry → Chronicle event shape never carries underscore
// ---------------------------------------------------------------------

test('regression: a GM-only note round-trips through wire helpers without underscore', () => {
  // Mimics the shape `_calendariaNoteToChronicleEvent` would produce
  // for a GM-only note. The actual private method instantiates the class
  // (which needs a richer environment); the wire-emit helper is the
  // testable seam.
  const noteData = { name: 'Secret Meeting', gmOnly: true, visibility: 'hidden' };
  const wireVisibility = chronicleVisibilityFromCalendariaNote(noteData);

  // Build the same shape `_calendariaNoteToChronicleEvent` emits.
  const wireEvent = {
    name: noteData.name,
    visibility: wireVisibility,
    // Other fields elided.
  };

  // The full wire payload must contain "gm-only" and must NOT contain
  // the underscore form anywhere.
  const serialized = JSON.stringify(wireEvent);
  assert.ok(serialized.includes('"gm-only"'),
    `expected kebab "gm-only" in wire payload; got ${serialized}`);
  assert.ok(!serialized.includes('"gm_only"'),
    `wire payload must never contain underscore "gm_only"; got ${serialized}`);
});
