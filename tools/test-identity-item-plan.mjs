#!/usr/bin/env node
/**
 * The identity-item planner and applier: which of an actor's ancestry,
 * culture, career and kit items Chronicle's pick replaces, and how the
 * replacement is found. No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planIdentityItems, identityFieldDefs } from '../scripts/_identity-item-plan.mjs';
import { findIdentityItem, applyIdentityItem, applyIdentityPlan } from '../scripts/_identity-item-apply.mjs';

const single = (key, type) => ({ key, type: 'string', foundry_collection: 'items', foundry_item_type: [type], foundry_item_single: true });
const DEFS = [
  single('class', 'class'),
  single('subclass', 'subclass'),
  single('ancestry', 'ancestry'),
  single('culture', 'culture'),
  single('career', 'career'),
  single('kit', 'kit'),
  { key: 'level', type: 'number', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true },
  { key: 'heroic_resource_name', type: 'string', foundry_collection: 'items', foundry_item_type: ['kit'], foundry_item_single: true },
  { key: 'abilities_json', type: 'json', foundry_collection: 'items', foundry_item_type: ['ability'] },
  { key: 'multi', type: 'string', foundry_collection: 'items', foundry_item_type: ['a', 'b'], foundry_item_single: true },
  { key: 'hp', type: 'number', foundry_path: 'system.hp' },
];

test('only ancestry, culture, career and kit are eligible', () => {
  assert.deepEqual(identityFieldDefs(DEFS).map((d) => d.key), ['ancestry', 'culture', 'career', 'kit']);
});

test('a differing pick plans a swap that removes the old item of that type only', () => {
  const items = [
    { id: 'a1', name: 'Human', type: 'ancestry' },
    { id: 'c1', name: 'Censor', type: 'class' },
    { id: 'k1', name: 'Shining Armor', type: 'kit' },
  ];
  const plan = planIdentityItems({ items, fieldDefs: DEFS, fieldsData: { ancestry: 'Dwarf', kit: 'Shining Armor' } });
  assert.deepEqual(plan, [{ fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'Dwarf', removeIds: ['a1'] }]);
});

test('same name is a no-op, ignoring case and spaces', () => {
  const items = [{ id: 'a1', name: 'Human', type: 'ancestry' }];
  assert.deepEqual(planIdentityItems({ items, fieldDefs: DEFS, fieldsData: { ancestry: '  hUMAN ' } }), []);
});

test('an empty, missing or non-string value does nothing', () => {
  const items = [{ id: 'a1', name: 'Human', type: 'ancestry' }];
  for (const v of ['', '   ', null, undefined, 7, ['x']]) {
    assert.deepEqual(planIdentityItems({ items, fieldDefs: DEFS, fieldsData: { ancestry: v } }), []);
  }
  assert.deepEqual(planIdentityItems({ items, fieldDefs: DEFS, fieldsData: null }), []);
});

test('an actor with no item of the type plans an add; two items are both removed', () => {
  const none = planIdentityItems({ items: [], fieldDefs: DEFS, fieldsData: { career: 'Soldier' } });
  assert.deepEqual(none, [{ fieldKey: 'career', itemType: 'career', wantName: 'Soldier', removeIds: [] }]);
  const two = planIdentityItems({
    items: [{ id: 'x', name: 'Old', type: 'culture' }, { id: 'y', name: 'Older', type: 'culture' }],
    fieldDefs: DEFS, fieldsData: { culture: 'Urban' },
  });
  assert.deepEqual(two[0].removeIds, ['x', 'y']);
});

test('class, subclass, level and heroic_resource_name are never planned', () => {
  const plan = planIdentityItems({
    items: [], fieldDefs: DEFS,
    fieldsData: { class: 'Fury', subclass: 'Berserker', level: 'Fury', heroic_resource_name: 'Rage', multi: 'x', hp: 'x' },
  });
  assert.deepEqual(plan, []);
});

// --- applier, against a fake world -----------------------------------------

function fakeWorld({ worldItems = [], packs = [] } = {}) {
  return { items: worldItems, packs };
}
const doc = (name, type, extra = {}) => ({ name, type, toObject: () => ({ _id: 'src', name, type, folder: 'f', ownership: { default: 3 }, ...extra }) });
function fakePack(collection, packageType, docs, { documentName = 'Item' } = {}) {
  const calls = { index: 0, fields: null, got: [] };
  return {
    collection, documentName, metadata: { packageType }, calls,
    async getIndex(opts) { calls.index++; calls.fields = opts?.fields; return docs.map((d, i) => ({ _id: `p${i}`, name: d.name, type: d.type })); },
    async getDocument(id) { calls.got.push(id); return docs[Number(id.slice(1))]; },
  };
}
function fakeActor() {
  const log = [];
  return {
    name: 'Hero', log,
    async createEmbeddedDocuments(t, list, opts) { log.push(['create', list, opts]); return list; },
    async deleteEmbeddedDocuments(t, ids, opts) { log.push(['delete', ids, opts]); return []; },
  };
}

test('world items win over compendiums', async () => {
  const w = doc('Dwarf', 'ancestry', { from: 'world' });
  const pack = fakePack('sys.a', 'system', [doc('Dwarf', 'ancestry')]);
  const found = await findIdentityItem(fakeWorld({ worldItems: [w], packs: [pack] }), 'ancestry', ' dwarf ');
  assert.equal(found, w);
  assert.equal(pack.calls.index, 0, 'no compendium was read');
});

test('system packs are searched before others, index only asks for type, only Item packs', async () => {
  const mod = fakePack('mod.a', 'module', [doc('Dwarf', 'ancestry', { from: 'module' })]);
  const sys = fakePack('sys.a', 'system', [doc('Dwarf', 'ancestry', { from: 'system' })]);
  const actorsPack = fakePack('sys.actors', 'system', [doc('Dwarf', 'ancestry')], { documentName: 'Actor' });
  const found = await findIdentityItem(fakeWorld({ packs: [mod, actorsPack, sys] }), 'ancestry', 'Dwarf');
  assert.equal(found.toObject().from, 'system');
  assert.deepEqual(sys.calls.fields, ['type']);
  assert.equal(actorsPack.calls.index, 0);
  assert.equal(mod.calls.index, 0);
});

test('the name must match the type too', async () => {
  const pack = fakePack('sys.a', 'system', [doc('Dwarf', 'culture')]);
  assert.equal(await findIdentityItem(fakeWorld({ packs: [pack] }), 'ancestry', 'Dwarf'), null);
});

test('a found item is embedded without _id, folder or ownership, then the old one is removed, with echo options', async () => {
  const actor = fakeActor();
  const step = { fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'Dwarf', removeIds: ['a1'] };
  const how = await applyIdentityItem(actor, step, fakeWorld({ worldItems: [doc('Dwarf', 'ancestry')] }));
  assert.equal(how, 'found');
  assert.deepEqual(actor.log.map((l) => l[0]), ['create', 'delete']);
  const created = actor.log[0][1][0];
  assert.equal(created._id, undefined);
  assert.equal(created.folder, undefined);
  assert.equal(created.ownership, undefined);
  assert.equal(created.name, 'Dwarf');
  for (const l of actor.log) {
    assert.equal(l[2].chronicleSyncApply, true);
    assert.equal(l[2].chronicleSync, true);
  }
  assert.deepEqual(actor.log[1][1], ['a1']);
});

test('no match makes a plain flagged item; nothing to remove means no delete call', async () => {
  const actor = fakeActor();
  const how = await applyIdentityItem(actor, { fieldKey: 'kit', itemType: 'kit', wantName: 'Homebrew Kit', removeIds: [] }, fakeWorld());
  assert.equal(how, 'made');
  assert.deepEqual(actor.log.map((l) => l[0]), ['create']);
  assert.deepEqual(actor.log[0][1][0], {
    name: 'Homebrew Kit', type: 'kit', flags: { 'chronicle-sync': { chronicleMade: true } },
  });
});

test('a failed create leaves the old item and the other steps still run', async () => {
  const actor = fakeActor();
  const real = actor.createEmbeddedDocuments;
  actor.createEmbeddedDocuments = async function (t, list, o) {
    if (list[0].name === 'Boom') throw new Error('nope');
    return real.call(this, t, list, o);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await applyIdentityPlan(actor, [
      { fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'Boom', removeIds: ['a1'] },
      { fieldKey: 'kit', itemType: 'kit', wantName: 'Ok', removeIds: [] },
    ], fakeWorld());
    assert.deepEqual(res, { done: ['kit'], failed: ['ancestry'] });
  } finally {
    console.error = quiet;
  }
  assert.ok(!actor.log.some((l) => l[0] === 'delete'), 'old item kept');
});
