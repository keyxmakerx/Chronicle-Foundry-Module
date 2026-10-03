#!/usr/bin/env node
/**
 * Tests for scripts/_stash-probe.mjs: when Stashes is offered.
 *
 * Run: `node --test tools/test-stash-probe.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { probeVerdict, shouldStoreVerdict, showStashButton } from '../scripts/_stash-probe.mjs';

test('probeVerdict: success available, 404 unavailable, anything else unknown', () => {
  assert.equal(probeVerdict({}), true);
  assert.equal(probeVerdict({ error: { status: 404 } }), false);
  assert.equal(probeVerdict({ error: { status: 500 } }), null);
  assert.equal(probeVerdict({ error: { status: 403 } }), null);
  assert.equal(probeVerdict({ error: new Error('network') }), null);
});

test('shouldStoreVerdict: unknown never writes; unchanged never writes', () => {
  assert.equal(shouldStoreVerdict(true, null), false);
  assert.equal(shouldStoreVerdict(false, null), false);
  assert.equal(shouldStoreVerdict(true, true), false);
  assert.equal(shouldStoreVerdict(false, false), false);
  assert.equal(shouldStoreVerdict(false, true), true);
  assert.equal(shouldStoreVerdict(true, false), true);
});

const base = { available: true, isGM: false, isCharacter: true, linked: true, owns: true };

test('showStashButton: player on an owned linked character', () => {
  assert.equal(showStashButton(base), true);
});

test('showStashButton: player without ownership never sees it', () => {
  assert.equal(showStashButton({ ...base, owns: false }), false);
});

test('showStashButton: GM sees it on any linked character', () => {
  assert.equal(showStashButton({ ...base, isGM: true, owns: false }), true);
});

test('showStashButton: hidden when unavailable, unlinked or not a character', () => {
  assert.equal(showStashButton({ ...base, available: false }), false);
  assert.equal(showStashButton({ ...base, linked: false }), false);
  assert.equal(showStashButton({ ...base, isCharacter: false }), false);
  assert.equal(showStashButton({ ...base, available: false, isGM: true }), false);
});
