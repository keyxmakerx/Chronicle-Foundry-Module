#!/usr/bin/env node
/**
 * A Chronicle creature page as a Foundry NPC actor: the value conversions,
 * that Foundry-owned fields are never written, and that only they come back.
 *
 * Run: `node --test tools/test-creature-fields.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChoice, toFoundryValue, creatureUpdate, planCreatureApply, creaturePull, sendBackOn, changedPull, seedPull,
} from '../scripts/_creature-fields.mjs';

// Shaped like CONFIG.DRAW_STEEL.monsters after localization.
const CONFIG = {
  'DRAW_STEEL.monsters.organizations': { minion: { label: 'Minion' }, leader: { label: 'Leader' }, solo: { label: 'Solo' } },
  'DRAW_STEEL.monsters.roles': { brute: { label: 'Brute' }, controller: { label: 'Controller' } },
  'DRAW_STEEL.monsters.keywords': { goblin: { label: 'Goblin' }, humanoid: { label: 'Humanoid' }, elfHigh: { label: 'High Elf' }, giantFire: { label: 'Fire Giant' } },
};
const choicesFor = (path) => CONFIG[path] ?? null;

// The Draw Steel creature preset's mapped fields (Chronicle-Draw-Steel manifest).
const FIELDS = [
  { key: 'level', label: 'Level', type: 'number', foundry_path: 'system.monster.level' },
  { key: 'organization', label: 'Organization', type: 'string', foundry_path: 'system.monster.organization', foundry_choices: 'DRAW_STEEL.monsters.organizations' },
  { key: 'role', label: 'Role', type: 'string', foundry_path: 'system.monster.role', foundry_choices: 'DRAW_STEEL.monsters.roles' },
  { key: 'keywords', label: 'Keywords', type: 'string', foundry_path: 'system.monster.keywords', foundry_format: 'set', foundry_choices: 'DRAW_STEEL.monsters.keywords' },
  { key: 'ev', label: 'EV', type: 'number', foundry_path: 'system.ev' },
  { key: 'size', label: 'Size', type: 'string', foundry_path: 'system.combat.size', foundry_format: 'size' },
  { key: 'stamina', label: 'Stamina', type: 'number', foundry_path: 'system.stamina.max' },
  { key: 'stamina_current', label: 'Current Stamina', type: 'number', foundry_path: 'system.stamina.value' },
  { key: 'free_strike', label: 'Free Strike', type: 'string', foundry_path: 'system.monster.freeStrike', foundry_format: 'integer' },
  { key: 'might', label: 'Might', type: 'number', foundry_path: 'system.characteristics.might.value' },
  { key: 'faction', label: 'Faction', type: 'string' },
  { key: 'conditions_json', label: 'Conditions Data', type: 'string', foundry_path: 'statuses' },
];
const PULL = ['stamina_current', 'conditions_json'];

test('resolveChoice matches a key or a label, never a guess', async (t) => {
  const kw = CONFIG['DRAW_STEEL.monsters.keywords'];
  const cases = [
    ['key, any case', 'GOBLIN', 'goblin'],
    ['label', 'High Elf', 'elfHigh'],
    ['two words as camelCase key', 'giant fire', 'giantFire'],
    ['label with spacing', '  fire giant ', 'giantFire'],
    ['unknown', 'Psionic', null],
    ['empty', '', null],
    ['null', null, null],
  ];
  for (const [name, value, want] of cases) await t.test(name, () => assert.equal(resolveChoice(value, kw), want));
  assert.equal(resolveChoice('Goblin', null), null);
});

test('toFoundryValue converts by format and choices', async (t) => {
  const f = Object.fromEntries(FIELDS.map((x) => [x.key, x]));
  const cases = [
    ['organization label to key', f.organization, 'Leader', { value: 'leader' }],
    ['swarm is no Foundry organization', f.organization, 'Swarm', { skip: 'no DRAW_STEEL.monsters.organizations entry for "Swarm"', unknown: ['Swarm'] }],
    ['keywords to a set of keys', f.keywords, 'Goblin, Humanoid', { value: ['goblin', 'humanoid'] }],
    ['unknown keywords are reported, known kept', f.keywords, 'Goblin, Psionic', { value: ['goblin'], unknown: ['Psionic'] }],
    ['duplicate keywords once', f.keywords, 'goblin, Goblin', { value: ['goblin'] }],
    ['free strike text to a number', f.free_strike, '5 damage', { value: 5 }],
    ['free strike number', f.free_strike, 7, { value: 7 }],
    ['free strike without a number', f.free_strike, 'varies', { skip: 'not a number' }],
    ['size with a letter', f.size, '1S', { value: { value: 1, letter: 'S' } }],
    ['bigger size has no letter', f.size, '2L', { value: { value: 2 } }],
    ['bad size', f.size, 'huge', { skip: 'not a size' }],
    ['number field', f.level, '4', { value: 4 }],
    ['empty value', f.level, '', { skip: 'empty' }],
  ];
  for (const [name, field, raw, want] of cases) await t.test(name, () => assert.deepEqual(toFoundryValue(field, raw, choicesFor), want));
});

test('a format this module does not know is skipped', () => {
  const out = toFoundryValue({ key: 'x', foundry_path: 'system.x', foundry_format: 'dice' }, '2d6', choicesFor);
  assert.deepEqual(out, { skip: 'unknown format dice' });
});

test('choices the system lacks skip the field', () => {
  const out = toFoundryValue({ key: 'x', foundry_path: 'system.x', foundry_choices: 'OTHER.list' }, 'a', choicesFor);
  assert.equal(out.skip, 'no OTHER.list in this system');
});

const ENTITY = {
  name: 'Skrix Webrider',
  fields_data: {
    level: 4, organization: 'Leader', role: '', keywords: 'Goblin, Humanoid, Psionic', ev: 24, size: '1S',
    stamina: 140, stamina_current: 90, free_strike: '6 damage', might: 2, faction: 'Raiders', conditions_json: '["prone"]',
  },
};

test('creatureUpdate writes the stat block and never the Foundry-owned fields', () => {
  const { update, unknown } = creatureUpdate({ entity: ENTITY, fields: FIELDS, pullKeys: PULL, choicesFor });
  assert.deepEqual(update, {
    'system.monster.level': 4,
    'system.monster.organization': 'leader',
    'system.monster.keywords': ['goblin', 'humanoid'],
    'system.ev': 24,
    'system.combat.size': { value: 1, letter: 'S' },
    'system.stamina.max': 140,
    'system.monster.freeStrike': 6,
    'system.characteristics.might.value': 2,
    name: 'Skrix Webrider',
  });
  assert.deepEqual(unknown, ['Keywords: Psionic']);
  assert.ok(!('system.stamina.value' in update), 'current Stamina belongs to Foundry');
  assert.ok(!('statuses' in update), 'conditions belong to Foundry');
});

test('without pull fields every mapped field is written', () => {
  const { update } = creatureUpdate({ entity: ENTITY, fields: FIELDS, pullKeys: [], choicesFor });
  assert.equal(update['system.stamina.value'], 90);
});

test('planCreatureApply writes only what differs, sets compared as sets', () => {
  const actor = {
    name: 'Skrix Webrider',
    system: { monster: { level: 4, keywords: new Set(['humanoid', 'goblin']) }, combat: { size: { value: 1, letter: 'S' } }, ev: 20 },
  };
  const changes = planCreatureApply({
    actor,
    update: {
      name: 'Skrix Webrider',
      'system.monster.level': 4,
      'system.monster.keywords': ['goblin', 'humanoid'],
      'system.combat.size': { value: 1, letter: 'S' },
      'system.ev': 24,
    },
  });
  assert.deepEqual(changes, { 'system.ev': 24 });
});

test('creaturePull sends back only the Foundry-owned fields', () => {
  const actor = {
    system: { stamina: { value: 72, max: 140 }, monster: { level: 9 } },
    statuses: new Set(['prone', 'dazed']),
  };
  assert.deepEqual(creaturePull(actor, FIELDS, PULL), { stamina_current: 72, conditions_json: '["dazed","prone"]' });
  assert.deepEqual(creaturePull(actor, FIELDS, []), {});
});

test('a path the actor lacks is left out, never sent as a clear', () => {
  assert.deepEqual(creaturePull({ system: { stamina: { value: 5 } } }, FIELDS, PULL), { stamina_current: 5 });
});

test('changedPull sends only what differs from what Chronicle has', async (t) => {
  const pulled = { stamina_current: 72, conditions_json: '["prone"]' };
  const cases = [
    ['condition added only', { stamina_current: 72, conditions_json: '[]' }, { conditions_json: '["prone"]' }],
    ['nothing new', { stamina_current: 72, conditions_json: '["prone"]' }, {}],
    ['nothing known yet', undefined, pulled],
  ];
  for (const [name, known, want] of cases) await t.test(name, () => assert.deepEqual(changedPull(pulled, known), want));
});

test('a new actor starts from the page\'s current Stamina, not the default', () => {
  const seed = seedPull({ entity: ENTITY, fields: FIELDS, pullKeys: PULL, choicesFor });
  assert.deepEqual(seed, { 'system.stamina.value': 90 }, 'statuses are not seeded');
  assert.deepEqual(seedPull({ entity: ENTITY, fields: FIELDS, pullKeys: PULL, choicesFor, onlyKeys: ['conditions_json'] }), {});
});

test('sending back is off unless the director turned it on', async (t) => {
  const cases = [
    ['no state', null, false],
    ['public half only', { public: { sendBack: true } }, false],
    ['gm off', { gm: { sendBack: false } }, false],
    ['gm on', { gm: { sendBack: true } }, true],
    ['truthy but not true', { gm: { sendBack: 'yes' } }, false],
  ];
  for (const [name, state, want] of cases) await t.test(name, () => assert.equal(sendBackOn(state), want));
});
