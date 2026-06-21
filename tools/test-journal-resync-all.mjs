#!/usr/bin/env node
/**
 * Tests for JournalSync.resyncAll.
 *
 * Covers:
 *   - Updates existing journals (calls _onEntityUpdated path).
 *   - Creates journals for entities without one (calls _createJournalFromEntity path).
 *   - Honors skip routing: excludes excluded entities, entities handled by ActorSync,
 *     and tolerates entities with no id.
 *   - Handles paginated fetch (stops after page returns < 100 results).
 *   - Returns correct {updated, created, skipped, errors} summary.
 *   - Fires verbose ui.notifications when verbose=true, quiet when verbose=false.
 *   - Early-exits when not GM, API absent, or syncJournals disabled.
 *   - Tolerates per-entity fetch failures gracefully (errors count up, doesn't abort).
 *
 * Pure-function tested — no Foundry runtime. Node's built-in `node:test`.
 *
 * Run: `node --test tools/test-journal-resync-all.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Foundry global stubs
// ---------------------------------------------------------------------------

globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};

const settingsStore = {
  syncJournals: true,
  syncExclusions: '{"excludedTypes":[],"excludedEntities":[]}',
  dmOnlyHidden: true,
  defaultOwnership: 2,
  syncPermissions: true,
  userMappings: '{}',
  skipIncomingSanitization: false,
  apiUrl: 'http://chronicle.test',
};

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
  },
};
globalThis.game = {
  settings: {
    get: (_mod, key) => settingsStore[key],
    set: (_mod, key, val) => { settingsStore[key] = val; },
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { isGM: true },
  journal: { contents: [], find: () => null, get: () => null },
  users: { get: () => null, contents: [] },
  folders: { find: () => null },
  actors: { contents: [] },
};
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {} };
const notifications = { warns: [], infos: [], errors: [] };
globalThis.ui = {
  notifications: {
    warn: (m) => notifications.warns.push(m),
    info: (m) => notifications.infos.push(m),
    error: (m) => notifications.errors.push(m),
  },
};

// Minimal Foundry document stubs used by _createJournalFromEntity.
globalThis.JournalEntry = { create: async () => null };
globalThis.Folder = { create: async () => ({ id: 'folder-1' }) };

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

const { JournalSync } = await import('../scripts/journal-sync.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal JournalSync instance with injectable stubs.
 * @param {object} opts
 * @param {object[]} opts.apiEntities      - Entities returned by paginated GET /entities.
 * @param {Map}     [opts.journalByEntityId] - Map<entityId, journal> — existing journals.
 * @param {string[]} [opts.actorEntityIds]  - Entity ids that ActorSync handles.
 * @param {string[]} [opts.excludedIds]     - Entity ids excluded via settings.
 */
function makeSync({
  apiEntities = [],
  journalByEntityId = new Map(),
  actorEntityIds = [],
  excludedIds = [],
} = {}) {
  const js = new JournalSync();

  // Stub API: page 1 returns apiEntities, page 2+ returns [].
  js._api = {
    get: async (path) => {
      if (path.startsWith('/entities?')) {
        const url = new URL('http://x' + path);
        const page = Number(url.searchParams.get('page') || 1);
        // Each entity also needs to be fetchable by id.
        if (page === 1) return apiEntities;
        return [];
      }
      // Single-entity fetch: /entities/:id
      const m = path.match(/^\/entities\/(.+)$/);
      if (m) {
        return apiEntities.find((e) => e.id === m[1]) || null;
      }
      return null;
    },
  };

  // Wire _isExcluded to the excludedIds list.
  const origExcluded = js._isExcluded.bind(js);
  js._isExcluded = (entity) => {
    if (excludedIds.includes(entity.id)) return true;
    return origExcluded(entity);
  };

  // Wire _isHandledByActorSync using the provided set.
  js._isHandledByActorSync = (entity) => actorEntityIds.includes(entity.id);

  // Wire game.journal.find to look up by flag.
  globalThis.game.journal = {
    contents: [...journalByEntityId.values()],
    find: (fn) => {
      for (const j of journalByEntityId.values()) {
        if (fn(j)) return j;
      }
      return null;
    },
  };

  // Track which update / create calls were made.
  const calls = { updated: [], created: [] };

  js._onEntityUpdated = async (entity) => {
    calls.updated.push(entity.id);
  };
  js._createJournalFromEntity = async (entity) => {
    calls.created.push(entity.id);
    return { id: `foundry-${entity.id}` };
  };

  // Stub _syncManager (used inside _createJournalFromEntity in the real code,
  // but that's overridden above, so a minimal stub is fine).
  js._syncManager = { ensureMapping: async () => {} };

  return { js, calls };
}

/** Build a minimal journal stub. */
function makeJournal(entityId) {
  return {
    id: `journal-${entityId}`,
    getFlag: (scope, key) => {
      if (key === 'entityId') return entityId;
      return null;
    },
  };
}

/** Reset notification capture between tests. */
function clearNotifications() {
  notifications.warns.length = 0;
  notifications.infos.length = 0;
  notifications.errors.length = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('resyncAll: updates existing journals and creates missing ones', async () => {
  clearNotifications();
  const existingId = 'ent-1';
  const newId = 'ent-2';
  const journalByEntityId = new Map([[existingId, makeJournal(existingId)]]);

  const { js, calls } = makeSync({
    apiEntities: [
      { id: existingId, name: 'Existing' },
      { id: newId,      name: 'New' },
    ],
    journalByEntityId,
  });

  const result = await js.resyncAll({ verbose: false });

  assert.deepEqual(calls.updated, [existingId], 'existing entity is updated');
  assert.deepEqual(calls.created, [newId],      'new entity is created');
  assert.equal(result.updated, 1);
  assert.equal(result.created, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors, 0);
});

test('resyncAll: skips entities handled by ActorSync', async () => {
  clearNotifications();
  const { js, calls } = makeSync({
    apiEntities: [
      { id: 'char-1', name: 'PC' },
      { id: 'loc-1',  name: 'Location' },
    ],
    actorEntityIds: ['char-1'],
  });

  const result = await js.resyncAll({ verbose: false });

  assert.ok(!calls.created.includes('char-1'), 'character entity skipped');
  assert.ok(calls.created.includes('loc-1'),   'non-character entity created');
  assert.equal(result.skipped, 1);
  assert.equal(result.created, 1);
});

test('resyncAll: skips excluded entities', async () => {
  clearNotifications();
  const { js, calls } = makeSync({
    apiEntities: [
      { id: 'hidden', name: 'Excluded' },
      { id: 'vis',    name: 'Visible' },
    ],
    excludedIds: ['hidden'],
  });

  const result = await js.resyncAll({ verbose: false });

  assert.ok(!calls.created.includes('hidden'), 'excluded entity skipped');
  assert.ok(calls.created.includes('vis'),     'non-excluded entity processed');
  assert.equal(result.skipped, 1);
});

test('resyncAll: skips entities with no id', async () => {
  clearNotifications();
  const { js, calls } = makeSync({
    apiEntities: [
      { name: 'No ID' },
      { id: 'good', name: 'Good' },
    ],
  });

  const result = await js.resyncAll({ verbose: false });

  assert.equal(calls.created.length, 1);
  assert.equal(result.skipped, 1);
});

test('resyncAll: per-entity error counted, does not abort remaining entities', async () => {
  clearNotifications();
  const { js, calls } = makeSync({
    apiEntities: [
      { id: 'boom', name: 'Fails' },
      { id: 'ok',   name: 'Ok' },
    ],
  });

  // Make the first create throw.
  let firstCall = true;
  const origCreate = js._createJournalFromEntity;
  js._createJournalFromEntity = async (entity) => {
    if (entity.id === 'boom') throw new Error('Network failure');
    return origCreate(entity);
  };

  const result = await js.resyncAll({ verbose: false });

  assert.equal(result.errors, 1);
  assert.equal(result.created, 1);
  assert.ok(calls.created.includes('ok'), 'second entity still processed after first error');
});

test('resyncAll: fires ui.notifications when verbose=true', async () => {
  clearNotifications();
  const { js } = makeSync({
    apiEntities: [{ id: 'e1', name: 'E1' }],
  });

  await js.resyncAll({ verbose: true });

  // Should have at least one info notification (progress or summary).
  assert.ok(notifications.infos.length >= 1, 'verbose mode fires at least one info notification');
});

test('resyncAll: no notifications when verbose=false', async () => {
  clearNotifications();
  const { js } = makeSync({
    apiEntities: [{ id: 'e1', name: 'E1' }],
  });

  await js.resyncAll({ verbose: false });

  assert.equal(notifications.infos.length, 0, 'no info notifications when not verbose');
  assert.equal(notifications.warns.length, 0, 'no warn notifications when not verbose');
  assert.equal(notifications.errors.length, 0, 'no error notifications when not verbose');
});

test('resyncAll: early-exit when not GM', async () => {
  clearNotifications();
  const origIsGM = game.user.isGM;
  game.user.isGM = false;

  const { js, calls } = makeSync({
    apiEntities: [{ id: 'e1', name: 'E1' }],
  });

  const result = await js.resyncAll({ verbose: false });

  assert.equal(result.updated, 0);
  assert.equal(result.created, 0);
  assert.equal(calls.created.length, 0, 'no creates when not GM');

  game.user.isGM = origIsGM;
});

test('resyncAll: early-exit when syncJournals is disabled', async () => {
  clearNotifications();
  const orig = settingsStore.syncJournals;
  settingsStore.syncJournals = false;

  const { js, calls } = makeSync({
    apiEntities: [{ id: 'e1', name: 'E1' }],
  });

  const result = await js.resyncAll({ verbose: false });

  assert.equal(result.created, 0);
  assert.equal(calls.created.length, 0, 'no creates when sync disabled');

  settingsStore.syncJournals = orig;
});

test('resyncAll: early-exit when api is null', async () => {
  clearNotifications();
  const { js, calls } = makeSync({
    apiEntities: [{ id: 'e1', name: 'E1' }],
  });
  js._api = null;

  const result = await js.resyncAll({ verbose: false });

  assert.equal(result.created, 0);
  assert.equal(calls.created.length, 0, 'no creates when api is null');
});

test('resyncAll: handles API fetch error, surfaces error notification', async () => {
  clearNotifications();
  const { js } = makeSync({ apiEntities: [] });
  js._api.get = async () => { throw Object.assign(new Error('Network error'), { status: 503 }); };

  const result = await js.resyncAll({ verbose: true });

  assert.equal(result.errors, 1);
  assert.ok(notifications.errors.length >= 1, 'error notification fired on fetch failure');
});

test('resyncAll: handles paginated fetch across multiple pages', async () => {
  clearNotifications();
  // Simulate 150 entities: page 1 returns 100, page 2 returns 50.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, name: `E${i}` }));
  const page2 = Array.from({ length: 50  }, (_, i) => ({ id: `e${i + 100}`, name: `E${i + 100}` }));

  const { js, calls } = makeSync({ apiEntities: [] });
  js._api.get = async (path) => {
    if (path.startsWith('/entities?')) {
      const url = new URL('http://x' + path);
      const page = Number(url.searchParams.get('page') || 1);
      if (page === 1) return page1;
      if (page === 2) return page2;
      return [];
    }
    return null;
  };

  const result = await js.resyncAll({ verbose: false });

  assert.equal(calls.created.length, 150, 'all 150 entities processed across two pages');
  assert.equal(result.created, 150);
});
