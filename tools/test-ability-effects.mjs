#!/usr/bin/env node
/**
 * Draw Steel 1.1+ keeps an ability's rules text in `system.effects`, a
 * CollectionField whose live value is a ModelCollection of pseudo-documents,
 * and migrates `system.effect.before/after` away. These pin that the generic
 * adapter turns that collection into a plain list Chronicle can store, and
 * that "Sync Everything Now" pushes with field definitions read again, so a
 * package updated in Chronicle after the world loaded is what gets sent.
 *
 * Run: `node --test tools/test-ability-effects.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';
import {
  createGenericAdapter, getNestedValue, normalizeFoundryValue, extractCollectionField,
} from '../scripts/adapters/generic-adapter.mjs';

const { ActorSync } = await import('../scripts/actor-sync.mjs');

// Foundry's Collection: a Map with `contents` as a getter.
class Collection extends Map {
  get contents() { return Array.from(this.values()); }
}

// Draw Steel's ModelCollection: its bookkeeping (`name`, `_source`,
// `documentClass`) is non-enumerable, while `parent`, `_initialized` and
// `invalidDocumentIds` are plain own properties, which is why a debug walk of
// own keys shows only `system.effects._initialized`. It also has its own
// toObject(), which the adapter must not need.
class ModelCollection extends Collection {
  constructor(source) {
    super();
    Object.defineProperties(this, {
      name: { value: 'effects', writable: false },
      _source: { value: source, writable: false },
      documentClass: { value: class BaseSpecialEffect {}, writable: false },
    });
    this.invalidDocumentIds = new Set();
  }
  initialize(parent) {
    this.parent = parent;
    this._initialized = false;
    for (const data of Object.values(this._source)) super.set(data._id, new PseudoDocument(data, parent));
    this._initialized = true;
  }
  toObject() { return this.map((d) => d.toObject(true)); }
  map(fn) { return this.contents.map(fn); }
}

// A pseudo-document is a DataModel: fields read through getters over
// `_source`, and `parent` points back up the tree (a cycle for a key walk).
class PseudoDocument {
  constructor(source, parent) {
    Object.defineProperty(this, '_source', { value: source });
    this.parent = parent;
  }
  get id() { return this._source._id; }
  get description() { return this._source.description; }
  get before() { return this._source.before ?? false; }
  toObject(source = true) {
    const copy = structuredClone(this._source);
    if (!source) copy.before ??= false;
    return copy;
  }
}

// An ability item as Draw Steel 1.1.2 prepares it: no `system.effect`, the
// text in `system.effects`, the tier ladder in `system.power.effects`.
function abilityItem(name, effectsSource) {
  const system = {
    type: 'main',
    story: '',
    power: { roll: { formula: '@chr', characteristics: new Set(['might']) }, effects: new ModelCollection({}) },
    effects: new ModelCollection(effectsSource),
  };
  system.effects.initialize(system);
  system.power.effects.initialize(system);
  return { id: name, name, type: 'ability', system };
}

const SHADOWSTRIKE = {
  before0000000000: { _id: 'before0000000000', type: 'base', description: '<p>You vanish.</p>', before: true, sort: 0 },
  after00000000000: { _id: 'after00000000000', type: 'base', description: '<p>You turn hidden.</p>', sort: 100000 },
  spend00000000000: { _id: 'spend00000000000', type: 'spend', description: '<p>Deal 2 more.</p>', resource: { value: 1, multiple: false }, sort: 200000 },
};

// The abilities_json projection the Draw Steel package ships from 3.3.0 on
// (the part of it these tests need), and the one before it.
const PROJECTION_NEW = {
  name: 'name',
  type: 'system.type',
  effectBefore: 'system.effect.before',
  effectAfter: 'system.effect.after',
  effects: 'system.effects',
};
const PROJECTION_OLD = {
  name: 'name',
  type: 'system.type',
  effectBefore: 'system.effect.before',
  effectAfter: 'system.effect.after',
};
const abilitiesField = (proj) => ({
  key: 'abilities_json', type: 'string', foundry_collection: 'items',
  foundry_item_type: ['ability'], foundry_item_fields: proj,
});
const defs = (proj) => ({ preset_slug: 'drawsteel-character', foundry_actor_type: 'hero', fields: [abilitiesField(proj)] });

test('system.effects normalizes to a plain list of its blocks, one object each', () => {
  const item = abilityItem('Shadowstrike', SHADOWSTRIKE);
  const out = normalizeFoundryValue(getNestedValue(item, 'system.effects'));
  assert.ok(Array.isArray(out), 'a list, not {} or the collection\'s own keys');
  assert.deepEqual(out.map((e) => [e.type, e.description, e.before]), [
    ['base', '<p>You vanish.</p>', true],
    ['base', '<p>You turn hidden.</p>', false],
    ['spend', '<p>Deal 2 more.</p>', false],
  ]);
  assert.deepEqual(out[2].resource, { value: 1, multiple: false });
  assert.ok(out.every((e) => !('parent' in e)), 'the back-pointer to the item is not carried');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('an ability with no rules text sends an empty list, and the old paths read null', () => {
  const item = abilityItem('Charge', {});
  assert.deepEqual(normalizeFoundryValue(getNestedValue(item, 'system.effects')), []);
  assert.equal(normalizeFoundryValue(getNestedValue(item, 'system.effect.before')), undefined);
});

test('the 3.3.0 projection carries effects; the older one leaves the key out entirely', () => {
  const actor = { items: { contents: [abilityItem('Shadowstrike', SHADOWSTRIKE), abilityItem('Charge', {})] } };
  const fresh = JSON.parse(extractCollectionField(actor, abilitiesField(PROJECTION_NEW)));
  assert.equal(fresh[0].effectBefore, null);
  assert.equal(fresh[0].effectAfter, null);
  assert.equal(fresh[0].effects.length, 3);
  assert.deepEqual(fresh[1].effects, []);

  // What the hero's stored abilities look like when the push used the
  // definitions read before the package update: nulls, and no `effects`.
  const stale = JSON.parse(extractCollectionField(actor, abilitiesField(PROJECTION_OLD)));
  assert.deepEqual(Object.keys(stale[0]).sort(), ['effectAfter', 'effectBefore', 'name', 'type']);
});

/** An ActorSync whose adapter was built from `startDefs`, with a server now answering `serverDefs`. */
async function syncWith(startDefs, serverDefs) {
  settings.detectedSystem = 'drawsteel';
  const flags = { entityId: 'ent-1' };
  const actor = {
    id: 'a1', name: 'Saatraaol', type: 'hero', flags,
    items: { contents: [abilityItem('Shadowstrike', SHADOWSTRIKE)] },
    getFlag: (_s, k) => flags[k],
    update: async () => {},
  };
  globalThis.game.actors = { contents: [actor], get: (id) => (id === actor.id ? actor : undefined) };
  const sync = new ActorSync();
  sync._adapter = await createGenericAdapter({ get: async () => startDefs }, 'drawsteel');
  const puts = [];
  const answer = { defs: serverDefs };
  sync._api = {
    get: async (p) => {
      if (p.endsWith('/character-fields')) {
        if (answer.defs instanceof Error) throw answer.defs;
        return answer.defs;
      }
      return { id: 'ent-1', fields_data: { pronouns: 'she/her' } };
    },
    put: async (p, body) => { puts.push([p, body]); return { status: 'ok' }; },
  };
  return { sync, puts, answer };
}

const sentAbilities = (puts) => JSON.parse(puts.at(-1)[1].fields_data.abilities_json);

test('refreshAdapter picks up definitions the package gained after the world loaded', async () => {
  const { sync, puts } = await syncWith(defs(PROJECTION_OLD), defs(PROJECTION_NEW));

  await sync.repushActor('a1');
  assert.equal('effects' in sentAbilities(puts)[0], false, 'the adapter built at load sends the old shape');

  assert.equal(await sync.refreshAdapter(), true, 'reports that the definitions changed');
  await sync.repushActor('a1');
  const sent = sentAbilities(puts);
  assert.equal(sent[0].effects[0].description, '<p>You vanish.</p>');
  assert.equal(puts.at(-1)[1].fields_data.pronouns, 'she/her', 'Chronicle-only fields still ride along');

  assert.equal(await sync.refreshAdapter(), false, 'unchanged definitions report no change');
});

test('a failed read keeps the adapter in hand, and a module started without one stays off', async () => {
  const { sync, answer } = await syncWith(defs(PROJECTION_NEW), defs(PROJECTION_NEW));
  const held = sync._adapter;
  answer.defs = new Error('offline');
  assert.equal(await sync.refreshAdapter(), false);
  assert.equal(sync._adapter, held);
  answer.defs = { fields: [] };
  assert.equal(await sync.refreshAdapter(), false);
  assert.equal(sync._adapter, held, 'an empty answer does not switch character sync off');

  sync._adapter = null;
  answer.defs = defs(PROJECTION_NEW);
  assert.equal(await sync.refreshAdapter(), false);
  assert.equal(sync._adapter, null, 'its hooks were never registered, so no adapter is slipped in');
});
