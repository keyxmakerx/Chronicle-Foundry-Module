#!/usr/bin/env node
/**
 * Chronicle creature abilities as Draw Steel ability items: the text is read
 * into the system's own fields and effects, nothing in a tier is dropped, and
 * only the items sync made are ever replaced or removed.
 *
 * Run: `node --test tools/test-creature-abilities.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABILITY_FLAG, plainText, parseDistance, parseTarget, parseTier, powerEffects, rollBonus,
  abilityItem, desiredAbilities, planAbilityItems, abilitiesFingerprint, hasAbilityFields,
} from '../scripts/_creature-abilities.mjs';

const SCOPE = 'chronicle-sync';

// Entries as the Draw Steel package ships them in data/monsters.json.
const SNIPER = {
  name: 'Shortbow Shot', type: 'signature', keywords: ['Strike', 'Ranged', 'Weapon'], distance: 'Ranged 5',
  target: '1 creature', tier1: '4 damage', tier2: '6 damage', tier3: '7 damage; {@condition bleeding} ({@duration eot})',
  power_roll: '2d10 + 2',
};
const BASILISK = {
  name: 'Petrifying Gaze', type: 'action', keywords: ['Magic', 'Ranged'], distance: 'Ranged 10', target: 'One creature',
  tier1: 'M < 0 {@condition restrained} ({@duration save-ends|save ends})',
  tier2: 'M < 1 {@condition restrained} ({@duration save-ends|save ends})',
  tier3: 'M < 2 {@condition restrained} ({@duration save-ends|save ends})',
  power_roll: '2d10 + 3',
};
const WINDS = {
  name: 'Toxic Winds', type: 'signature', keywords: ['Area', 'Magic'], distance: '3 cube within 15',
  target: 'Each enemy in the area', tier1: '3 poison damage; {@movement slide} 1', tier2: '5 poison damage; {@movement slide} 2',
  tier3: '7 poison damage; vertical {@movement slide} 3; P < 2 {@condition dazed} ({@duration save-ends|save ends})',
  power_roll: '2d10 + 2', effect: 'The area is {@condition dazed|difficult} terrain until the end of the round.',
};

test('markup reads as its shown words', () => {
  assert.equal(plainText('{@condition slowed} ({@duration save-ends|save ends})'), 'slowed (save ends)');
  assert.equal(plainText('  {@movement push}   2 '), 'push 2');
  assert.equal(plainText(null), '');
});

test('distances become the system\'s distance types', () => {
  const cases = [
    ['Melee 1', 'melee', '1', '1', '1', '1'],
    ['Ranged 10', 'ranged', '10', '1', '1', '1'],
    ['Melee 1 or ranged 5', 'meleeRanged', '1', '5', '1', '1'],
    ['3 burst', 'burst', '3', '1', '1', '1'],
    ['2 aura', 'aura', '2', '1', '1', '1'],
    ['Aura 3', 'aura', '3', '1', '1', '1'],
    ['3 cube within 15', 'cube', '3', '15', '1', '1'],
    ['Four 1 cubes within 10', 'cube', '1', '10', '1', '4'],
    ['7 x 2 line within 10', 'line', '7', '2', '10', '1'],
    ['5 wall within 10', 'wall', '5', '10', '1', '1'],
    ['Self', 'self', '1', '1', '1', '1'],
    ['Self; see below', 'self', '1', '1', '1', '1'],
    ['1-mile burst', 'special', '1', '1', '1', '1'],
    ['', 'special', '1', '1', '1', '1'],
  ];
  for (const [text, type, primary, secondary, tertiary, count] of cases) {
    assert.deepEqual(parseDistance(text), { type, primary, secondary, tertiary, count }, text);
  }
});

test('targets become the system\'s target types, keeping words it has no type for', () => {
  const cases = [
    ['Self', 'self', null, ''],
    ['One creature or object', 'creatureObject', 1, ''],
    ['Two creatures or objects', 'creatureObject', 2, ''],
    ['1 creature', 'creature', 1, ''],
    ['Three enemies', 'enemy', 3, ''],
    ['One ally', 'ally', 1, ''],
    ['Each enemy in the area', 'enemy', null, ''],
    ['All creatures in area', 'creature', null, ''],
    ['Each enemy and object in the area', 'enemyObject', null, ''],
    ['Self and each ally in the area', 'selfAlly', null, ''],
    ['Self or one ally', 'selfOrAlly', 1, ''],
    ['One creature or object per minion', 'creatureObject', 1, 'One creature or object per minion'],
    ['The triggering creature', 'special', null, 'The triggering creature'],
    ['One war dog', 'special', null, 'One war dog'],
  ];
  for (const [text, type, value, custom] of cases) {
    assert.deepEqual(parseTarget(text), { type, value, custom }, text);
  }
});

test('a tier splits into damage, conditions with potency, forced movement and other text', () => {
  assert.deepEqual(parseTier('9 fire damage; M < 2 {@condition weakened} ({@duration save-ends|save ends})'), [
    { kind: 'damage', value: '9', types: ['fire'] },
    { kind: 'applied', condition: 'weakened', end: 'save', potency: { characteristic: 'might', value: '2' }, display: '{{potency}} weakened (save ends)' },
  ]);
  assert.deepEqual(parseTier('{@condition taunted} ({@duration eot|EoT})'), [
    { kind: 'applied', condition: 'taunted', end: 'turn', potency: null, display: 'taunted (EoT)' },
  ]);
  assert.deepEqual(parseTier('6 damage; {@movement push} 2, prone').map((c) => c.kind), ['damage', 'forced', 'applied']);
  assert.deepEqual(parseTier('R < 2 dazed and slowed (save ends)').map((c) => c.condition), ['dazed', 'slowed']);
  assert.deepEqual(parseTier('A < 1 2 damage; the target gains 1 rage'), [
    { kind: 'other', text: 'A < 1 2 damage' }, { kind: 'other', text: 'the target gains 1 rage' },
  ]);
  // A damage type or condition the system doesn't list stays text.
  assert.equal(parseTier('3 void damage')[0].kind, 'other');
  assert.equal(parseTier('slowed (save ends)', { conditions: ['dazed'] })[0].kind, 'other');
});

test('power roll effects carry every tier: damage 0 where a tier has none, conditions only on failed potency', () => {
  const effects = Object.values(powerEffects([BASILISK.tier1, BASILISK.tier2, BASILISK.tier3]));
  assert.equal(effects.length, 1);
  const [applied] = effects;
  assert.equal(applied.type, 'applied');
  assert.equal(applied._id.length, 16);
  assert.deepEqual(applied.applied.tier3, {
    display: '{{potency}} restrained (save ends)',
    potency: { value: '2', characteristic: 'might' },
    effects: { restrained: { condition: 'failure', end: 'save', properties: [] } },
  });

  const sniper = Object.values(powerEffects([SNIPER.tier1, SNIPER.tier2, SNIPER.tier3]));
  assert.deepEqual(sniper.map((e) => e.type), ['damage', 'applied']);
  assert.deepEqual(['tier1', 'tier2', 'tier3'].map((t) => sniper[0].damage[t].value), ['4', '6', '7']);
  assert.deepEqual(sniper[1].applied.tier1, { display: '', potency: { value: '@potency.weak', characteristic: 'none' }, effects: {} });
  assert.deepEqual(sniper[1].applied.tier3.effects, { bleeding: { condition: 'always', end: 'turn', properties: [] } });

  const winds = Object.values(powerEffects([WINDS.tier1, WINDS.tier2, WINDS.tier3]));
  const forced = winds.find((e) => e.type === 'forced');
  assert.deepEqual(forced.forced.tier3, {
    display: '{{forced}}', movement: ['slide'], distance: '3', properties: ['vertical'], potency: { value: '@potency.strong', characteristic: '' },
  });
  assert.deepEqual(winds.find((e) => e.type === 'damage').damage.tier1.types, ['poison']);

  const noTier1 = Object.values(powerEffects(['', '2 damage', '3 damage']));
  assert.equal(noTier1[0].damage.tier1.value, '0', 'the system shows no damage for 0');
});

test('a condition a higher tier drops is kept as text, since the system carries tier wording upward', () => {
  const effects = Object.values(powerEffects(['2 damage; prone', '4 damage', '6 damage; prone']));
  assert.deepEqual(effects.map((e) => e.type), ['damage', 'other']);
  assert.deepEqual(['tier1', 'tier2', 'tier3'].map((t) => effects[1].other[t].display), ['prone', '', 'prone']);
});

test('the roll bonus is Chronicle\'s own number', () => {
  assert.equal(rollBonus('2d10 + 2'), '2');
  assert.equal(rollBonus('2d10 - 1'), '-1');
  assert.equal(rollBonus('2d10'), '0');
  assert.equal(rollBonus('Might vs. Agility'), null);
  assert.equal(rollBonus(''), null);
});

test('an ability becomes a Draw Steel ability item flagged as made by sync', () => {
  const item = abilityItem(WINDS, { key: 'abilities_json:toxic winds', hash: 'h1', flagScope: SCOPE, known: { keywords: ['area', 'magic'] } });
  assert.equal(item.type, 'ability');
  assert.equal(item.name, 'Toxic Winds');
  assert.equal(item.system.type, 'main');
  assert.equal(item.system.category, 'signature');
  assert.deepEqual(item.system.keywords, ['area', 'magic']);
  assert.deepEqual(item.system.distance, { type: 'cube', primary: '3', secondary: '15', tertiary: '1', count: '1' });
  assert.equal(item.system.target.type, 'enemy');
  assert.deepEqual(item.system.power.roll, { formula: '2', characteristics: [], reactive: false });
  assert.equal(item.system.effects.after00000000000.description, '<p>The area is difficult terrain until the end of the round.</p>');
  assert.deepEqual(item.flags[SCOPE], { [ABILITY_FLAG]: 'abilities_json:toxic winds', [`${ABILITY_FLAG}Hash`]: 'h1' });

  const villain = abilityItem({ name: 'Opener', type: 'villain-action', distance: 'Special; see below', effect: 'Each <b>goblin</b> shifts 2.' },
    { villain: true, key: 'k', hash: 'h', flagScope: SCOPE });
  assert.equal(villain.system.type, 'villain');
  assert.equal(villain.system.category, 'villain');
  assert.deepEqual(villain.system.power.effects, {});
  assert.equal(villain.system.effects.before0000000000.description, '<p>Special; see below</p>');
  assert.match(villain.system.effects.after00000000000.description, /&lt;b&gt;goblin&lt;\/b&gt;/, 'Chronicle text is escaped');

  const odd = abilityItem({ name: 'Grip', type: 'maneuver', power_roll: 'Might vs. Agility', tier1: 'grabbed', tier2: 'grabbed', tier3: 'grabbed' },
    { key: 'k', hash: 'h', flagScope: SCOPE });
  assert.equal(odd.system.type, 'maneuver');
  assert.equal(odd.system.power.roll.formula, '0');
  assert.equal(odd.system.effects.before0000000000.description, '<p>Power roll: Might vs. Agility</p>');
  assert.equal(Object.values(odd.system.power.effects)[0].type, 'applied', 'the tiers are kept');
});

test('a page\'s abilities and villain actions are keyed by list and name, duplicates numbered', () => {
  const fields = {
    abilities_json: JSON.stringify([SNIPER, BASILISK, { ...SNIPER }]),
    villain_actions_json: JSON.stringify([{ name: 'Shortbow Shot', type: 'villain-action' }, { type: 'action' }]),
  };
  const desired = desiredAbilities(fields, { flagScope: SCOPE });
  assert.deepEqual(desired.map((d) => d.key), [
    'abilities_json:shortbow shot', 'abilities_json:petrifying gaze', 'abilities_json:shortbow shot#2', 'villain_actions_json:shortbow shot',
  ]);
  assert.equal(desired[0].hash, desired[2].hash, 'the hash follows the ability, not its place');
  assert.deepEqual(desiredAbilities({ abilities_json: 'not json' }, { flagScope: SCOPE }), []);
  assert.deepEqual(desiredAbilities({}, { flagScope: SCOPE }), []);
  assert.equal(hasAbilityFields({ abilities_json: '' }), true);
  assert.equal(hasAbilityFields({ level: 1 }), false);
  assert.notEqual(abilitiesFingerprint(fields), abilitiesFingerprint({ ...fields, villain_actions_json: '[]' }));
});

test('only sync-made items change; the GM\'s own abilities stay and are not doubled', () => {
  const d = (key, hash, name) => ({ key, hash, data: { name } });
  const desired = [d('a:bite', 'h1', 'Bite'), d('a:claw', 'h2', 'Claw'), d('a:roar', 'h3', 'Roar'), d('a:gaze', 'h4', 'Gaze')];
  const items = [
    { id: 'i1', name: 'Bite', type: 'ability', key: 'a:bite', hash: 'h1' },
    { id: 'i2', name: 'Claw', type: 'ability', key: 'a:claw', hash: 'old' },
    { id: 'i3', name: 'Tail', type: 'ability', key: 'a:tail', hash: 'h9' },
    { id: 'i4', name: 'roar ', type: 'ability' },
    { id: 'i5', name: 'Gaze', type: 'feature' },
    { id: 'i6', name: 'Homebrew Slam', type: 'ability' },
  ];
  const plan = planAbilityItems(desired, items);
  assert.deepEqual(plan.remove.sort(), ['i2', 'i3'], 'a changed ability is rebuilt, a removed one goes');
  assert.deepEqual(plan.create.map((c) => c.name), ['Claw', 'Gaze'], 'Roar is the GM\'s; a feature named Gaze is not an ability');
  assert.deepEqual(planAbilityItems(desired.slice(0, 1), items.slice(0, 1)), { create: [], remove: [] });
});

test('a GM ability added after sync made one by that name replaces sync\'s copy', () => {
  const desired = [{ key: 'a:bite', hash: 'h1', data: { name: 'Bite' } }];
  const items = [{ id: 'i1', name: 'Bite', type: 'ability', key: 'a:bite', hash: 'h1' }, { id: 'i2', name: 'Bite', type: 'ability' }];
  assert.deepEqual(planAbilityItems(desired, items), { create: [], remove: ['i1'] });
});
