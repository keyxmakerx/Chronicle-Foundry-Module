#!/usr/bin/env node
/**
 * NPC character pages become the system's NPC actor type, and the switch
 * offered for actors made as the wrong type.
 *
 * Run: `node --test tools/test-npc-character.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  npcActorTypeFor, isHeroPage, actorTypeForPage, switchTarget, planTypeSwitch, carriedSystem,
} from '../scripts/_npc-character.mjs';

// The slice of Draw Steel's character fields these rules read.
const single = (key, type) => ({ key, type: 'string', foundry_collection: 'items', foundry_item_type: [type], foundry_item_single: true });
const fieldDefs = [
  single('class', 'class'),
  { key: 'level', type: 'number', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true },
  single('ancestry', 'ancestry'),
  single('culture', 'culture'),
  single('career', 'career'),
  single('kit', 'kit'),
  { key: 'stamina_max', type: 'number', foundry_path: 'system.stamina.max' },
];
const npcPage = { id: 'e1', entity_type_id: 3, fields_data: { title: 'Factor', race: 'Human', faction: 'The Guild' } };

test('npcActorTypeFor', () => {
  assert.equal(npcActorTypeFor('draw-steel', ['base', 'hero', 'npc', 'object']), 'npc');
  assert.equal(npcActorTypeFor('draw-steel', ['hero']), null, 'type missing from this world');
  assert.equal(npcActorTypeFor('draw-steel', undefined), null, 'no type list');
  assert.equal(npcActorTypeFor('dnd5e', ['character', 'npc']), null, 'only systems listed');
});

test('isHeroPage', () => {
  const cases = [
    ['narrative fields only', { entity: npcPage, fieldDefs }, false],
    ['empty page', { entity: { fields_data: {} }, fieldDefs }, false],
    ['no fields at all', { entity: {}, fieldDefs }, false],
    ['claimed by a player', { entity: { ...npcPage, owner_user_id: 'u1' }, fieldDefs }, true],
    ['marked playable in Chronicle', { entity: { ...npcPage, playable: true }, fieldDefs }, true],
    ['under Player Characters', { entity: { ...npcPage, entity_type_id: 7 }, pcSubtypeId: 7, fieldDefs }, true],
    ['names a class', { entity: { fields_data: { class: 'Conduit' } }, fieldDefs }, true],
    ['names an ancestry', { entity: { fields_data: { ancestry: 'Fairy' } }, fieldDefs }, true],
    ['names a kit', { entity: { fields_data: { kit: 'Panther' } }, fieldDefs }, true],
    ['blank picks', { entity: { fields_data: { class: '  ', ancestry: '' } }, fieldDefs }, false],
    ['stats but no hero choice', { entity: { fields_data: { stamina_max: 20, level: 1 } }, fieldDefs }, false],
  ];
  for (const [name, input, want] of cases) assert.equal(isHeroPage(input), want, name);
});

test('actorTypeForPage', () => {
  const base = { fieldDefs, heroType: 'hero', npcType: 'npc' };
  assert.equal(actorTypeForPage({ ...base, entity: npcPage }), 'npc');
  assert.equal(actorTypeForPage({ ...base, entity: { fields_data: { class: 'Fury' } } }), 'hero');
  assert.equal(actorTypeForPage({ ...base, npcType: null, entity: npcPage }), 'hero', 'no NPC type: as before');
});

test('switchTarget', () => {
  const base = { fieldDefs, heroType: 'hero', npcType: 'npc' };
  const hero = (extra = {}) => ({ type: 'hero', items: [{ type: 'ability' }], hasPlayerOwner: false, ...extra });
  const cases = [
    ['hero actor for an NPC page', { actor: hero(), entity: npcPage }, 'npc'],
    ['hero actor with a class item', { actor: hero({ items: [{ type: 'class' }] }), entity: npcPage }, null],
    ['hero actor a player owns', { actor: hero({ hasPlayerOwner: true }), entity: npcPage }, null],
    ['hero actor for a hero page', { actor: hero(), entity: { fields_data: { class: 'Fury' } } }, null],
    ['NPC actor for a page that became a hero', { actor: { type: 'npc', items: [] }, entity: { ...npcPage, owner_user_id: 'u1' } }, 'hero'],
    ['NPC actor for an NPC page', { actor: { type: 'npc', items: [] }, entity: npcPage }, null],
    ['some other type', { actor: { type: 'object', items: [] }, entity: npcPage }, null],
    ['no NPC type', { actor: hero(), entity: npcPage, npcType: null }, null],
    ['no page', { actor: hero(), entity: null }, null],
  ];
  for (const [name, input, want] of cases) assert.equal(switchTarget({ ...base, ...input }), want, name);
});

test('planTypeSwitch', () => {
  const basicUuids = ['Compendium.draw-steel.abilities.Item.aidAttack0000000', 'Compendium.draw-steel.abilities.Item.catchBreath00000'];
  const invalid = { ancestry: ['npc'], class: ['npc'], kit: ['npc'], ability: [], treasure: [] };
  const invalidTypesOf = (t) => invalid[t];
  const items = [
    { id: 'aidAttack0000000', type: 'ability' },
    { id: 'catchBreath00000', type: 'ability' },
    { id: 'ownAbility000000', type: 'ability' },
    { id: 'ancestry00000000', type: 'ancestry' },
    { id: 'sword00000000000', type: 'treasure' },
  ];
  assert.deepEqual(
    planTypeSwitch({ items, toType: 'npc', heroType: 'hero', invalidTypesOf, basicUuids }),
    { removeIds: ['aidAttack0000000', 'catchBreath00000', 'ancestry00000000'], addUuids: [] },
    'to NPC: hero-only items and the basic actions go; the rest stays',
  );
  assert.deepEqual(
    planTypeSwitch({ items: [{ id: 'catchBreath00000', type: 'ability' }, { id: 'claw000000000000', type: 'ability' }], toType: 'hero', heroType: 'hero', invalidTypesOf, basicUuids }),
    { removeIds: [], addUuids: [basicUuids[0]] },
    'to hero: missing basic actions come back, nothing doubled',
  );
  assert.deepEqual(
    planTypeSwitch({ items: [{ id: 'x', type: 'ability' }], toType: 'npc', heroType: 'hero' }),
    { removeIds: [], addUuids: [] },
    'no type rules known: nothing removed',
  );
});

test('carriedSystem', () => {
  assert.deepEqual(
    carriedSystem({ biography: { value: '<p>Notes</p>', director: '' }, stamina: { value: 0 }, hero: { victories: 2 } }),
    { biography: { value: '<p>Notes</p>', director: '' } },
  );
  assert.deepEqual(carriedSystem({ stamina: {} }), {});
  assert.deepEqual(carriedSystem(undefined), {});
});
