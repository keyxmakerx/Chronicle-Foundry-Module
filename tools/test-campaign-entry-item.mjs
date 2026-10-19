#!/usr/bin/env node
/**
 * A campaign's own pick-list entry (a homebrew ancestry) fills the item sync
 * makes for it, never with GM-only text, and refreshes when the entry changes.
 * No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryDescriptionHTML, entryItemFill, findEntry, planEntryRefresh } from '../scripts/_campaign-entry-item.mjs';
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
  assert.deepEqual(fill.flags, { 'chronicle-sync': { chronicleMade: true, entrySlug: 'fairy', entryUpdatedAt: FAIRY.updatedAt } });
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

test('refresh: nothing to do when current, not sync-made, renamed, secret or missing', () => {
  const cases = [
    { items: [made({ chronicleMade: true, entryUpdatedAt: FAIRY.updatedAt })] },
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
