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
    async createEmbeddedDocuments(_t, list, opts) {
      assert.ok(opts?.chronicleSyncApply);
      // A real create yields to the event loop before the item exists.
      await new Promise((r) => setTimeout(r, 5));
      for (const d of list) {
        const iid = `i${items.size + 1}`;
        const flags = { ...d.flags['chronicle-sync'] };
        const it = {
          id: iid, name: d.name, system: { ...d.system }, flags,
          getFlag: (_s, k) => flags[k],
          setFlag: async (_s, k, v) => { flags[k] = v; a.writes.push(`flag ${iid}`); },
          update: async (c, opts) => {
            assert.ok(opts?.chronicleSyncApply, 'applied writes are marked so their hooks do not push');
            a.writes.push(`update ${iid} ${JSON.stringify(c)}`);
            for (const [k, v] of Object.entries(c)) {
              const [root, ...rest] = k.split('.');
              const key = rest.at(-1);
              if (root !== 'flags') it.system[rest[0]] = v;
              else if (key.startsWith('-=')) delete flags[key.slice(2)];
              else flags[key] = v;
            }
          },
        };
        items.set(iid, it);
        a.writes.push(`create ${d.name}`);
      }
      a.items.contents = [...items.values()];
    },
    async deleteEmbeddedDocuments() {
      assert.fail('sync never deletes a Foundry item');
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

test('a quantity change and a removal arrive; the removed item is unlinked, not deleted', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const rels = { hero: [hasItem(1, 'sword', { quantity: 1 }), hasItem(2, 'rope', { quantity: 1 })] };
  const { is } = make([hero], rels);
  await is.onInitialSync();
  hero.writes.length = 0;
  rels.hero = [hasItem(1, 'sword', { quantity: 4 })];
  await is.onMessage({ type: 'relation.metadata_updated', resourceId: 'hero', payload: hasItem(1, 'sword') });
  assert.deepEqual(hero.writes, ['update i1 {"system.quantity":4}', 'update i2 {"flags.chronicle-sync.-=relationId":null}']);
  assert.equal(hero.items.contents.length, 2, 'the item stays in Foundry');
  hero.writes.length = 0;
  await is.onMessage({ type: 'relation.deleted', resourceId: 'hero', payload: hasItem(2, 'rope') });
  assert.deepEqual(hero.writes, [], 'a repeat writes nothing');
});

test('a copy dragged from another actor keeps its item and the original keeps its relation', async () => {
  const hero = makeActor('hero-actor', 'hero');
  // The copy carries the other character's relation id (5).
  await hero.createEmbeddedDocuments('Item', [{ name: 'sword', system: { quantity: 1 }, flags: { 'chronicle-sync': { relationId: 5, entityId: 'sword' } } }], { chronicleSyncApply: true });
  hero.writes.length = 0;
  const { is } = make([hero], { hero: [] });
  const calls = [];
  is._api.delete = async (...a) => calls.push(['delete', ...a]);
  await is.onMessage({ type: 'relation.created', resourceId: 'hero', payload: hasItem(7, 'shield') });
  assert.deepEqual(hero.writes, ['update i1 {"flags.chronicle-sync.-=relationId":null}']);
  // Deleting the copy afterwards no longer touches the original's relation.
  const copy = hero.items.get('i1');
  await is._handleDeleteItem({ ...copy, parent: hero }, {}, globalThis.game.user.id);
  assert.deepEqual(calls, []);
});

test('a new item that arrives with a relation flag is pushed as its own item', async () => {
  const hero = makeActor('hero-actor', 'hero');
  await hero.createEmbeddedDocuments('Item', [{ name: 'sword', system: { quantity: 1 }, flags: { 'chronicle-sync': { relationId: 5, entityId: 'sword' } } }], { chronicleSyncApply: true });
  hero.writes.length = 0;
  const { is } = make([hero], {});
  const posts = [];
  is._api.post = async (url, body) => { posts.push([url, body.target_entity_id]); return { id: 11 }; };
  globalThis.Actor ??= class {};
  Object.setPrototypeOf(hero, globalThis.Actor.prototype);
  const copy = hero.items.get('i1');
  await is._handleCreateItem(Object.assign(copy, { parent: hero }), {}, globalThis.game.user.id);
  assert.deepEqual(posts, [['/entities/hero/relations', 'sword']]);
  assert.equal(copy.getFlag('chronicle-sync', 'relationId'), 11);
});

test('a Foundry item whose push is in flight is linked, not copied', async () => {
  const hero = makeActor('hero-actor', 'hero');
  await hero.createEmbeddedDocuments('Item', [{ name: 'rope', system: { quantity: 1 }, flags: { 'chronicle-sync': { entityId: 'rope' } } }], { chronicleSyncApply: true });
  hero.writes.length = 0;
  const { is } = make([hero], { hero: [hasItem(9, 'rope', { quantity: 1 })] });
  await is.onMessage({ type: 'relation.created', resourceId: 'hero', payload: hasItem(9, 'rope') });
  assert.deepEqual(hero.writes, ['update i1 {"flags.chronicle-sync.relationId":9}']);
  assert.equal(hero.items.contents.length, 1);
});

test('hooks for writes marked as applied from Chronicle push nothing', async () => {
  const hero = makeActor('hero-actor', 'hero');
  const { is } = make([hero], {});
  const calls = [];
  is._api = { post: async (...a) => calls.push(a), put: async (...a) => calls.push(a), delete: async (...a) => calls.push(a) };
  const it = { name: 'x', parent: hero, system: { quantity: 2 }, getFlag: (_s, k) => ({ relationId: 3, entityId: 'x' })[k] };
  await is._handleUpdateItem(it, { system: { quantity: 2 } }, { chronicleSyncApply: true }, 'gm');
  await is._handleDeleteItem(it, { chronicleSyncApply: true }, 'gm');
  assert.deepEqual(calls, []);
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
