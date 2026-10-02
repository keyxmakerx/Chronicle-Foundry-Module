#!/usr/bin/env node
/**
 * JournalSync applies Chronicle changes per entity, in order, and ignores
 * only its own writes: a burst of three events on one entity lands in
 * order, a GM edit during an apply still pushes, one entity yields one
 * journal, and an unsent local edit is not overwritten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, notes, makeJournal, installJournals } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

const tick = () => new Promise((r) => setImmediate(r));

function make() {
  const js = new JournalSync();
  js._api = { get: async (p) => ({ id: p.split('/').pop(), name: 'Full', updated_at: 'U' }) };
  js._syncManager = { ensureMapping: async () => {}, _modules: [] };
  js._isHandledByActorSync = () => false;
  js._buildOwnership = async () => ({ default: 2 });
  js._syncPagesToJournal = async () => {};
  js._syncPlayerNotesPage = async () => {};
  return js;
}

test('a burst of created, updated, updated applies in order and makes one journal', async () => {
  const list = installJournals([]);
  const js = make();
  const order = [];
  js._createJournalLocked = async (entity) => {
    order.push(`create:${entity.name}`);
    await tick(); await tick();
    const j = makeJournal({ id: 'j1', flags: { entityId: entity.id } });
    list.push(j);
    return j;
  };
  const applied = [];
  const origApply = js._applyEntityUpdated.bind(js);
  js._applyEntityUpdated = async (e) => { applied.push(e.name); return origApply(e); };

  await Promise.all([
    js._onEntityCreated({ id: 'e1', name: 'v1' }),
    js._onEntityUpdated({ id: 'e1', name: 'v2', updated_at: 'U2' }),
    js._onEntityUpdated({ id: 'e1', name: 'v3', updated_at: 'U3' }),
  ]);

  assert.deepEqual(order, ['create:Full'], 'exactly one create');
  assert.deepEqual(applied, ['v2', 'v3'], 'updates apply in arrival order');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'v3');
  assert.equal(list[0].flags.chronicleUpdatedAt, 'U3');
});

test('an update for an unknown entity racing a create still yields one journal', async () => {
  const list = installJournals([]);
  const js = make();
  let creates = 0;
  js._createJournalLocked = async (entity) => {
    if (js._findJournal(entity.id)) return;
    creates++;
    await tick();
    list.push(makeJournal({ flags: { entityId: entity.id } }));
  };
  await Promise.all([
    js._onEntityUpdated({ id: 'e2', name: 'a' }),
    js._onEntityCreated({ id: 'e2', name: 'a' }),
  ]);
  assert.equal(creates, 1);
});

test('sync writes carry the marker so the hooks drop only those echoes', async () => {
  const j = makeJournal({ id: 'j1', flags: { entityId: 'e1' } });
  installJournals([j]);
  const js = make();
  await js._onEntityUpdated({ id: 'e1', name: 'Renamed', updated_at: 'U9' });
  assert.ok(j.updates.length > 0);
  assert.ok(j.updates.every((u) => u.options?.chronicleSync === true));

  const scheduled = [];
  js._journalPushDebouncer.schedule = (...a) => scheduled.push(a);
  await js._handleUpdateJournal(j, {}, { chronicleSync: true }, 'gm');
  assert.equal(scheduled.length, 0, 'the echo of an applied change is ignored');
});

test('a GM edit while a Chronicle change is being applied is NOT dropped', async () => {
  const j = makeJournal({ id: 'j1', flags: { entityId: 'e1' } });
  installJournals([j]);
  const js = make();
  const scheduled = [];
  js._journalPushDebouncer.schedule = (...a) => scheduled.push(a);
  let release;
  js._buildOwnership = () => new Promise((r) => { release = () => r({ default: 2 }); });

  const applying = js._onEntityUpdated({ id: 'e1', name: 'x', updated_at: 'U2' });
  await tick();
  await js._handleUpdateJournal(j, { name: 'GM typed' }, {}, 'gm');
  assert.equal(scheduled.length, 1, 'edit during the apply is scheduled to push');
  release();
  await applying;
});

test('an incoming update does not overwrite an unsent local edit; the edit is kept and pushed', async () => {
  const j = makeJournal({ id: 'j1', name: 'GM text', flags: { entityId: 'e1', chronicleUpdatedAt: 'U1' } });
  installJournals([j]);
  const js = make();
  notes.warn.length = 0;
  let pushed = 0;
  js._pushJournalUpdate = async () => { pushed++; };
  js._journalPushDebouncer.schedule(j.id, j, 'e1');

  await js._onEntityUpdated({ id: 'e1', name: 'Chronicle text', updated_at: 'U2' });

  assert.equal(j.name, 'GM text', 'local edit untouched');
  assert.equal(j.flags.chronicleUpdatedAt, 'U2', 'expected version moved forward so the push is not a 409');
  assert.equal(notes.warn.length, 0, 'no toast: only the dashboard activity log records it');
  js._journalPushDebouncer.flush(j.id);
  assert.equal(pushed, 1);
});

test('entity.deleted sets the journal aside, never deletes it, and drops its pending push', async () => {
  const j = makeJournal({ id: 'j1', flags: { entityId: 'e1' } });
  j.delete = async () => { throw new Error('must not delete'); };
  installJournals([j]);
  globalThis.game.folders = { find: () => ({ id: 'removed' }), contents: [] };
  const js = make();
  js._journalPushDebouncer.schedule(j.id, j, 'e1');
  await js._onEntityDeleted({ id: 'e1' });
  assert.equal(js._journalPushDebouncer.has(j.id), false);
  assert.equal(j.updates.at(-1).data.folder, 'removed');
  assert.equal(j.updates.at(-1).options.chronicleSync, true);
});
