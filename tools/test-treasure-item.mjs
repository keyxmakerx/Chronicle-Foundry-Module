#!/usr/bin/env node
/**
 * A Chronicle item page as a Draw Steel treasure: category, kind, echelon,
 * keywords, project and words land on the treasure's own paths; a value with
 * no Draw Steel equivalent is left out and reported; a page players cannot
 * open gives its name only; and an empty value stays empty.
 *
 * The CONFIG keys below are the Draw Steel system's
 * (CONFIG.DRAW_STEEL.equipment, .characteristics), copied rather than
 * fetched; when the system changes them, update this file to match.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  treasureUpdate, treasureKeyword, splitList, soleInteger, textHtml, treasureSignature, expandPaths,
} from '../scripts/_treasure-item.mjs';

const keys = (...ks) => Object.fromEntries(ks.map((k) => [k, { label: `DRAW_STEEL.${k}` }]));
const CONFIG = {
  DRAW_STEEL: {
    equipment: {
      keywords: keys('magic', 'psionic'),
      categories: keys('consumable', 'trinket', 'leveled', 'artifact'),
      kinds: keys('other', 'armor', 'implement', 'weapon'),
      armor: keys('none', 'light', 'medium', 'heavy', 'shield'),
      weapon: keys('none', 'bow', 'ensnaring', 'heavy', 'light', 'medium', 'polearm', 'unarmed', 'whip'),
      implement: keys('implement', 'orb', 'wand'),
      other: keys('arms', 'feet', 'hands', 'head', 'neck', 'ring', 'waist'),
      consumables: keys('oil', 'potion', 'scroll'),
    },
    characteristics: keys('might', 'agility', 'reason', 'intuition', 'presence'),
  },
};
const choicesFor = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), CONFIG) ?? null;

// The Draw Steel Item preset's fields, as GET /systems/drawsteel/item-fields serves them.
const FIELDS = [
  { key: 'type', label: 'Type', foundry_path: 'system.category', foundry_choices: 'DRAW_STEEL.equipment.categories' },
  { key: 'kind', label: 'Kind', foundry_path: 'system.kind', foundry_choices: 'DRAW_STEEL.equipment.kinds' },
  { key: 'echelon', label: 'Echelon', foundry_path: 'system.echelon', foundry_format: 'integer' },
  { key: 'keywords', label: 'Keywords', foundry_path: 'system.keywords', foundry_format: 'treasure_keywords', foundry_choices: 'DRAW_STEEL.equipment' },
  { key: 'effect', label: 'Effect', foundry_path: 'system.description.value', foundry_format: 'html_section' },
  { key: 'level_1', label: '1st level', foundry_path: 'system.description.value', foundry_format: 'html_section' },
  { key: 'level_5', label: '5th level', foundry_path: 'system.description.value', foundry_format: 'html_section' },
  { key: 'level_9', label: '9th level', foundry_path: 'system.description.value', foundry_format: 'html_section' },
  { key: 'item_prerequisite', label: 'Needs', foundry_path: 'system.project.prerequisites' },
  { key: 'project_source', label: 'Lore from', foundry_path: 'system.project.source' },
  { key: 'project_roll_characteristic', label: 'Project roll', foundry_path: 'system.project.rollCharacteristic', foundry_format: 'set', foundry_choices: 'DRAW_STEEL.characteristics' },
  { key: 'project_goal', label: 'Project goal', foundry_path: 'system.project.goal', foundry_format: 'integer' },
  { key: 'book_source', label: 'Copied from' },
];

const page = (fields_data) => ({ id: 'e1', name: 'Test blade', fields_data });

test('a leveled weapon fills every treasure path', () => {
  const { update, unknown } = treasureUpdate({
    entity: page({
      type: 'Leveled', kind: 'Weapon', echelon: '2nd', keywords: 'Magic, Medium Weapon',
      effect: 'Hums when drawn.', level_1: 'Line one\nline two', level_5: '', level_9: 'Strikes {@condition taunted|taunt} foes.',
      item_prerequisite: 'A rare ore', project_source: 'Texts in an old tongue',
      project_roll_characteristic: 'Might, Reason, or Intuition', project_goal: '450',
      book_source: 'Somewhere only the Director knows',
    }),
    fields: FIELDS, choicesFor, showWords: true,
  });
  assert.deepEqual(unknown, []);
  assert.equal(update['system.category'], 'leveled');
  assert.equal(update['system.kind'], 'weapon');
  assert.equal(update['system.echelon'], 2);
  assert.deepEqual(update['system.keywords'], ['magic', 'medium']);
  assert.deepEqual(update['system.project.rollCharacteristic'], ['might', 'reason', 'intuition']);
  assert.equal(update['system.project.goal'], 450);
  assert.equal(update['system.project.prerequisites'], 'A rare ore');
  assert.equal(update['system.project.source'], 'Texts in an old tongue');
  assert.equal(update['system.description.value'],
    '<h4>Effect</h4><p>Hums when drawn.</p><h4>1st level</h4><p>Line one<br>line two</p><h4>9th level</h4><p>Strikes taunt foes.</p>');
  assert.ok(!JSON.stringify(update).includes('Director knows'), 'a field with no Foundry path never goes to Foundry');
});

test('keywords resolve by the item\'s kind and category, as the treasure sheet lists them', () => {
  const eq = CONFIG.DRAW_STEEL.equipment;
  const cases = [
    ['Psionic', null, null, 'psionic'],
    ['Light Armor', null, 'armor', 'light'],
    ['Heavy Weapon', null, 'weapon', 'heavy'],
    ['Light', null, 'armor', 'light'],
    ['Shield', null, 'armor', 'shield'],
    ['Potion', 'consumable', null, 'potion'],
    ['Ring', 'trinket', 'other', 'ring'],
    ['Implement', 'leveled', 'implement', 'implement'],
    ['Whip', 'leveled', 'weapon', 'whip'],
    ['Net', 'leveled', 'weapon', null],
    ['', null, null, null],
  ];
  for (const [word, category, kind, want] of cases) {
    assert.equal(treasureKeyword(word, eq, category, kind), want, `${word} (${category}/${kind})`);
  }
});

test('a value with no Draw Steel equivalent is left out and reported, never guessed', () => {
  const { update, unknown } = treasureUpdate({
    entity: page({ type: 'Wondrous', kind: 'Weapon', keywords: 'Magic; Net', project_goal: '30 or 45', echelon: 'Late' }),
    fields: FIELDS, choicesFor, showWords: true,
  });
  assert.equal('system.category' in update, false);
  assert.deepEqual(update['system.keywords'], ['magic']);
  assert.equal('system.project.goal' in update, false);
  assert.equal('system.echelon' in update, false);
  assert.deepEqual(unknown.sort(), ['Echelon: Late', 'Keywords: Net', 'Project goal: 30 or 45', 'Type: Wondrous']);
});

test('new fields start empty: a page with nothing filled in sets nothing', () => {
  assert.deepEqual(treasureUpdate({ entity: page({}), fields: FIELDS, choicesFor, showWords: true }).update, {});
  assert.deepEqual(treasureUpdate({ entity: { name: 'x' }, fields: FIELDS, choicesFor, showWords: true }).update, {});
});

test('a page players cannot open gives its name only', () => {
  const entity = page({ type: 'Artifact', effect: 'A secret power.' });
  assert.deepEqual(treasureUpdate({ entity, fields: FIELDS, choicesFor, showWords: false }).update, {});
  // Rewriting an item made earlier empties what it had.
  const cleared = treasureUpdate({ entity, fields: FIELDS, choicesFor, showWords: false, clear: true }).update;
  assert.equal(cleared['system.description.value'], '');
  assert.equal(cleared['system.category'], '');
  assert.deepEqual(cleared['system.keywords'], []);
  assert.equal(cleared['system.echelon'], null);
});

test('clear empties only what the page lacks', () => {
  const { update } = treasureUpdate({ entity: page({ type: 'Trinket', keywords: 'Head' }), fields: FIELDS, choicesFor, showWords: true, clear: true });
  assert.equal(update['system.category'], 'trinket');
  assert.deepEqual(update['system.keywords'], ['head']);
  assert.equal(update['system.kind'], '');
  assert.equal(update['system.description.value'], '');
  assert.deepEqual(update['system.project.rollCharacteristic'], []);
  assert.equal(update['system.project.goal'], null);
});

test('words are escaped, so nothing in a field is read as markup', () => {
  assert.equal(textHtml('<script>x</script> & "q"'), '<p>&lt;script&gt;x&lt;/script&gt; &amp; &quot;q&quot;</p>');
  assert.equal(textHtml('one\n\ntwo'), '<p>one</p><p>two</p>');
  assert.equal(textHtml('   '), '');
});

test('helpers', () => {
  assert.deepEqual(splitList('Agility or Intuition'), ['Agility', 'Intuition']);
  assert.deepEqual(splitList(['Might', ' ']), ['Might']);
  assert.equal(soleInteger('45 (yields 1d3 darts)'), 45);
  assert.equal(soleInteger('450 1st Level: more text'), null);
  assert.equal(soleInteger(12), 12);
  assert.equal(treasureSignature({ b: 1, a: [2] }), treasureSignature({ a: [2], b: 1 }));
  assert.deepEqual(expandPaths({ 'system.category': 'leveled', 'system.project.goal': 45 }),
    { system: { category: 'leveled', project: { goal: 45 } } });
});
