#!/usr/bin/env node
/**
 * Deleting a journal within the 2s push debounce window must cancel the
 * pending push, not just issue the delete. Without the cancel, the debounced push fires ~2s later
 * against the now-deleted journal, and its failure path queues a retry
 * that can resurrect the deleted entity's data on Chronicle.
 *
 * Run: `node --test tools/test-journal-delete-cancels-push.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Foundry global stubs (must exist before importing journal-sync.mjs) ---

globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};

globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: {
    get: () => undefined,
    set: () => {},
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm-user' },
  users: { get: () => null, contents: [] },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.ui = globalThis.ui || { notifications: { warn: () => {}, error: () => {}, info: () => {} } };

const { JournalSync } = await import('../scripts/journal-sync.mjs');

test('deleting a journal cancels its pending debounced push', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const js = new JournalSync();
  const putCalls = [];
  js._api = {
    delete: async () => {},
    put: async (...args) => { putCalls.push(args); return {}; },
    queueForRetry: () => {},
  };

  const journal = {
    id: 'journal-1',
    name: 'Doomed Journal',
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    getFlag: (_scope, key) => (key === 'entityId' ? 'entity-1' : undefined),
    setFlag: async () => {},
  };

  // Simulate an edit that schedules a debounced push...
  js._journalPushDebouncer.schedule(journal.id, journal, 'entity-1');

  // ...then a delete of the same journal within the debounce window.
  await js._handleDeleteJournal(journal, {}, 'gm-user');

  // The debounced push must never fire against the deleted journal.
  t.mock.timers.tick(3000);
  await Promise.resolve();
  assert.equal(putCalls.length, 0, 'no PUT must be sent for a journal deleted within the debounce window');
});
