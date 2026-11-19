#!/usr/bin/env node
/**
 * Chronicle transformation layers as one Active Effect per layer: what an
 * effect carries, that only sync's own effects are ever changed, and that a
 * layered field is never pushed back into the hero's own fields.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import './_journal-test-env.mjs';
import {
  planLayerEffects, layerEffect, effectFieldMap, layeredFieldKeys, storedLayers, EFFECT_MODE, LAYER_FLAG,
} from '../scripts/_layer-effects.mjs';
import { createGenericAdapter } from '../scripts/adapters/generic-adapter.mjs';

const { ActorSync } = await import('../scripts/actor-sync.mjs');

const SCOPE = 'chronicle-sync';

// Draw Steel's mapped fields, as its manifest declares them.
const DEFS = [
  { key: 'ancestry', type: 'string', foundry_collection: 'items', foundry_item_type: ['ancestry'], foundry_item_single: true },
  { key: 'recoveries_max', type: 'number', foundry_path: 'system.recoveries.max' },
  { key: 'stability', type: 'number', foundry_path: 'system.combat.stability', foundry_writable: false },
  { key: 'immunities', type: 'string', foundry_path: 'system.damage.immunities', foundry_writable: false },
  { key: 'weaknesses', type: 'string', foundry_path: 'system.damage.weaknesses', foundry_writable: false },
  { key: 'features_json', type: 'string', foundry_collection: 'items' },
  { key: 'portrait_url', type: 'string', foundry_path: 'prototypeToken.texture.src' },
];

const revenant = (over = {}) => ({
  id: 'L1', name: 'Revenant', source: 'drawsteel:revenant', note: 'Rose <b>again</b>', createdAt: '2026-11-01T00:00:00Z',
  changes: [
    { field: 'ancestry', op: 'set', value: 'Revenant' },
    { field: 'recoveries_max', op: 'add', value: -2 },
    { field: 'immunities', op: 'set', value: { cold: '@level', poison: '@level' }, label: 'Tough But Withered' },
    { field: 'weaknesses', op: 'set', value: { fire: 5 } },
    { field: 'features_json', op: 'append', value: { name: 'Tough But Withered' }, label: 'Tough But Withered' },
    { field: 'features_json', op: 'remove', value: 'Staying Power' },
  ],
  ...over,
});

test('only system paths are effect keys; items and the token are not', () => {
  assert.deepEqual([...effectFieldMap(DEFS).keys()].sort(), ['immunities', 'recoveries_max', 'stability', 'weaknesses']);
});

test('a layer becomes adds, overrides per member, and words for the rest', () => {
  const { data, fieldKeys } = layerEffect(revenant(), effectFieldMap(DEFS), 3);
  assert.equal(data.name, 'Revenant');
  assert.equal(data.transfer, false);
  assert.deepEqual(data.changes, [
    { key: 'system.recoveries.max', mode: EFFECT_MODE.ADD, value: '-2' },
    { key: 'system.damage.immunities.cold', mode: EFFECT_MODE.OVERRIDE, value: '3' },
    { key: 'system.damage.immunities.poison', mode: EFFECT_MODE.OVERRIDE, value: '3' },
    { key: 'system.damage.weaknesses.fire', mode: EFFECT_MODE.OVERRIDE, value: '5' },
  ]);
  assert.deepEqual(fieldKeys.sort(), ['immunities', 'recoveries_max', 'weaknesses']);
  assert.match(data.description, /ancestry becomes Revenant/);
  assert.match(data.description, /Adds Tough But Withered to features/);
  assert.match(data.description, /Sets aside Staying Power from features/);
  assert.match(data.description, /Rose &lt;b&gt;again&lt;\/b&gt;/, 'the note is escaped');
  assert.doesNotMatch(data.description, /<b>/);
});

test('a value that cannot be an effect is described, never sent as a key', () => {
  const layer = { id: 'L', name: 'Odd', changes: [
    { field: 'recoveries_max', op: 'add', value: 'lots' },
    { field: 'stability', op: 'set', value: { 'bad key': 1 } },
    { field: 'portrait_url', op: 'set', value: 'x.png' },
    { field: 'unknown', op: 'add', value: 1 },
  ] };
  const { data, fieldKeys } = layerEffect(layer, effectFieldMap(DEFS), 1);
  assert.deepEqual(data.changes, []);
  assert.deepEqual(fieldKeys, []);
  assert.equal((data.description.match(/<li>/g) || []).length, 4);
});

test('plan: create for a new layer, nothing for an unchanged one, update when the level moves', () => {
  const first = planLayerEffects({ layers: [revenant()], fieldDefs: DEFS, level: 3, existing: [], scope: SCOPE });
  assert.equal(first.create.length, 1);
  assert.deepEqual(first.update, []);
  assert.deepEqual(first.remove, []);
  const flag = first.create[0].flags[SCOPE][LAYER_FLAG];
  assert.equal(flag.id, 'L1');
  assert.deepEqual(flag.fields.sort(), ['immunities', 'recoveries_max', 'weaknesses']);

  const existing = [{ id: 'e1', flag }];
  const again = planLayerEffects({ layers: [revenant()], fieldDefs: DEFS, level: 3, existing, scope: SCOPE });
  assert.deepEqual(again, { create: [], update: [], remove: [] }, 'an unchanged layer writes nothing');

  const levelled = planLayerEffects({ layers: [revenant()], fieldDefs: DEFS, level: 4, existing, scope: SCOPE });
  assert.equal(levelled.update.length, 1);
  assert.equal(levelled.update[0]._id, 'e1');
  assert.equal(levelled.update[0].changes[1].value, '4');
  assert.equal('disabled' in levelled.update[0], false, "a rewrite keeps the GM's on/off choice");
});

test('plan: a layer taken off, and a duplicate, remove only sync-made effects', () => {
  const made = planLayerEffects({ layers: [revenant()], fieldDefs: DEFS, level: 1, existing: [], scope: SCOPE }).create[0];
  const flag = made.flags[SCOPE][LAYER_FLAG];
  const plan = planLayerEffects({
    layers: [], fieldDefs: DEFS, level: 1, scope: SCOPE,
    existing: [{ id: 'e1', flag }, { id: 'e2', flag }],
  });
  assert.deepEqual(plan.remove.sort(), ['e1', 'e2']);
  const dup = planLayerEffects({ layers: [revenant()], fieldDefs: DEFS, level: 1, scope: SCOPE, existing: [{ id: 'e1', flag }, { id: 'e2', flag }] });
  assert.deepEqual(dup.remove, ['e2']);
  assert.deepEqual(dup.create, []);
});

test('stored layers come back oldest first, and layered keys are collected', () => {
  const a = { id: 'x', flag: { fields: ['speed'], layer: { id: 'B', createdAt: '2026-11-02' } } };
  const b = { id: 'y', flag: { fields: ['recoveries_max'], layer: { id: 'A', createdAt: '2026-11-01' } } };
  assert.deepEqual(storedLayers([a, b]).map((l) => l.id), ['A', 'B']);
  assert.deepEqual([...layeredFieldKeys([a, b])].sort(), ['recoveries_max', 'speed']);
});

// ActorSync glue against a fake actor that keeps its effects.
function heroActor() {
  const effects = [];
  let n = 0;
  const effectDoc = (d) => ({ ...d, id: d._id || `fx${++n}`, getFlag: (s, k) => d.flags?.[s]?.[k] });
  return {
    id: 'a1', name: 'Mirela', type: 'hero', items: { contents: [] }, system: { recoveries: { max: 8 } },
    flags: { entityId: 'ent-1' },
    getFlag(_s, k) { return this.flags[k]; },
    effects: { get contents() { return effects; } },
    writes: [],
    async createEmbeddedDocuments(type, docs, opts) {
      this.writes.push(['create', type, opts]);
      for (const d of docs) effects.push(effectDoc(d));
    },
    async updateEmbeddedDocuments(type, docs, opts) {
      this.writes.push(['update', type, opts]);
      for (const d of docs) {
        const i = effects.findIndex((e) => e.id === d._id);
        effects[i] = effectDoc({ ...effects[i], ...d, flags: d.flags });
      }
    },
    async deleteEmbeddedDocuments(type, ids, opts) {
      this.writes.push(['delete', type, opts]);
      for (const id of ids) effects.splice(effects.findIndex((e) => e.id === id), 1);
    },
  };
}

async function harness(layersReply) {
  const adapter = await createGenericAdapter({ get: async () => ({ fields: DEFS, foundry_actor_type: 'hero' }) }, 'drawsteel');
  const sync = new ActorSync();
  sync._adapter = adapter;
  const calls = [];
  sync._api = {
    get: async (p) => {
      calls.push(p);
      const r = typeof layersReply === 'function' ? layersReply() : layersReply;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const actor = heroActor();
  globalThis.game.actors = Object.assign([actor], { contents: [actor] });
  return { sync, actor, calls };
}

test('hero_layers.changed reads the layers and writes one effect, marked as sync', async () => {
  let reply = { layers: [revenant()], canEdit: true };
  const { sync, actor, calls } = await harness(() => reply);
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'ent-1' });
  assert.deepEqual(calls, ['/entities/ent-1/layers']);
  assert.equal(actor.effects.contents.length, 1);
  assert.equal(actor.effects.contents[0].name, 'Revenant');
  assert.equal(actor.writes[0][2].chronicleSync, true);
  assert.equal(actor.writes[0][2].chronicleSyncApply, true);

  // A GM's own effect is never touched; taking the layer off removes ours.
  actor.effects.contents.push({ id: 'gm', name: 'Bless', getFlag: () => undefined });
  reply = { layers: [], canEdit: true };
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'ent-1' });
  assert.deepEqual(actor.effects.contents.map((e) => e.id), ['gm']);
});

test('a page with no linked actor reads nothing', async () => {
  const { sync, calls } = await harness({ layers: [] });
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'someone-else' });
  assert.deepEqual(calls, []);
});

for (const [why, off] of [
  ['a 404', Object.assign(new Error('not found'), { status: 404 })],
  ['the add-on switched off', Object.assign(new Error('off'), { status: 403, code: 'addon_disabled' })],
]) test(`${why} at connect stops the reads; the next message tries again`, async () => {
  let reply = off;
  const { sync, actor, calls } = await harness(() => reply);
  const second = { ...actor, id: 'a2', flags: { entityId: 'ent-2' }, getFlag(_s, k) { return this.flags[k]; } };
  globalThis.game.actors = Object.assign([actor, second], { contents: [actor, second] });
  await sync._syncAllLayers();
  assert.deepEqual(calls, ['/entities/ent-1/layers'], 'one 404 is enough');
  reply = { layers: [revenant()] };
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'ent-1' });
  assert.equal(actor.effects.contents.length, 1);
});

test('a layered field is left out of a push; the others still go', async () => {
  const { sync, actor } = await harness({ layers: [revenant()] });
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'ent-1' });
  const out = sync._withoutLayered(actor, { recoveries_max: 6, stability: 1, immunities: '{}' });
  assert.deepEqual(out, { stability: 1 });
  assert.equal(sync._withoutLayered(actor, null), null);
});

test('a Chronicle copy re-plans from the stored layers with no read', async () => {
  const { sync, actor, calls } = await harness({ layers: [revenant()] });
  await sync.onMessage({ type: 'hero_layers.changed', resourceId: 'ent-1' });
  calls.length = 0;
  await sync._replanLayers(actor, { fields_data: { level: 5 } });
  assert.deepEqual(calls, []);
  const cold = actor.effects.contents[0].changes.find((c) => c.key.endsWith('.cold'));
  assert.equal(cold.value, '5');
});

test('at connect with the feed, only heroes listed under hero_layers are read', async () => {
  const { sync, calls } = await harness({ layers: [] });
  await sync._syncAllLayers([{ type: 'entity', resourceId: 'ent-1', op: 'updated' }]);
  assert.deepEqual(calls, [], 'an entity change is not a layer change');
  await sync._syncAllLayers([{ type: 'hero_layers', resourceId: 'ent-1', op: 'updated' }]);
  assert.deepEqual(calls, ['/entities/ent-1/layers']);
  calls.length = 0;
  await sync._syncAllLayers(null);
  assert.deepEqual(calls, ['/entities/ent-1/layers'], 'without the feed every linked hero is read');
});
