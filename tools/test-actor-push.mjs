#!/usr/bin/env node
/**
 * Actor edits push only the mapped fields they changed, laid over the
 * entity's current field set so Chronicle-only fields survive on any server, renames carry the entity's new
 * version forward instead of 409ing, and bursts collapse per actor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';
import { mergeChanges, changeTouchesPath, touchedScalarKeys } from '../scripts/_actor-field-diff.mjs';
import { createGenericAdapter } from '../scripts/adapters/generic-adapter.mjs';

const { ActorSync } = await import('../scripts/actor-sync.mjs');
const { ConflictError } = await import('../scripts/api-client.mjs');

const FIELD_DEFS = { fields: [
  { key: 'hp', foundry_path: 'system.attributes.hp.value', type: 'number' },
  { key: 'ac', foundry_path: 'system.attributes.ac.value', type: 'number' },
  { key: 'bio', foundry_path: 'system.details.biography', type: 'string' },
  { key: 'inventory', foundry_collection: 'items', type: 'json' },
] };

/** What Foundry does with an update's flag keys: set them, or remove a `-=` one. */
function applyFlags(flags, data) {
  for (const [k, v] of Object.entries(data || {})) {
    const m = k.match(/^flags\.chronicle-sync\.(-=)?(.+)$/);
    if (!m) continue;
    if (m[1]) delete flags[m[2]]; else flags[m[2]] = v;
  }
}

const actorDoc = (over = {}) => {
  const flags = { entityId: 'ent-1', chronicleUpdatedAt: 'V1', ...(over.flags || {}) };
  return {
    id: 'a1', name: 'Hero', type: 'character', items: { contents: [] }, flags, folder: { id: 'sorted' },
    system: { attributes: { hp: { value: 12 }, ac: { value: 15 } }, details: { biography: 'b' } },
    getFlag: (_s, k) => flags[k],
    setFlag: async (_s, k, v) => { flags[k] = v; },
    unsetFlag: async (_s, k) => { delete flags[k]; },
    update: async (d) => { applyFlags(flags, d); },
    ...over,
  };
};

test('changeTouchesPath: exact, replaced-parent and descendant changes count; others do not', () => {
  const change = { system: { attributes: { hp: { value: 5 } } } };
  assert.equal(changeTouchesPath(change, 'system.attributes.hp.value'), true);
  assert.equal(changeTouchesPath({ system: { attributes: { hp: 5 } } }, 'system.attributes.hp.value'), true);
  assert.equal(changeTouchesPath(change, 'system.attributes.hp'), true);
  assert.equal(changeTouchesPath(change, 'system.attributes.ac.value'), false);
  assert.equal(changeTouchesPath({ system: { attributes: { '-=hp': null } } }, 'system.attributes.hp.value'), true, 'a deleted parent changes the path');
  assert.equal(changeTouchesPath({ system: { attributes: { '-=hp': null } } }, 'system.attributes.hp'), true);
});

test('mergeChanges deep-merges a burst, later values winning', () => {
  const m = mergeChanges({ system: { a: { x: 1 } }, name: 'A' }, { system: { a: { y: 2 }, b: 3 }, name: 'B' });
  assert.deepEqual(m, { system: { a: { x: 1, y: 2 }, b: 3 }, name: 'B' });
  assert.deepEqual(mergeChanges(undefined, { q: 1 }), { q: 1 });
});

test('adapter sends only the changed scalar fields, plus collections, and null when none changed', async () => {
  const adapter = await createGenericAdapter({ get: async () => FIELD_DEFS }, 'dnd5e');
  const actor = actorDoc();
  const out = adapter.toChronicleFieldsChanged(actor, { system: { attributes: { hp: { value: 12 } } } });
  assert.deepEqual(Object.keys(out).sort(), ['hp', 'inventory']);
  assert.equal(adapter.toChronicleFieldsChanged(actor, { system: { unmapped: 1 } }), null);
  assert.deepEqual(touchedScalarKeys({ system: { details: { biography: 'x' } } }, [{ key: 'bio', foundry_path: 'system.details.biography' }]), ['bio']);
});

async function harness() {
  const adapter = await createGenericAdapter({ get: async () => FIELD_DEFS }, 'dnd5e');
  const sync = new ActorSync();
  sync._adapter = adapter;
  const calls = [];
  let version = 1;
  sync._api = {
    get: async (p) => { calls.push(['GET', p]); return { id: 'ent-1', updated_at: `V${version}` }; },
    put: async (p, body) => { calls.push(['PUT', p, body]); version += 1; return p.endsWith('/fields') ? { status: 'ok' } : { updated_at: `V${version}` }; },
    post: async () => ({}),
  };
  return { sync, calls };
}

test('a field edit PUTs only that field to /fields and re-reads the version', async () => {
  const { sync, calls } = await harness();
  const actor = actorDoc();
  await sync._handleUpdateActor(actor, { system: { attributes: { hp: { value: 9 } } } }, {}, 'gm');
  assert.deepEqual(calls, [], 'debounced, nothing yet');
  sync._actorPushDebouncer.flush('a1');
  await new Promise((r) => setImmediate(r));
  const put = calls.find((c) => c[0] === 'PUT');
  assert.equal(put[1], '/entities/ent-1/fields');
  assert.deepEqual(Object.keys(put[2].fields_data).sort(), ['hp', 'inventory']);
  assert.ok(!('ac' in put[2].fields_data) && !('bio' in put[2].fields_data));
  assert.equal(actor.flags.chronicleUpdatedAt, 'V2', 'new version carried forward');
});

test('a field edit keeps Chronicle-only fields even on a server that replaces the whole set', async () => {
  const { sync, calls } = await harness();
  sync._api.get = async (p) => { calls.push(['GET', p]); return { id: 'ent-1', updated_at: 'V1', fields_data: { hp: 5, notes: 'keep me' } }; };
  await sync._handleUpdateActor(actorDoc(), { system: { attributes: { hp: { value: 9 } } } }, {}, 'gm');
  sync._actorPushDebouncer.flush('a1');
  await new Promise((r) => setImmediate(r));
  const put = calls.find((c) => c[0] === 'PUT');
  assert.equal(put[2].fields_data.notes, 'keep me');
  assert.equal(put[2].fields_data.hp, 12, 'the actor value wins over the stored one');
});

test('when the current fields cannot be read, nothing is pushed', async () => {
  const { sync, calls } = await harness();
  sync._api.get = async () => { throw Object.assign(new Error('down'), { status: 503 }); };
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a);
  try {
    await sync._handleUpdateActor(actorDoc(), { system: { attributes: { hp: { value: 9 } } } }, {}, 'gm');
    sync._actorPushDebouncer.flush('a1');
    await new Promise((r) => setImmediate(r));
  } finally { console.error = orig; }
  assert.equal(calls.filter((c) => c[0] === 'PUT').length, 0);
  assert.equal(errs.length, 1);
});

test('rename then field edit: name PUT uses the stored version, and the next rename does not conflict', async () => {
  const { sync, calls } = await harness();
  const actor = actorDoc({ name: 'Renamed' });
  await sync._handleUpdateActor(actor, { name: 'Renamed', system: { attributes: { hp: { value: 3 } } } }, {}, 'gm');
  sync._actorPushDebouncer.flush('a1');
  await new Promise((r) => setImmediate(r));
  const puts = calls.filter((c) => c[0] === 'PUT');
  assert.equal(puts[0][1], '/entities/ent-1');
  assert.deepEqual(puts[0][2], { name: 'Renamed', expected_updated_at: 'V1' });
  assert.equal(puts[1][1], '/entities/ent-1/fields');
  assert.equal(actor.flags.chronicleUpdatedAt, 'V3', 'refreshed after the fields PUT bumped it');
});

test('a burst of edits to one actor is one push with the merged changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, calls } = await harness();
  const actor = actorDoc();
  await sync._handleUpdateActor(actor, { system: { attributes: { hp: { value: 9 } } } }, {}, 'gm');
  await sync._handleUpdateActor(actor, { system: { attributes: { ac: { value: 16 } } } }, {}, 'gm');
  await sync._handleUpdateActor(actor, { system: { attributes: { hp: { value: 8 } } } }, {}, 'gm');
  t.mock.timers.tick(2100);
  await new Promise((r) => setImmediate(r));
  const fieldPuts = calls.filter((c) => c[0] === 'PUT' && c[1].endsWith('/fields'));
  assert.equal(fieldPuts.length, 1);
  assert.deepEqual(Object.keys(fieldPuts[0][2].fields_data).sort(), ['ac', 'hp', 'inventory']);
});

test('a rename conflict under "Chronicle wins" re-pulls and does not push fields over it', async () => {
  const { sync, calls } = await harness();
  settings.conflictResolution = 'chronicle';
  sync._api.put = async (p, body) => { calls.push(['PUT', p, body]); throw new ConflictError('409'); };
  let repulled = 0;
  sync._updateActorFromEntity = async () => { repulled++; };
  const actor = actorDoc({ name: 'X' });
  await sync._handleUpdateActor(actor, { name: 'X', system: { attributes: { hp: { value: 1 } } } }, {}, 'gm');
  sync._actorPushDebouncer.flush('a1');
  await new Promise((r) => setImmediate(r));
  assert.equal(repulled, 1);
  assert.equal(calls.filter((c) => c[0] === 'PUT' && c[1].endsWith('/fields')).length, 0);
});

test('character lists page past 100 instead of stopping at the first page', async () => {
  const sync = new ActorSync();
  const urls = [];
  sync._api = {
    get: async (p) => {
      urls.push(p);
      const page = Number(new URL('http://x' + p).searchParams.get('page'));
      return page === 1 ? { data: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })) } : { data: [{ id: 'last' }] };
    },
  };
  const all = await sync._walkTypeEntities(7);
  assert.equal(all.length, 101);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /type_id=7/);
});

test('a Chronicle update does not overwrite a field with a local edit still waiting to push', async () => {
  const { sync } = await harness();
  const writes = [];
  const actor = actorDoc({
    update: async (changes) => { writes.push(changes); },
    hidden: false,
  });
  actor.system.attributes.hp.value = 15;
  await sync._handleUpdateActor(actor, { system: { attributes: { hp: { value: 15 } } } }, {}, game.user.id);

  const entity = { id: 'ent-1', updated_at: 'V2', fields_data: { hp: 11, bio: 'new bio' } };
  assert.equal(await sync._updateActorFromEntity(actor, entity), true);
  assert.deepEqual(writes.filter((w) => !Object.keys(w).every((k) => k.startsWith('flags.'))), [{ 'system.details.biography': 'new bio' }]);
  sync._actorPushDebouncer.flushAll?.();
});

test('a Chronicle update does not overwrite a field whose push is still in flight, and does once it has landed', async () => {
  const { sync } = await harness();
  const writes = [];
  const actor = actorDoc({ update: async (changes) => { writes.push(changes); }, hidden: false });
  let land;
  sync._api.put = (p) => new Promise((r) => { land = () => r(p.endsWith('/fields') ? { status: 'ok' } : { updated_at: 'V2' }); });
  await sync._handleUpdateActor(actor, { system: { attributes: { hp: { value: 15 } } } }, {}, game.user.id);
  sync._actorPushDebouncer.flush('a1');
  await new Promise((r) => setImmediate(r));
  assert.ok(land, 'the fields push is in flight');

  const data = (w) => w.filter((c) => !Object.keys(c).every((k) => k.startsWith('flags.')));
  await sync._updateActorFromEntity(actor, { id: 'ent-1', updated_at: 'V1', fields_data: { hp: 11 } });
  assert.deepEqual(data(writes), [], 'hp kept while its push is in flight');

  land();
  await new Promise((r) => setImmediate(r));
  await sync._updateActorFromEntity(actor, { id: 'ent-1', updated_at: 'V3', fields_data: { hp: 11 } });
  assert.deepEqual(data(writes), [{ 'system.attributes.hp.value': 11 }], 'a later Chronicle change applies');
});

const HERO_DEFS = { fields: [
  { key: 'hp', foundry_path: 'system.attributes.hp.value', type: 'number' },
  { key: 'class', type: 'string', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true },
  { key: 'complication', type: 'string', foundry_collection: 'items', foundry_item_type: ['complication'], foundry_item_single: true },
] };

async function heroHarness(items) {
  const { sync, calls } = await harness();
  sync._adapter = await createGenericAdapter({ get: async () => HERO_DEFS }, 'drawsteel');
  const actor = actorDoc({ documentName: 'Actor', items: { contents: items } });
  const push = async (fn) => {
    fn(actor);
    sync._actorPushDebouncer.flush('a1');
    await new Promise((r) => setImmediate(r));
    return calls.filter((c) => c[0] === 'PUT' && c[1].endsWith('/fields')).map((c) => c[2].fields_data);
  };
  return { sync, actor, push };
}

test('an item a single-item field reads, added or edited in Foundry, pushes that field with no actor update', async () => {
  const items = [{ name: 'Fury', type: 'class' }];
  const { sync, actor, push } = await heroHarness(items);
  assert.deepEqual(sync._adapter.itemFieldTypes, new Set(['class', 'complication']));
  const comp = { name: 'Amnesia', type: 'complication', parent: actor };
  const sent = await push(() => { items.push(comp); sync._onCreateItem(comp, {}, 'gm'); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].complication, 'Amnesia');
  assert.equal(sent[0].class, 'Fury');
  assert.ok(!('hp' in sent[0]), 'scalars the change did not touch stay out');

  comp.name = 'Advanced Studies';
  const renamed = await push(() => sync._onUpdateItem(comp, { name: 'Advanced Studies' }, {}, 'gm'));
  assert.equal(renamed.at(-1).complication, 'Advanced Studies');
});

test('items sync wrote itself, flag-only edits and unmapped item types push nothing', async () => {
  const items = [];
  const { sync, actor, push } = await heroHarness(items);
  const comp = { name: 'Amnesia', type: 'complication', parent: actor };
  const sword = { name: 'Sword', type: 'equipment', parent: actor };
  const sent = await push(() => {
    items.push(comp, sword);
    sync._onCreateItem(comp, { chronicleSyncApply: true }, 'gm');
    sync._onUpdateItem(comp, { flags: { 'chronicle-sync': { relationId: 'r' } } }, {}, 'gm');
    sync._onCreateItem(sword, {}, 'gm');
  });
  assert.deepEqual(sent, []);
});

test('removing the complication in Foundry clears it in Chronicle; class stays Foundry-led', async () => {
  const items = [{ name: 'Fury', type: 'class' }];
  const { sync, actor, push } = await heroHarness(items);
  const comp = { name: 'Amnesia', type: 'complication', parent: actor };
  const sent = await push(() => sync._onDeleteItem(comp, {}, 'gm'));
  assert.equal(sent.at(-1).complication, '', 'a removal is sent as cleared');
  items.length = 0;
  const cls = await push(() => sync._onDeleteItem({ name: 'Fury', type: 'class', parent: actor }, {}, 'gm'));
  assert.equal(cls.length, sent.length, 'a removed class sends nothing: it is never cleared');

  // Swapped in one burst: removed, then another added. The new one is sent.
  const next = { name: 'Cursed Ring', type: 'complication', parent: actor };
  const swapped = await push(() => {
    sync._onDeleteItem(comp, {}, 'gm');
    items.push(next);
    sync._onCreateItem(next, {}, 'gm');
  });
  assert.equal(swapped.at(-1).complication, 'Cursed Ring');
});

test('a token visibility change is sent only when a GM made it, never a player\'s under the GM\'s key', async () => {
  const { sync } = await harness();
  const posts = [];
  sync._api.post = async (p, body) => { posts.push([p, body]); return {}; };
  const users = globalThis.game.users;
  globalThis.game.users = { get: (id) => (id === 'player-1' ? { id, isGM: false } : null), contents: [], activeGM: { id: 'gm' } };
  try {
    // A player who owns the hero (and can write its page-id flag) hides its token.
    await sync._handleUpdateActor(actorDoc({ flags: { entityId: 'someone-elses-page' } }), { prototypeToken: { hidden: true } }, {}, 'player-1');
  } finally {
    globalThis.game.users = users;
  }
  assert.deepEqual(posts, [], 'a player\'s change hides or reveals no Chronicle page');
  await sync._handleUpdateActor(actorDoc(), { prototypeToken: { hidden: true } }, {}, 'gm');
  assert.deepEqual(posts, [['/entities/ent-1/reveal', { is_private: true }]]);
});

test('a player who rewrites their actor\'s page link gets it unlinked, and nothing is pulled or pushed through it', async () => {
  const { sync, calls } = await harness();
  const users = globalThis.game.users;
  globalThis.game.users = { get: (id) => (id === 'player-1' ? { id, isGM: false } : null), contents: [], activeGM: { id: 'gm' } };
  try {
    const actor = actorDoc({ flags: { entityId: 'someone-elses-page' } });
    await sync._handleUpdateActor(actor, { flags: { 'chronicle-sync': { entityId: 'someone-elses-page' } }, system: { attributes: { hp: { value: 9 } } } }, { chronicleSyncApply: true }, 'player-1');
    assert.equal(actor.getFlag('chronicle-sync', 'entityId'), undefined);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.game.users = users;
  }
});

test('an actor a player creates with a page link arrives unlinked, even with the apply option sent', async () => {
  const { sync, calls } = await harness();
  const users = globalThis.game.users;
  globalThis.game.users = { get: (id) => (id === 'player-1' ? { id, isGM: false } : null), contents: [], activeGM: { id: 'gm' } };
  try {
    const actor = actorDoc({ flags: { entityId: 'someone-elses-page' } });
    await sync._handleCreateActor(actor, { chronicleSyncApply: true }, 'player-1');
    assert.equal(actor.getFlag('chronicle-sync', 'entityId'), undefined);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.game.users = users;
  }
});
