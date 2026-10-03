#!/usr/bin/env node
/**
 * Inventory sync, both sides real: a character's "Has Item" relations in
 * Chronicle and its actor's items in Foundry. Beyond the shared checks, no
 * actor may hold two items for one relation or one Chronicle item.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, closeWorld, settle, recordRequests, waitFor } from './world.mjs';
import { FLAG, writes, scenario } from './scenario.mjs';

const ON = { syncCharacters: true };
const MODULES = { modules: ['journals', 'actors', 'items'] };
const actorFor = (world, id) => world.game.actors.find((a) => a.getFlag(FLAG, 'entityId') === id);
const itemsOf = (actor) => actor.items.contents.filter((i) => i.getFlag(FLAG, 'entityId'));
const itemFor = (actor, entityId) => actor.items.find((i) => i.getFlag(FLAG, 'entityId') === entityId);

async function entityOfType(seed, name, pattern) {
  const types = await seed.chronicle.entityTypes();
  const type = types.find((t) => pattern.test(t.slug) || pattern.test(t.name)) || types[0];
  return seed.chronicle.post('/entities', { name, entity_type_id: type.id, is_private: false });
}

/** A character with a linked actor, and a Chronicle item entity. */
async function heroAndItem(seed, world, itemName) {
  const hero = await entityOfType(seed, `${itemName} Bearer`, /character/i);
  const item = await entityOfType(seed, itemName, /item/i);
  await waitFor(() => actorFor(world, hero.id), 10000, 'actor created');
  await settle();
  return { hero, item, actor: actorFor(world, hero.id) };
}

const give = (seed, hero, item, quantity = 1) => seed.chronicle.post(`/entities/${hero.id}/relations`, {
  target_entity_id: item.id, relation_type: 'Has Item', reverse_relation_type: 'In Inventory Of', metadata: { quantity },
});

function assertNoDuplicateItems(world) {
  for (const actor of world.game.actors.contents) {
    for (const key of ['relationId', 'entityId']) {
      const ids = actor.items.contents.map((i) => i.getFlag(FLAG, key)).filter((v) => v != null).map(String);
      assert.deepEqual(ids.filter((v, i) => ids.indexOf(v) !== i), [], `no two items on "${actor.name}" share a ${key}`);
    }
  }
}

test('inventory changes in Chronicle reach the open world: add, quantity, and a removal unlinks without deleting', () => scenario('chr-items-live', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const { hero, item, actor } = await heroAndItem(seed, world, 'Longsword');
  const rel = await give(seed, hero, item, 1);
  await waitFor(() => itemFor(actor, item.id), 10000, 'item added');
  await seed.chronicle.put(`/relations/${rel.id}`, { metadata: { quantity: 3 } });
  await waitFor(() => itemFor(actor, item.id)?.system?.quantity === 3, 10000, 'quantity updated');
  await seed.chronicle.del(`/relations/${rel.id}`);
  await waitFor(() => itemFor(actor, item.id) && !itemFor(actor, item.id).getFlag(FLAG, 'relationId'), 10000, 'item unlinked');
  assert.equal(itemsOf(actor).length, 1, 'the item stays in Foundry');
  await settle();
  assertNoDuplicateItems(world);
}, { settings: ON }));

test('inventory changed while Foundry was closed arrives on open, and a second open writes nothing', () => scenario('chr-items-offline', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const { hero, item, actor } = await heroAndItem(seed, world, 'Rope');
  const shield = await entityOfType(seed, 'Shield', /item/i);
  const torch = await entityOfType(seed, 'Torch', /item/i);
  const ropeRel = await give(seed, hero, item, 1);
  const torchRel = await give(seed, hero, torch, 2);
  await waitFor(() => itemFor(actor, item.id) && itemFor(actor, torch.id), 10000, 'items added');
  await settle();
  await closeWorld(world);

  await seed.chronicle.put(`/relations/${ropeRel.id}`, { metadata: { quantity: 5 } });
  await seed.chronicle.del(`/relations/${torchRel.id}`);
  await give(seed, hero, shield, 1);

  await openWorld(world, MODULES);
  assert.equal(itemFor(actor, item.id)?.system?.quantity, 5, 'quantity caught up');
  assert.ok(itemFor(actor, torch.id), 'removed item kept in Foundry');
  assert.equal(itemFor(actor, torch.id).getFlag(FLAG, 'relationId'), undefined, 'and unlinked');
  assert.ok(itemFor(actor, shield.id), 'new item added');
  assert.equal(itemsOf(actor).length, 3);
  await closeWorld(world);

  const before = world.log.writes.length;
  const again = await recordRequests(async () => { await openWorld(world, MODULES); });
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'Item').map((w) => `${w.op} ${JSON.stringify(w.change || {})}`), [], 'second open wrote no item');
  assert.deepEqual(writes(again).map((r) => `${r.method} ${r.url}`), [], 'second open wrote nothing in Chronicle');
  assertNoDuplicateItems(world);
}, { settings: ON }));

test('an item added in Foundry becomes one relation, and its echo does not copy it', () => scenario('fvtt-items-add', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const { hero, item, actor } = await heroAndItem(seed, world, 'Lantern');
  await actor.createEmbeddedDocuments('Item', [{ name: 'Lantern', type: 'equipment', system: { quantity: 1 }, flags: { [FLAG]: { entityId: item.id } } }]);
  await waitFor(() => itemFor(actor, item.id)?.getFlag(FLAG, 'relationId'), 10000, 'relation recorded');
  await settle();
  const rels = (await seed.chronicle.get(`/entities/${hero.id}/relations`)).filter((r) => r.relationType === 'Has Item');
  assert.equal(rels.length, 1, 'one relation in Chronicle');
  assert.equal(itemsOf(actor).length, 1, 'one item in Foundry');

  const it = itemFor(actor, item.id);
  const reqs = await recordRequests(async () => {
    await it.update({ 'system.quantity': 4 });
    await settle();
  });
  assert.equal(writes(reqs).length, 1, 'one metadata push');
  const [after] = (await seed.chronicle.get(`/entities/${hero.id}/relations`)).filter((r) => r.relationType === 'Has Item');
  assert.equal((typeof after.metadata === 'string' ? JSON.parse(after.metadata) : after.metadata).quantity, 4);
  assert.equal(it.system.quantity, 4);
  await closeWorld(world);

  const before = world.log.writes.length;
  await openWorld(world, MODULES);
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'Item').map((w) => `${w.op} ${JSON.stringify(w.change || {})}`), [], 'own push not re-applied');
  assertNoDuplicateItems(world);
}, { settings: ON }));

test('an item dragged to another character is its own copy: nothing deleted, the original keeps its relation', () => scenario('fvtt-items-drag', async ({ seed, world }) => {
  await openWorld(world, MODULES);
  const { hero, item, actor } = await heroAndItem(seed, world, 'Dagger');
  const other = await entityOfType(seed, 'Dagger Taker', /character/i);
  await waitFor(() => actorFor(world, other.id), 10000, 'second actor created');
  const taker = actorFor(world, other.id);
  const rel = await give(seed, hero, item, 1);
  await waitFor(() => itemFor(actor, item.id)?.getFlag(FLAG, 'relationId'), 10000, 'item added');
  await settle();

  // Foundry's drag copies the item's data, flags included.
  await taker.createEmbeddedDocuments('Item', [itemFor(actor, item.id).toObject()]);
  await waitFor(() => itemFor(taker, item.id)?.getFlag(FLAG, 'relationId'), 10000, 'copy got its own relation');
  await settle();
  const copyRel = itemFor(taker, item.id).getFlag(FLAG, 'relationId');
  assert.notEqual(String(copyRel), String(rel.id), 'the copy does not reuse the original relation');
  assert.equal(String(itemFor(actor, item.id).getFlag(FLAG, 'relationId')), String(rel.id), 'original untouched');
  const takerRels = (await seed.chronicle.get(`/entities/${other.id}/relations`)).filter((r) => r.relationType === 'Has Item');
  assert.equal(takerRels.length, 1, 'one relation for the new owner');

  await closeWorld(world);
  const before = world.log.writes.length;
  await openWorld(world, MODULES);
  assert.deepEqual(world.log.writes.slice(before).filter((w) => w.type === 'Item' && w.op === 'delete'), [], 'nothing deleted on reopen');
  assert.equal(itemsOf(actor).length, 1);
  assert.equal(itemsOf(taker).length, 1);
  assertNoDuplicateItems(world);
}, { settings: ON }));
