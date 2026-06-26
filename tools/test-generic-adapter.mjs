#!/usr/bin/env node
/**
 * Unit tests for the generic adapter's pure extraction core
 * (`scripts/adapters/generic-adapter.mjs`): scalar dot-path reads AND the new
 * collection extraction (abilities/inventory from actor.items[]).
 *
 * Run: `node --test tools/test-generic-adapter.mjs`
 * The extraction layer is pure (createGenericAdapter's async API fetch is not
 * exercised here), so no Foundry globals are needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { getNestedValue, extractCollectionField, buildChronicleFields } =
  await import('../scripts/adapters/generic-adapter.mjs');

// A Foundry-ish actor with system data + an items collection (Map-like w/ .contents).
function makeActor() {
  return {
    name: 'Tyne, the Ashbound',
    type: 'hero',
    system: {
      characteristics: { might: { value: 2 } },
      stamina: { value: 21, max: 30 },
      biography: 'Born beneath the broken peak of Cinderhold…',
    },
    items: {
      contents: [
        { id: 'i1', name: 'Ashfall Strike', type: 'ability', system: { keywords: ['melee'], heroic: 3 } },
        { id: 'i2', name: 'Mountain Stance', type: 'ability', system: { keywords: ['stance'] } },
        { id: 'i3', name: 'Ashbrand', type: 'equipment', system: { equipped: true } },
      ],
    },
  };
}

test('getNestedValue reads dot-paths and tolerates missing/garbage', () => {
  const a = makeActor();
  assert.equal(getNestedValue(a, 'system.characteristics.might.value'), 2);
  assert.equal(getNestedValue(a, 'system.stamina.max'), 30);
  assert.equal(getNestedValue(a, 'system.nope.deep'), undefined);
  assert.equal(getNestedValue(a, ''), undefined);
  assert.equal(getNestedValue(null, 'system.x'), undefined);
});

test('extractCollectionField filters by item type and projects fields → JSON', () => {
  const json = extractCollectionField(makeActor(), {
    key: 'abilities_json',
    type: 'string',
    foundry_collection: 'items',
    foundry_item_type: 'ability',
    foundry_item_fields: { name: 'name', keywords: 'system.keywords', heroic: 'system.heroic' },
  });
  const abilities = JSON.parse(json);
  assert.equal(abilities.length, 2); // only the two 'ability' items
  assert.deepEqual(abilities[0], { name: 'Ashfall Strike', keywords: ['melee'], heroic: 3 });
  assert.equal(abilities[1].heroic, null); // missing path → null, not undefined
});

test('extractCollectionField supports multiple types + default projection + raw array', () => {
  const arr = extractCollectionField(makeActor(), {
    key: 'inventory',
    type: 'array',
    foundry_collection: 'items',
    foundry_item_type: ['equipment', 'consumable'],
    // no projection → default {id,name,type}
  });
  assert.ok(Array.isArray(arr)); // type !== json/string → raw array
  assert.equal(arr.length, 1);
  assert.deepEqual(arr[0], { id: 'i3', name: 'Ashbrand', type: 'equipment' });
});

test('extractCollectionField is defensive (missing collection / bad actor → empty)', () => {
  assert.equal(extractCollectionField({}, { key: 'x', type: 'string', foundry_collection: 'items' }), '[]');
  assert.deepEqual(extractCollectionField({}, { key: 'x', type: 'array', foundry_collection: 'items' }), []);
  assert.doesNotThrow(() => extractCollectionField(null, { key: 'x', type: 'json', foundry_collection: 'items' }));
});

test('buildChronicleFields mixes scalar + collection fields into one fields_data', () => {
  const mapped = [
    { key: 'might', foundry_path: 'system.characteristics.might.value', type: 'number' },
    { key: 'stamina_current', foundry_path: 'system.stamina.value', type: 'number' },
    { key: 'backstory', foundry_path: 'system.biography', type: 'string' },
    {
      key: 'abilities_json',
      type: 'string',
      foundry_collection: 'items',
      foundry_item_type: 'ability',
      foundry_item_fields: { name: 'name' },
    },
  ];
  const out = buildChronicleFields(makeActor(), mapped);
  assert.equal(out.might, 2);
  assert.equal(out.stamina_current, 21);
  assert.match(out.backstory, /Cinderhold/);
  assert.deepEqual(JSON.parse(out.abilities_json), [{ name: 'Ashfall Strike' }, { name: 'Mountain Stance' }]);
});

test('buildChronicleFields sets null for a missing scalar path', () => {
  const out = buildChronicleFields(makeActor(), [{ key: 'speed', foundry_path: 'system.movement.speed', type: 'number' }]);
  assert.equal(out.speed, null);
});
