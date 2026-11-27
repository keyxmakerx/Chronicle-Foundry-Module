#!/usr/bin/env node
/**
 * A campaign's own pick-list entry (a homebrew ancestry) fills the item sync
 * makes for it, never with GM-only text, and refreshes when the entry changes.
 * No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_TEXT_FORMAT, entryDescriptionHTML, entryItemFill, entryItemValues, findEntry, planEntryRefresh, usableEntryPath } from '../scripts/_campaign-entry-item.mjs';
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
