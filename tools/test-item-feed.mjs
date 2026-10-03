#!/usr/bin/env node
/**
 * Item sync from Chronicle: the change feed reconciles only characters whose
 * relations changed, a relation event reconciles its character, two events at
 * once never add an item twice, a repeat writes nothing, and a failed
 * catch-up throws so the cursor stays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './_journal-test-env.mjs';

const { ItemSync } = await import('../scripts/item-sync.mjs');

const ch = (seq, resourceId, op = 'updated', type = 'relation') => ({ seq, type, resourceId, op });
const hasItem = (id, target, meta = {}) => ({ id, relationType: 'Has Item', sourceEntityId: 'hero', targetEntityId: target, targetEntityName: target, metadata: meta });

function makeActor(id, entityId) {
  const items = new Map();
  const a = {
    id, name: id, writes: [],
    getFlag: (_s, k) => (k === 'entityId' ? entityId : undefined),
    items: { contents: [], get: (iid) => items.get(iid) || null },
    async createEmbeddedDocuments(_t, list) {
      // A real create yields to the event loop before the item exists.
      await new Promise((r) => setTimeout(r, 5));
      for (const d of list) {
        const iid = `i${items.size + 1}`;
        const flags = { ...d.flags['chronicle-sync'] };
        const it = {
          id: iid, name: d.name, system: { ...d.system }, flags,
          getFlag: (_s, k) => flags[k],
          setFlag: async (_s, k, v) => { flags[k] = v; a.writes.push(`flag ${iid}`); },
          update: async (c) => { a.writes.push(`update ${iid} ${JSON.stringify(c)}`); for (const [k, v] of Object.entries(c)) it.system[k.split('.')[1]] = v; },
        };
        items.set(iid, it);
        a.writes.push(`create ${d.name}`);
      }
      a.items.contents = [...items.values()];
    },
    async deleteEmbeddedDocuments(_t, ids) {
      for (const iid of ids) { items.delete(iid); a.writes.push(`delete ${iid}`); }
      a.items.contents = [...items.values()];
    },
  };
  return a;
}

function make(actors, relationsByEntity, { fail = new Set() } = {}) {
  globalThis.game.actors = { contents: actors, find: (fn) => actors.find(fn), filter: (fn) => actors.filter(fn) };
  const is = new ItemSync();
  const gets = [];
  is._api = {
    get: async (p) => {
      gets.push(p);
      const id = p.split('/')[2];
      if (fail.has(id)) throw Object.assign(new Error('boom'), { status: 500 });
      return relationsByEntity[id] || [];
    },
  };
  return { is, gets };
}

test('delta: only characters whose relations changed are fetched', async () => {
  settings.syncCharacters = true;
  const hero = makeActor('hero-actor', 'hero');
  const other = makeActor('other-actor', 'other');
  const { is, gets } = make([hero, other], { hero: [hasItem(1, 'sword')] });
  await is.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'hero'), ch(2, 'sword', 'created'), ch(3, 'hero', 'updated', 'entity')] } });
  assert.deepEqual(gets, ['/entities/hero/relations']);
  assert.deepEqual(hero.writes, ['create sword']);
});

test('full: every linked character is reconciled, and a second pass writes nothing', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const { is } = make([hero], { hero: [hasItem(1, 'sword', { quantity: 2 })] });
  await is.onInitialSync();
  await is.onInitialSync({ feed: { mode: 'full' } });
  assert.deepEqual(hero.writes, ['create sword']);
});

test('a relation event reconciles its character; two at once add the item once', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const { is } = make([hero], { hero: [hasItem(1, 'sword')] });
  const msg = { type: 'relation.created', resourceId: 'hero', payload: hasItem(1, 'sword') };
  await Promise.all([is.onMessage(msg), is.onMessage(msg)]);
  assert.deepEqual(hero.writes, ['create sword']);
});

test('events for an item row, another relation type or an unlinked entity do nothing', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const { is, gets } = make([hero], { hero: [hasItem(1, 'sword')] });
  await is.onMessage({ type: 'relation.created', resourceId: 'sword', payload: { relationType: 'In Inventory Of', sourceEntityId: 'sword' } });
  await is.onMessage({ type: 'relation.created', resourceId: 'hero', payload: { relationType: 'allied with', sourceEntityId: 'hero' } });
  await is.onMessage({ type: 'entity.updated', resourceId: 'hero', payload: {} });
  assert.deepEqual(gets, []);
});

test('a quantity change and a removal arrive; nothing else is written', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const rels = { hero: [hasItem(1, 'sword', { quantity: 1 }), hasItem(2, 'rope', { quantity: 1 })] };
  const { is } = make([hero], rels);
  await is.onInitialSync();
  hero.writes.length = 0;
  rels.hero = [hasItem(1, 'sword', { quantity: 4 })];
  await is.onMessage({ type: 'relation.metadata_updated', resourceId: 'hero', payload: hasItem(1, 'sword') });
  assert.deepEqual(hero.writes, ['update i1 {"system.quantity":4}', 'delete i2']);
});

test('a failed fetch throws so the cursor stays', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const { is } = make([hero], {}, { fail: new Set(['hero']) });
  await assert.rejects(is.onInitialSync({ feed: { mode: 'delta', changes: [ch(1, 'hero')] } }));
});

test('nothing happens with character sync off', async () => {
  settings.syncCharacters = false;
  const hero = makeActor('hero-actor', 'hero');
  const { is, gets } = make([hero], { hero: [hasItem(1, 'sword')] });
  assert.equal(is.feedActive(), false);
  await is.onInitialSync();
  await is.onMessage({ type: 'relation.created', resourceId: 'hero', payload: hasItem(1, 'sword') });
  assert.deepEqual(gets, []);
  settings.syncCharacters = true;
});
