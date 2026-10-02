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

const actorDoc = (over = {}) => {
  const flags = { entityId: 'ent-1', chronicleUpdatedAt: 'V1', ...(over.flags || {}) };
  return {
    id: 'a1', name: 'Hero', type: 'character', items: { contents: [] }, flags,
    system: { attributes: { hp: { value: 12 }, ac: { value: 15 } }, details: { biography: 'b' } },
    getFlag: (_s, k) => flags[k],
    setFlag: async (_s, k, v) => { flags[k] = v; },
    unsetFlag: async (_s, k) => { delete flags[k]; },
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
