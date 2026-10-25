#!/usr/bin/env node
/**
 * Pins scripts/_monster-report.mjs: which actors and compendium entries go
 * into the monster report, how their numbers are read and labelled from the
 * system's creature fields, the cap, and the compendium list a fight row
 * falls back on.
 *
 * Run: `node --test tools/test-monster-report.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonsterReport, compendiumChoices, indexFields, monsterEntry, monsterPaths,
} from '../scripts/_monster-report.mjs';

const defs = {
  foundry_actor_type: 'npc',
  fields: [
    { key: 'level', foundry_path: 'system.monster.level' },
    { key: 'organization', foundry_path: 'system.monster.organization', foundry_choices: 'DS.orgs' },
    { key: 'role', foundry_path: 'system.monster.role', foundry_choices: 'DS.roles' },
    { key: 'ev', foundry_path: 'system.ev' },
    { key: 'stamina', foundry_path: 'system.stamina.max' },
  ],
};
const config = { 'DS.roles': { harrier: { label: 'Harrier' } }, 'DS.orgs': { horde: { label: 'Horde' } } };
const labelOf = (path, v) => config[path]?.[v]?.label ?? null;
const paths = monsterPaths(defs);
const npc = (name, extra = {}) => ({ name, type: 'npc', system: { monster: { level: 3, role: 'harrier', organization: 'horde' }, ev: 5 }, ...extra });

test('paths come from the creature fields a report carries, nothing else', () => {
  assert.deepEqual(Object.keys(paths).sort(), ['ev', 'level', 'organization', 'role']);
  assert.deepEqual(indexFields(paths), ['type', 'system.monster.level', 'system.monster.organization', 'system.monster.role', 'system.ev']);
  assert.deepEqual(monsterPaths(null), {});
});

test('an entry reads its numbers and labels its choices', () => {
  assert.deepEqual(monsterEntry(npc(' Stalker '), { paths, labelOf, pack: 'Monsters' }),
    { name: 'Stalker', pack: 'Monsters', level: '3', role: 'Harrier', organization: 'Horde', ev: '5' });
  // A value with no label stays as written; a list or object is left out.
  const odd = npc('Odd', { system: { monster: { level: 2, role: 'skirmisher', organization: ['x'] }, ev: { value: 4 } } });
  assert.deepEqual(monsterEntry(odd, { paths, labelOf, page: 'p7' }), { name: 'Odd', level: '2', role: 'skirmisher', linked: true, page: 'p7' });
});

test('the report lists world actors first, then compendium entries, of the creature type only', () => {
  const r = buildMonsterReport({
    actors: [{ doc: npc('Captain Vex'), page: '' }, { doc: { name: 'Ash', type: 'hero' }, page: '' }, { doc: npc('Goblin'), page: 'p1' }],
    packs: [{ label: 'Monsters', entries: [npc('Stalker'), { name: 'Sword', type: 'weapon' }, npc('')] }],
    actorType: 'npc', paths, labelOf,
  });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.monsters.map((m) => [m.name, m.pack ?? '', !!m.linked]), [['Captain Vex', '', false], ['Goblin', '', true], ['Stalker', 'Monsters', false]]);
});

test('past the cap the report is cut and says so', () => {
  const r = buildMonsterReport({ actors: [], packs: [{ label: 'M', entries: [npc('A'), npc('B'), npc('C')] }], actorType: 'npc', paths, labelOf, max: 2 });
  assert.deepEqual(r.monsters.map((m) => m.name), ['A', 'B']);
  assert.equal(r.truncated, true);
});

test('compendium choices keep the uuid a row is brought in by', () => {
  const packs = [{ label: 'Monsters', entries: [{ ...npc('Stalker'), uuid: 'Compendium.ds.monsters.Actor.a1' }, npc('No uuid'), { name: 'Sword', type: 'weapon', uuid: 'x' }] }];
  assert.deepEqual(compendiumChoices(packs, 'npc'), [{ name: 'Stalker', uuid: 'Compendium.ds.monsters.Actor.a1', pack: 'Monsters' }]);
});
