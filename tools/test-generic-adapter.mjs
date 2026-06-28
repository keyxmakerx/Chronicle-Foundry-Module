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

const { getNestedValue, extractCollectionField, buildChronicleFields, normalizeFoundryValue } =
  await import('../scripts/adapters/generic-adapter.mjs');

// ── Foundry-ish data structures for the normalizer tests ──────────────────
// A Foundry Collection is a Map subclass exposing members via `.contents`.
class FakeCollection extends Map {
  constructor(members) {
    super(members.map((m, i) => [m._id ?? String(i), m]));
  }
  get contents() { return Array.from(this.values()); }
}
// A pseudo-document / DataModel exposes data via toObject(), not own props —
// the schema fields here are GETTERS so a naive key-copy would miss them.
class FakeModel {
  constructor(source) { this._source = source; }
  get tier1() { return this._source.tier1; }
  toObject() { return JSON.parse(JSON.stringify(this._source)); }
}

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
        { id: 'i4', name: 'Conduit', type: 'class', system: { level: 4 } },
        { id: 'i5', name: 'Hakaan', type: 'ancestry', system: {} },
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

test('extractCollectionField single → first matching item name (class/ancestry/kit)', () => {
  const cls = extractCollectionField(makeActor(), {
    key: 'class', type: 'string',
    foundry_collection: 'items', foundry_item_type: 'class', foundry_item_single: true,
  });
  assert.equal(cls, 'Conduit'); // plain string, not a JSON array

  const anc = extractCollectionField(makeActor(), {
    key: 'ancestry', type: 'string',
    foundry_collection: 'items', foundry_item_type: ['ancestry'], foundry_item_single: true,
  });
  assert.equal(anc, 'Hakaan');
});

test('extractCollectionField single honors a projection path and is empty when none match', () => {
  // projection → use the first projected path instead of name
  const lvl = extractCollectionField(makeActor(), {
    key: 'class_level', type: 'string',
    foundry_collection: 'items', foundry_item_type: 'class', foundry_item_single: true,
    foundry_item_fields: { level: 'system.level' },
  });
  assert.equal(lvl, 4);

  // no matching item → empty string (a string field, not '[]')
  const none = extractCollectionField(makeActor(), {
    key: 'kit', type: 'string',
    foundry_collection: 'items', foundry_item_type: 'kit', foundry_item_single: true,
  });
  assert.equal(none, '');
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

// ── normalizeFoundryValue ─────────────────────────────────────────────────

test('normalizeFoundryValue passes primitives and plain values through', () => {
  assert.equal(normalizeFoundryValue(7), 7);
  assert.equal(normalizeFoundryValue('hi'), 'hi');
  assert.equal(normalizeFoundryValue(null), null);
  assert.equal(normalizeFoundryValue(undefined), undefined);
  assert.deepEqual(normalizeFoundryValue([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(normalizeFoundryValue({ a: 1, b: 'x' }), { a: 1, b: 'x' });
});

test('normalizeFoundryValue turns a Set into an array (keywords/skills/statuses)', () => {
  assert.deepEqual(normalizeFoundryValue(new Set(['magic', 'ranged'])), ['magic', 'ranged']);
  assert.deepEqual(normalizeFoundryValue(new Set()), []);
});

test('normalizeFoundryValue normalizes nested Sets inside a plain object', () => {
  const v = normalizeFoundryValue({ type: 'damage', types: new Set(['fire']), n: 2 });
  assert.deepEqual(v, { type: 'damage', types: ['fire'], n: 2 });
});

test('normalizeFoundryValue unrolls a Foundry Collection via .contents + toObject', () => {
  const effects = new FakeCollection([
    new FakeModel({ _id: 'a', type: 'damage', tier1: { value: '2 + @chr', types: ['fire'] } }),
    new FakeModel({ _id: 'b', type: 'damage', tier1: { value: '3', types: [] } }),
  ]);
  const out = normalizeFoundryValue(effects);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { _id: 'a', type: 'damage', tier1: { value: '2 + @chr', types: ['fire'] } });
  assert.equal(out[1].tier1.value, '3');
});

test('extractCollectionField projects a Set sub-field to a JSON array (ability keywords)', () => {
  const actor = {
    items: { contents: [
      { id: 'i1', name: 'Ray of Wrath', type: 'ability',
        system: { type: 'main', category: 'signature', keywords: new Set(['magic', 'ranged']) } },
    ] },
  };
  const json = extractCollectionField(actor, {
    key: 'abilities_json', type: 'string',
    foundry_collection: 'items', foundry_item_type: 'ability',
    foundry_item_fields: { name: 'name', type: 'system.type', keywords: 'system.keywords' },
  });
  const abilities = JSON.parse(json);
  assert.deepEqual(abilities[0], { name: 'Ray of Wrath', type: 'main', keywords: ['magic', 'ranged'] });
});

test('buildChronicleFields serializes a Set scalar on a string field to JSON (skills)', () => {
  const actor = { system: { skills: { value: new Set(['alchemy', 'timescape']) } } };
  const out = buildChronicleFields(actor, [
    { key: 'skills_json', foundry_path: 'system.skills.value', type: 'string' },
  ]);
  assert.equal(typeof out.skills_json, 'string');
  assert.deepEqual(JSON.parse(out.skills_json), ['alchemy', 'timescape']);
});

test('buildChronicleFields serializes actor.statuses (Set) for conditions', () => {
  const actor = { system: {}, statuses: new Set(['slowed', 'weakened']) };
  const out = buildChronicleFields(actor, [
    { key: 'conditions_json', foundry_path: 'statuses', type: 'string' },
  ]);
  assert.deepEqual(JSON.parse(out.conditions_json), ['slowed', 'weakened']);
});
