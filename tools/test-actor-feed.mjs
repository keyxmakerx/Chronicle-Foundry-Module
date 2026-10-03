#!/usr/bin/env node
/**
 * Connect-time character catch-up: with the change feed only listed
 * characters with a linked actor are refetched, an actor already at the
 * version is not written, a removed character unlinks its actor (kept), a
 * failure throws so the cursor stays, and a stale copy never rolls an actor
 * back. The full walk skips actors at their version too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';

const { ActorSync } = await import('../scripts/actor-sync.mjs');

const T1 = '2026-10-03T04:00:01Z';
const T2 = '2026-10-03T04:00:02Z';
const ch = (seq, resourceId, op = 'updated') => ({ seq, type: 'entity', resourceId, op });

function actor(id, entityId, version, over = {}) {
  const flags = { entityId, chronicleUpdatedAt: version };
  const a = {
    id, name: id, type: 'character', flags, writes: [],
    getFlag: (_s, k) => flags[k],
    setFlag: async (_s, k, v) => { flags[k] = v; a.writes.push(`flag ${k}`); },
    unsetFlag: async (_s, k) => { delete flags[k]; a.writes.push(`unset ${k}`); },
    update: async (d) => { a.writes.push(`update ${JSON.stringify(d)}`); },
    ...over,
  };
  return a;
}

function make({ actors, entities = {}, fail = new Set(), list = [] }) {
  globalThis.game.actors = { contents: actors, find: (fn) => actors.find(fn), get: (id) => actors.find((a) => a.id === id) };
  const as = new ActorSync();
  const gets = [];
  as._api = {
    get: async (p) => {
      gets.push(p);
      if (p.startsWith('/entities?')) return new URL('http://x' + p).searchParams.get('page') === '1' ? list : [];
      const id = p.split('/').pop();
      if (fail.has(id)) throw Object.assign(new Error('boom'), { status: 500 });
      if (!entities[id]) throw Object.assign(new Error('nf'), { status: 404 });
      return entities[id];
    },
  };
  as._adapter = { actorType: 'character', fromChronicleFields: (e) => ({ 'system.hp': e.fields_data?.hp }) };
  as._characterTypeId = 7;
  as.getSyncIssues = async () => { gets.push('issues-list'); return { issues: [] }; };
  return { as, gets };
}

test('delta: only listed characters with an actor are fetched; at-version actors are not written', async () => {
  settings.syncCharacters = true;
  const same = actor('same', 'e-same', T1);
  const changed = actor('changed', 'e-changed', T1);
  const { as, gets } = make({
    actors: [same, changed],
    entities: {
      'e-same': { id: 'e-same', entity_type_id: 7, updated_at: T1, fields_data: { hp: 1 } },
      'e-changed': { id: 'e-changed', entity_type_id: 7, updated_at: T2, fields_data: { hp: 3 } },
    },
  });
  await as.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e-same'), ch(2, 'e-changed'), ch(3, 'e-nobody')] } });
  assert.deepEqual(gets, ['/entities/e-same', '/entities/e-changed'], 'no list walk, no issue listing, no fetch without an actor');
  assert.deepEqual(same.writes, []);
  assert.ok(changed.writes.some((w) => w.includes('"system.hp":3')));
  assert.equal(changed.flags.chronicleUpdatedAt, T2);
});

test('delta: a deleted or vanished character unlinks its actor and keeps it', async () => {
  const del = actor('del', 'e-del', T1);
  const gone = actor('gone', 'e-gone', T1);
  const { as } = make({ actors: [del, gone] });
  await as.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e-del', 'deleted'), ch(2, 'e-gone')] } });
  assert.equal(del.flags.entityId, undefined);
  assert.equal(gone.flags.entityId, undefined);
});

test('delta: a failed fetch throws so the cursor stays', async () => {
  const a = actor('a', 'e1', T1);
  const { as } = make({ actors: [a], fail: new Set(['e1']) });
  await assert.rejects(as.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'e1')] } }));
});

test('full walk: actors at their version are not written; issues are listed', async () => {
  const a = actor('a', 'e1', T1);
  const { as, gets } = make({ actors: [a], list: [{ id: 'e1', entity_type_id: 7, updated_at: T1 }] });
  await as.onInitialSync();
  assert.deepEqual(a.writes, []);
  assert.ok(gets.includes('issues-list'));
});

test('a copy older than the recorded version is ignored', async () => {
  const a = actor('a', 'e1', T2);
  const { as } = make({ actors: [a] });
  assert.equal(await as._updateActorFromEntity(a, { id: 'e1', updated_at: T1, fields_data: { hp: 9 } }), true);
  assert.deepEqual(a.writes, []);
  assert.equal(a.flags.chronicleUpdatedAt, T2);
});
