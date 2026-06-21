#!/usr/bin/env node
/**
 * Regression tests for sync-mapping conflict detection + benign-error-log
 * scrubbing.
 *
 * Covers two fixes (see AUDIT-2026-06-21-foundry-errors.md §5):
 *
 *  1. `SyncManager._isMappingConflict` must recognise Chronicle's
 *     mapping-already-exists conflict. The backend returns it as HTTP **409**
 *     (`apperror.NewConflict` → `http.StatusConflict`), which api-client wraps
 *     in a `ConflictError` (`err.status === 409`). The previous matcher only
 *     looked for the string "Chronicle API error 400" and so NEVER absorbed a
 *     real 409 — a concurrent-create conflict would have propagated as an error.
 *
 *  2. `ChronicleAPI.dropLastErrorLogEntry` must accept `status` as a number OR
 *     an array, so `ensureMapping` can scrub a 409 (or legacy 400) conflict and
 *     `findMapping` can scrub a benign lookup 404 — keeping expected/handled
 *     non-OK responses out of the dashboard "Recent sync errors" log.
 *
 * Both methods are pure w.r.t. their arguments / `this` shape, so we exercise
 * them via prototype-call rather than constructing the full classes.
 *
 * Run: `node --test tools/test-sync-mapping-conflict.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Foundry global stubs for the settings.mjs import chain ---
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };

const { SyncManager } = await import('../scripts/sync-manager.mjs');
const { ChronicleAPI, ConflictError } = await import('../scripts/api-client.mjs');

const isConflict = (err) => SyncManager.prototype._isMappingConflict.call({}, err);

// ---------------------------------------------------------------------
// _isMappingConflict — must match the REAL backend shape (409 ConflictError)
// ---------------------------------------------------------------------

test('_isMappingConflict: 409 ConflictError with "already exists" → true', () => {
  const err = new ConflictError({ message: 'sync mapping already exists for this object' });
  assert.equal(err.status, 409, 'precondition: ConflictError is a 409');
  assert.equal(isConflict(err), true);
});

test('_isMappingConflict: legacy generic 400 "already exists" → true (back-compat)', () => {
  const err = new Error('Chronicle API error 400: {"message":"sync mapping already exists for this object"}');
  assert.equal(isConflict(err), true);
});

test('_isMappingConflict: unrelated 409 (optimistic concurrency) → false', () => {
  // Same status, different message — must NOT be absorbed as a mapping conflict.
  const err = new ConflictError({ message: 'Entity was modified by another user' });
  assert.equal(err.status, 409);
  assert.equal(isConflict(err), false);
});

test('_isMappingConflict: unrelated 400 without "already exists" → false', () => {
  const err = new Error('Chronicle API error 400: {"message":"chronicle_id is required"}');
  assert.equal(isConflict(err), false);
});

test('_isMappingConflict: null / undefined / bare object → false', () => {
  assert.equal(isConflict(null), false);
  assert.equal(isConflict(undefined), false);
  assert.equal(isConflict({}), false);
});

// ---------------------------------------------------------------------
// dropLastErrorLogEntry — number OR array status
// ---------------------------------------------------------------------

function makeApiState(entry) {
  return { _errorLog: entry ? [entry] : [], health: { restErrorCount: entry ? 1 : 0 } };
}
const drop = (state, match) => ChronicleAPI.prototype.dropLastErrorLogEntry.call(state, match);

test('dropLastErrorLogEntry: array status matches a 409 conflict entry', () => {
  const state = makeApiState({ status: 409, path: '/sync/mappings', message: '{"message":"sync mapping already exists for this object"}' });
  const removed = drop(state, { status: [400, 409], path: '/sync/mappings', messageIncludes: 'already exists' });
  assert.equal(removed, true);
  assert.equal(state._errorLog.length, 0);
  assert.equal(state.health.restErrorCount, 0, 'restErrorCount rolled back');
});

test('dropLastErrorLogEntry: array status matches a legacy 400 conflict entry', () => {
  const state = makeApiState({ status: 400, path: '/sync/mappings', message: 'already exists' });
  assert.equal(drop(state, { status: [400, 409], path: '/sync/mappings', messageIncludes: 'already exists' }), true);
});

test('dropLastErrorLogEntry: single-number status still works (benign lookup 404)', () => {
  const state = makeApiState({ status: 404, path: '/sync/lookup?chronicle_type=entity&chronicle_id=x', message: '{"message":"sync mapping not found"}' });
  const removed = drop(state, { status: 404, path: /\/sync\/lookup/, messageIncludes: 'sync mapping not found' });
  assert.equal(removed, true);
  assert.equal(state.health.restErrorCount, 0);
});

test('dropLastErrorLogEntry: non-matching status is NOT dropped (real error preserved)', () => {
  const state = makeApiState({ status: 500, path: '/sync/lookup', message: 'internal error' });
  assert.equal(drop(state, { status: [400, 409], path: '/sync/mappings', messageIncludes: 'already exists' }), false);
  assert.equal(state._errorLog.length, 1, 'a genuine 500 must stay in the log');
  assert.equal(state.health.restErrorCount, 1);
});

test('dropLastErrorLogEntry: empty log → false', () => {
  assert.equal(drop(makeApiState(null), { status: 404 }), false);
});
