#!/usr/bin/env node
/**
 * A campaign's own pick-list entry (a homebrew ancestry) fills the item sync
 * makes for it, never with GM-only text, and refreshes when the entry changes.
 * No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_TEXT_FORMAT, ENTRY_EFFECT_FLAG, effectPathsChange, entryDescriptionHTML, entryEffectChanges, entryItemFill, entryItemValues, findEntry, planEntryRefresh, usableEntryPath,
} from '../scripts/_campaign-entry-item.mjs';
import { applyIdentityItem, applyEntryRefresh } from '../scripts/_identity-item-apply.mjs';
import { identityFieldTypes } from '../scripts/_identity-item-plan.mjs';

// Foundry's cleaner, standing in: drops <script>, keeps the rest.
globalThis.foundry = { applications: { ux: { TextEditor: { cleanHTML: (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '') } } } };

const FAIRY = {
  fieldKey: 'ancestry', slug: 'fairy', name: 'Fairy', summary: 'Small and winged.',
  description: '<p>Born of the <em>wild</em>.</p>',
  properties: {
    size: '1T', speed: 5, signature_trait: 'Flight',
    purchased_traits: [{ name: 'Glow', cost: 1, description: 'Shed light <3 squares>' }, { name: 'Tiny', cost: 2 }, { cost: 9 }],
  },
  updatedAt: '2026-10-18T10:00:00Z',
};

test('the description carries the text, details and traits, escaping plain values', () => {
  const html = entryDescriptionHTML(FAIRY);
  assert.ok(html.startsWith('<p>Born of the <em>wild</em>.</p>'));
  assert.match(html, /<li><strong>Size:<\/strong> 1T<\/li>/);
  assert.match(html, /<li><strong>Signature trait:<\/strong> Flight<\/li>/);
  assert.match(html, /<h3>Purchased traits<\/h3>/);
  assert.match(html, /<strong>Glow<\/strong> \(1 point\): Shed light &lt;3 squares&gt;/);
  assert.match(html, /<strong>Tiny<\/strong> \(2 points\)<\/li>/);
  assert.equal((html.match(/<li>/g) || []).length, 5, 'a nameless trait is skipped');
});

test('the description goes through Foundry\'s cleaner', () => {
  assert.equal(entryDescriptionHTML({ description: '<p>a</p><script>x()</script>' }), '<p>a</p>');
});

test('with no description the summary stands in', () => {
  assert.equal(entryDescriptionHTML({ summary: 'A <b>', properties: {} }), '<p>A &lt;b&gt;</p>');
});

test('names match case-insensitively', () => {
  assert.equal(findEntry([FAIRY], ' fairy '), FAIRY);
  assert.equal(findEntry([FAIRY], 'Elf'), null);
  assert.equal(findEntry(undefined, 'Fairy'), null);
});

test('GM-only text keeps the item name-only', () => {
  assert.equal(entryItemFill({ ...FAIRY, description: '<p>ok</p><span data-secret="true">twist</span>' }), null);
  assert.equal(entryItemFill(null), null);
  const fill = entryItemFill(FAIRY);
  assert.deepEqual(fill.flags, { 'chronicle-sync': { chronicleMade: true, entrySlug: 'fairy', entryUpdatedAt: FAIRY.updatedAt, entryFormat: ENTRY_TEXT_FORMAT } });
});

function fakeActor() {
  const log = [];
  return {
    name: 'Hero', log,
    async createEmbeddedDocuments(t, list, opts) { log.push(['create', list, opts]); return list; },
    async deleteEmbeddedDocuments(t, ids, opts) { log.push(['delete', ids, opts]); return []; },
    async updateEmbeddedDocuments(t, list, opts) { log.push(['update', list, opts]); return list; },
  };
}

test('a made item is filled from the matching entry', async () => {
  const actor = fakeActor();
  const step = { fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'fairy', removeIds: [] };
  assert.equal(await applyIdentityItem(actor, step, { items: [], packs: [] }, [FAIRY]), 'made');
  const made = actor.log[0][1][0];
  assert.equal(made.name, 'fairy');
  assert.equal(made.system.description.value, entryDescriptionHTML(FAIRY));
  assert.equal(made.flags['chronicle-sync'].entryUpdatedAt, FAIRY.updatedAt);
});

test('a Foundry item of that name wins over the entry', async () => {
  const actor = fakeActor();
  const world = { items: [{ name: 'Fairy', type: 'ancestry', toObject: () => ({ name: 'Fairy', type: 'ancestry', system: { x: 1 } }) }], packs: [] };
  const step = { fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'Fairy', removeIds: [] };
  assert.equal(await applyIdentityItem(actor, step, world, [FAIRY]), 'found');
  assert.deepEqual(actor.log[0][1][0].system, { x: 1 });
});

const FIELDS = identityFieldTypes([{ key: 'ancestry', foundry_collection: 'items', foundry_item_type: ['ancestry'], foundry_item_single: true }]);
const made = (flags) => ({ id: 'i1', name: 'Fairy', type: 'ancestry', flags: { 'chronicle-sync': flags } });

test('refresh: a changed entry, or one never filled, rewrites the made item', () => {
  for (const flags of [{ chronicleMade: true }, { chronicleMade: true, entryUpdatedAt: '2026-01-01T00:00:00Z' }]) {
    const plan = planEntryRefresh({ items: [made(flags)], fields: FIELDS, fieldsData: { ancestry: 'Fairy' }, entriesByField: { ancestry: [FAIRY] } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].update._id, 'i1');
    assert.equal(plan[0].update['system.description.value'], entryDescriptionHTML(FAIRY));
    assert.equal(plan[0].update['flags.chronicle-sync.entryUpdatedAt'], FAIRY.updatedAt);
  }
});

test('refresh: an item filled by the older text format is rewritten once', () => {
  const old = made({ chronicleMade: true, entryUpdatedAt: FAIRY.updatedAt });
  const plan = planEntryRefresh({ items: [old], fields: FIELDS, fieldsData: { ancestry: 'Fairy' }, entriesByField: { ancestry: [FAIRY] } });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].update['flags.chronicle-sync.entryFormat'], ENTRY_TEXT_FORMAT);
});

test('a Markdown entry from the AI tools reads as text, with mentions linked', () => {
  const drakari = {
    description: 'Build a Drakari hero with the **Dragon Knight** ancestry. It is named for @[The Dragon Knights], '
      + 'kin of @[Nobody Here|someone].\n---',
  };
  const html = entryDescriptionHTML(drakari, { mentionId: (n) => (n === 'The Dragon Knights' ? 'ent-7' : null) });
  assert.equal(html, '<p>Build a Drakari hero with the <strong>Dragon Knight</strong> ancestry. It is named for '
    + '<a data-mention-id="ent-7">The Dragon Knights</a>, kin of someone.</p>');
});

test('refresh: nothing to do when current, not sync-made, renamed, secret or missing', () => {
  const cases = [
    { items: [made({ chronicleMade: true, entryUpdatedAt: FAIRY.updatedAt, entryFormat: ENTRY_TEXT_FORMAT })] },
    { items: [{ id: 'i1', name: 'Fairy', type: 'ancestry', flags: {} }] },
    { items: [made({ chronicleMade: true })], fieldsData: { ancestry: 'Elf' } },
    { items: [made({ chronicleMade: true })], entries: [{ ...FAIRY, description: '<span data-secret>x</span>' }] },
    { items: [made({ chronicleMade: true })], entries: [] },
  ];
  for (const c of cases) {
    const plan = planEntryRefresh({
      items: c.items, fields: FIELDS, fieldsData: c.fieldsData ?? { ancestry: 'Fairy' },
      entriesByField: { ancestry: c.entries ?? [FAIRY] },
    });
    assert.deepEqual(plan, []);
  }
});

test('refresh writes are marked as sync-applied', async () => {
  const actor = fakeActor();
  const plan = planEntryRefresh({ items: [made({ chronicleMade: true })], fields: FIELDS, fieldsData: { ancestry: 'Fairy' }, entriesByField: { ancestry: [FAIRY] } });
  assert.deepEqual(await applyEntryRefresh(actor, plan), ['ancestry']);
  assert.equal(actor.log[0][0], 'update');
  assert.equal(actor.log[0][2].chronicleSyncApply, true);
  assert.deepEqual(await applyEntryRefresh(fakeActor(), []), []);
});

// A campaign's own kit, with the system's map of where its bonuses go.
const KIT_FIELDS = {
  stamina_bonus: { path: 'system.bonuses.stamina', format: 'number' },
  speed_bonus: { path: 'system.bonuses.speed', format: 'number' },
  melee_damage_bonus: { path: 'system.bonuses.melee.damage', format: 'tiers' },
  ranged_damage_bonus: { path: 'system.bonuses.ranged.damage', format: 'tiers' },
  armor: { path: 'system.equipment.armor', format: 'text' },
};
const BOG = {
  fieldKey: 'kit', slug: 'bog-warden', name: 'Bog Warden', description: '<p>Mud and spears.</p>',
  properties: { stamina_bonus: 6, speed_bonus: '+1', melee_damage_bonus: '+0/+2/+4', ranged_damage_bonus: 'none', armor: ' Medium ' },
  updatedAt: '2026-11-27T12:00:00Z',
};

test('an entry\'s properties give the item values the system maps them to', () => {
  assert.deepEqual(entryItemValues(BOG, KIT_FIELDS), {
    'system.bonuses.stamina': 6,
    'system.bonuses.speed': 1,
    'system.bonuses.melee.damage.tier1': 0,
    'system.bonuses.melee.damage.tier2': 2,
    'system.bonuses.melee.damage.tier3': 4,
    'system.equipment.armor': 'Medium',
  }, 'a value that does not read in its format is left out');
  assert.deepEqual(entryItemValues({ properties: { melee_damage_bonus: 2 } }, KIT_FIELDS),
    { 'system.bonuses.melee.damage.tier1': 2, 'system.bonuses.melee.damage.tier2': 2, 'system.bonuses.melee.damage.tier3': 2 }, 'one number fills every tier');
  assert.deepEqual(entryItemValues(BOG, undefined), {}, 'no map, no values');
  assert.deepEqual(entryItemValues(BOG, { stamina_bonus: { path: 'flags.x', format: 'number' } }), {}, 'only the item\'s system data');
  assert.deepEqual(entryItemValues(BOG, { stamina_bonus: { path: 'system.a', format: 'html' } }), {}, 'an unknown format writes nothing');
});

test('a made kit carries its bonuses beside its description', async () => {
  const actor = fakeActor();
  const step = { fieldKey: 'kit', itemType: 'kit', wantName: 'Bog Warden', removeIds: [] };
  assert.equal(await applyIdentityItem(actor, step, { items: [], packs: [] }, [BOG], KIT_FIELDS), 'made');
  const item = actor.log[0][1][0];
  assert.deepEqual(item.system.bonuses, { stamina: 6, speed: 1, melee: { damage: { tier1: 0, tier2: 2, tier3: 4 } } });
  assert.equal(item.system.equipment.armor, 'Medium');
  assert.equal(item.system.description.value, entryDescriptionHTML(BOG));
});

test('refresh: a changed kit entry rewrites its bonuses too', () => {
  const kitFields = identityFieldTypes([{ key: 'kit', foundry_collection: 'items', foundry_item_type: ['kit'], foundry_item_single: true }]);
  const item = { id: 'k1', name: 'Bog Warden', type: 'kit', flags: { 'chronicle-sync': { chronicleMade: true, entryUpdatedAt: '2026-01-01T00:00:00Z', entryFormat: ENTRY_TEXT_FORMAT } } };
  const plan = planEntryRefresh({
    items: [item], fields: kitFields, fieldsData: { kit: 'Bog Warden' }, entriesByField: { kit: [BOG] }, entryFieldsByField: { kit: KIT_FIELDS },
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].update['system.bonuses.stamina'], 6);
  assert.equal(plan[0].update['system.bonuses.melee.damage.tier3'], 4);
  assert.equal(plan[0].update['system.description.value'], entryDescriptionHTML(BOG));
});

test('a mapped path that could reach a shared object, or runs too deep, writes nothing', () => {
  const bad = [
    'system.__proto__.x', 'system.a.__proto__', 'system._x', 'system.1a',
    'system.constructor.prototype.x', 'system.a.prototype', 'system.constructor',
    'system.a.b.c.d.e.f.g.h.i', 'system', 'system.', 'system..a',
  ];
  for (const path of bad) {
    assert.equal(usableEntryPath(path), false, path);
    assert.deepEqual(entryItemValues({ properties: { stamina_bonus: '6' } }, { stamina_bonus: { path, format: 'number' } }), {}, path);
    entryItemFill({ name: 'Bog', properties: { stamina_bonus: '6' } }, { entryFields: { stamina_bonus: { path, format: 'number' } } });
  }
  assert.equal(usableEntryPath('system.a.b.c.d.e.f.g.h'), true, 'eight segments under system');
  assert.equal(({}).x, undefined, 'nothing reached the shared prototype');
  const made = entryItemFill({ name: 'Bog', properties: { stamina_bonus: '6' } }, { entryFields: { stamina_bonus: { path: 'system.bonuses.stamina', format: 'number' } } });
  assert.equal(Object.getPrototypeOf(made.system.bonuses), Object.prototype, 'Foundry gets plain objects');
});

// The Draw Steel package's ancestry map: an ancestry's numbers change the hero.
const ANCESTRY_EFFECTS = {
  speed: { path: 'system.movement.value', type: 'upgrade', format: 'number' },
  size: { path: 'system.combat.size', type: 'override', format: 'size' },
  stability: { path: 'system.combat.stability', type: 'add', format: 'number' },
};
const change = (key, type, value) => ({ key, type, value, phase: 'initial', priority: type === 'upgrade' ? 5 : null });

test('an ancestry\'s numbers become changes to the hero', () => {
  assert.deepEqual(entryEffectChanges({ properties: { size: '1T', speed: 6, stability: '+1' } }, ANCESTRY_EFFECTS), [
    change('system.combat.size.value', 'override', 1),
    change('system.combat.size.letter', 'override', 'T'),
    change('system.movement.value', 'upgrade', 6),
    change('system.combat.stability', 'add', 1),
  ]);
  assert.deepEqual(entryEffectChanges({ properties: { size: '2' } }, ANCESTRY_EFFECTS),
    [change('system.combat.size.value', 'override', 2)], 'a letter only for size 1');
  assert.deepEqual(entryEffectChanges({ properties: { size: 2 } }, ANCESTRY_EFFECTS),
    [change('system.combat.size.value', 'override', 2)], 'a bare number is a size');
  assert.deepEqual(entryEffectChanges({ properties: { size: 'huge', speed: 'fast', stability: '' } }, ANCESTRY_EFFECTS), [], 'what does not read is left out');
  assert.deepEqual(entryEffectChanges({ properties: { size: '0' } }, ANCESTRY_EFFECTS), [], 'no size below 1');
  assert.deepEqual(entryEffectChanges({ properties: { speed: 6 } }, undefined), [], 'no map, no changes');
  assert.equal(entryEffectChanges({ properties: { speed: 6 } }, ANCESTRY_EFFECTS)[0].priority, 5, 'an upgrade goes before bonuses added on top');
});

test('an effect mapping Chronicle would refuse changes nothing', () => {
  const props = { properties: { speed: 6, size: '1S' } };
  const bad = [
    { speed: { path: 'token.light.bright', type: 'upgrade', format: 'number' } },
    { speed: { path: 'system.__proto__.x', type: 'upgrade', format: 'number' } },
    { speed: { path: 'system.movement.value', type: 'custom', format: 'number' } },
    { speed: { path: 'system.movement.value', type: 'upgrade', format: 'text' } },
    { size: { path: 'system.combat.size', type: 'add', format: 'size' } },
  ];
  for (const map of bad) assert.deepEqual(entryEffectChanges(props, map), [], JSON.stringify(map));
});

const DRYAD = {
  fieldKey: 'ancestry', slug: 'dryad', name: 'Dryad', description: '<p>Bark and leaf.</p>',
  properties: { size: '1S', speed: 6, stability: 1 },
  updatedAt: '2026-11-27T12:00:00Z',
};

test('a made ancestry carries one effect with its numbers, marked as sync\'s', async () => {
  const actor = fakeActor();
  const step = { fieldKey: 'ancestry', itemType: 'ancestry', wantName: 'Dryad', removeIds: [] };
  assert.equal(await applyIdentityItem(actor, step, { items: [], packs: [] }, [DRYAD], undefined, ANCESTRY_EFFECTS), 'made');
  const item = actor.log[0][1][0];
  assert.equal(item.effects.length, 1);
  const [effect] = item.effects;
  assert.equal(effect.transfer, true, 'the hero has it while the item is on the sheet');
  assert.equal(effect.type, 'base');
  assert.equal(effect.name, 'Dryad');
  assert.deepEqual(effect.flags['chronicle-sync'], { chronicleMade: true, [ENTRY_EFFECT_FLAG]: true });
  assert.deepEqual(effect.system.changes.map((c) => [c.key, c.value]), [
    ['system.combat.size.value', 1], ['system.combat.size.letter', 'S'], ['system.movement.value', 6], ['system.combat.stability', 1],
  ]);
  const plain = fakeActor();
  await applyIdentityItem(plain, step, { items: [], packs: [] }, [{ ...DRYAD, properties: {} }], undefined, ANCESTRY_EFFECTS);
  assert.equal(plain.log[0][1][0].effects, undefined, 'no numbers, no effect');
});

// A made ancestry item, with whatever effects it carries.
function madeAncestry(effects) {
  const log = [];
  const record = (op) => async (t, list, opts) => { log.push([op, t, list, opts]); return list; };
  return {
    id: 'a1', name: 'Dryad', type: 'ancestry', log, effects,
    flags: { 'chronicle-sync': { chronicleMade: true, entryUpdatedAt: '2026-01-01T00:00:00Z', entryFormat: ENTRY_TEXT_FORMAT } },
    createEmbeddedDocuments: record('create'), updateEmbeddedDocuments: record('update'), deleteEmbeddedDocuments: record('delete'),
  };
}
const ANCESTRY_FIELDS = identityFieldTypes([{ key: 'ancestry', foundry_collection: 'items', foundry_item_type: ['ancestry'], foundry_item_single: true }]);
const refreshDryad = (item, entry = DRYAD, map = ANCESTRY_EFFECTS) => planEntryRefresh({
  items: [item], fields: ANCESTRY_FIELDS, fieldsData: { ancestry: 'Dryad' }, entriesByField: { ancestry: [entry] }, entryEffectsByField: { ancestry: map },
});
const withItem = (item) => ({ ...fakeActor(), items: { get: (id) => (id === item.id ? item : undefined) } });

test('refresh: an edited ancestry rewrites only the effect sync made', async () => {
  const gm = { id: 'gm1', flags: {} };
  const own = { id: 'e1', flags: { 'chronicle-sync': { chronicleMade: true, [ENTRY_EFFECT_FLAG]: true } } };
  const item = madeAncestry([gm, own]);
  const plan = refreshDryad(item, { ...DRYAD, properties: { speed: 7 } });
  assert.deepEqual(plan[0].effect, { update: { _id: 'e1', name: 'Dryad', 'system.changes': [change('system.movement.value', 'upgrade', 7)] } });
  await applyEntryRefresh(withItem(item), plan);
  assert.deepEqual(item.log.map(([op, t, list]) => [op, t, list[0]._id]), [['update', 'ActiveEffect', 'e1']]);
  assert.equal(item.log[0][3].chronicleSyncApply, true, 'marked as sync\'s own write');
});

test('refresh: an entry edit that moves no number leaves the effect alone', () => {
  const changes = entryEffectChanges(DRYAD, ANCESTRY_EFFECTS).map((c) => ({ ...c, value: String(c.value) }));
  const own = { id: 'e1', name: 'Dryad', system: { changes }, flags: { 'chronicle-sync': { chronicleMade: true, [ENTRY_EFFECT_FLAG]: true } } };
  assert.equal(refreshDryad(madeAncestry([own]), { ...DRYAD, summary: 'A new summary.' })[0]?.effect, undefined);
  assert.ok(refreshDryad(madeAncestry([own]), { ...DRYAD, properties: { ...DRYAD.properties, speed: 9 } })[0].effect.update, 'a moved number still rewrites');
});

test('refresh: an item made before effects gains one; numbers taken out take it off', async () => {
  const bare = madeAncestry([]);
  const plan = refreshDryad(bare);
  assert.equal(plan[0].effect.create.system.changes.length, 4);
  await applyEntryRefresh(withItem(bare), plan);
  assert.deepEqual(bare.log.map(([op, t]) => [op, t]), [['create', 'ActiveEffect']]);

  const own = { id: 'e1', flags: { 'chronicle-sync': { chronicleMade: true, [ENTRY_EFFECT_FLAG]: true } } };
  const item = madeAncestry([{ id: 'gm1', flags: {} }, own]);
  const removed = refreshDryad(item, { ...DRYAD, properties: {} });
  assert.deepEqual(removed[0].effect, { remove: 'e1' });
  await applyEntryRefresh(withItem(item), removed);
  assert.deepEqual(item.log.map(([op, t, list]) => [op, t, list]), [['delete', 'ActiveEffect', ['e1']]], 'the GM\'s own effect stays');

  assert.equal(refreshDryad(madeAncestry([{ id: 'gm1', flags: {} }]), { ...DRYAD, properties: {} })[0].effect, undefined, 'nothing to make or take off');
});

test('the hero\'s paths an effect changes are pushed as one pending change', () => {
  assert.deepEqual(effectPathsChange([ANCESTRY_EFFECTS, undefined]), {
    system: { movement: { value: true }, combat: { size: true, stability: true } },
  });
  assert.equal(effectPathsChange([undefined, {}]), null, 'nothing mapped, nothing pushed');
  assert.equal(effectPathsChange([{ x: { path: 'system.__proto__.x', type: 'add', format: 'number' } }]), null, 'a refused path is not touched');
  assert.equal(({}).x, undefined);
});
