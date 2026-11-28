#!/usr/bin/env node
/**
 * A campaign entry's own ability (a homemade kit's signature ability) as a
 * Draw Steel hero ability item: the power roll names the characteristics, the
 * damage adds the one rolled, and only the items sync made are ever replaced
 * or removed when the kit or its ability changes.
 *
 * Run: `node --test tools/test-entry-abilities.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_ABILITY_FLAG, ENTRY_ABILITY_HASH, entryAbilities, rollCharacteristics, heroTierText,
  heroAbilityItem, planEntryAbilities, entryListItems,
} from '../scripts/_entry-abilities.mjs';
import { fingerprint } from '../scripts/_creature-abilities.mjs';

const SCOPE = 'chronicle-sync';

// Foundry's cleaner, standing in: drops <script>, keeps the rest.
globalThis.foundry = { applications: { ux: { TextEditor: { cleanHTML: (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '') } } } };

// The kit example from Chronicle's AI guide for campaign entries.
const BURNING_SHOT = {
  name: 'Burning Shot', flavor: 'The arrow catches light as it leaves the string.', type: 'signature',
  action_type: 'Main action', keywords: ['Magic', 'Ranged', 'Strike', 'Weapon'], distance: 'Ranged 10',
  target: 'One creature', power_roll: 'Agility or Reason',
  tier1: '3 + A or R fire damage', tier2: '5 + A or R fire damage', tier3: '8 + A or R fire damage; A < 2 burning (save ends)',
  effect: 'The target sheds light until the end of your next turn.',
};
const KIT = { name: 'Ember Archer', properties: { stamina_bonus: 3, signature_ability: BURNING_SHOT } };

const KNOWN = {
  keywords: ['magic', 'ranged', 'strike', 'weapon', 'melee'],
  damageTypes: ['acid', 'cold', 'corruption', 'fire', 'holy', 'lightning', 'poison', 'psychic', 'sonic'],
  conditions: ['bleeding', 'dazed', 'frightened', 'grabbed', 'prone', 'restrained', 'slowed', 'taunted', 'weakened'],
  types: ['main', 'maneuver', 'triggered', 'freeTriggered', 'freeManeuver', 'move', 'none', 'villain'],
};
const FIELDS = [{ fieldKey: 'kit', itemType: 'kit' }];
const kitItem = (name, made = true) => ({ id: `kit-${name}`, name, type: 'kit', flags: made ? { [SCOPE]: { chronicleMade: true } } : {} });

test('an entry\'s abilities are its named object properties', () => {
  const found = entryAbilities({ properties: { a: 1, sig: { name: 'X' }, list: [{ name: 'Y' }], blank: { name: ' ' }, other: { power: 2 } } });
  assert.deepEqual(found.map((f) => f.prop), ['sig']);
  assert.deepEqual(entryAbilities(null), []);
});

test('a power roll that names characteristics is the system\'s roll', () => {
  assert.deepEqual(rollCharacteristics('Agility or Reason'), ['agility', 'reason']);
  assert.deepEqual(rollCharacteristics('Might, Agility, or Presence'), ['might', 'agility', 'presence']);
  assert.deepEqual(rollCharacteristics('Might'), ['might']);
  assert.equal(rollCharacteristics('2d10 + 2'), null);
  assert.equal(rollCharacteristics('Might or Luck'), null);
  assert.equal(rollCharacteristics(''), null);
});

test('a tier\'s characteristic letters become the rolled characteristic', () => {
  assert.equal(heroTierText('3 + A or R fire damage'), '3 + @chr fire damage');
  assert.equal(heroTierText('2 + M damage; push 1'), '2 + @chr damage; push 1');
  assert.equal(heroTierText('6 + M, A, or P damage'), '6 + @chr damage');
  assert.equal(heroTierText('4 damage'), '4 damage');
  assert.equal(heroTierText(undefined), '');
});

test('Burning Shot becomes a rollable signature ability', () => {
  const key = 'kit:ember archer:signature_ability';
  const item = heroAbilityItem(BURNING_SHOT, { known: KNOWN, key, hash: 'h1' });
  assert.equal(item.name, 'Burning Shot');
  assert.equal(item.type, 'ability');
  assert.equal(item.system.type, 'main');
  assert.equal(item.system.category, 'signature');
  assert.deepEqual(item.system.keywords, ['magic', 'ranged', 'strike', 'weapon']);
  assert.deepEqual(item.system.power.roll, { formula: '@chr', characteristics: ['agility', 'reason'], reactive: false });
  assert.equal(item.system.distance.type, 'ranged');
  const damage = Object.values(item.system.power.effects).find((e) => e.type === 'damage');
  assert.deepEqual(['tier1', 'tier2', 'tier3'].map((t) => damage.damage[t].value), ['3 + @chr', '5 + @chr', '8 + @chr']);
  assert.deepEqual(damage.damage.tier1.types, ['fire']);
  // "burning" is no condition the system knows, so it stays as the tier's words.
  const other = Object.values(item.system.power.effects).find((e) => e.type === 'other');
  assert.match(other.other.tier3.display, /A < 2 burning \(save ends\)/);
  // The roll is the system's, so it is not repeated above the tiers.
  assert.equal(item.system.effects.before0000000000, undefined);
  assert.match(item.system.effects.after00000000000.description, /sheds light/);
  assert.deepEqual(item.flags, { [SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: key, [ENTRY_ABILITY_HASH]: 'h1' } });
});

test('a heroic ability takes its cost as the resource it spends', () => {
  const item = heroAbilityItem({ name: 'Blaze', action_type: 'Maneuver', cost: '5 Focus', power_roll: 'Reason' }, { known: KNOWN, key: 'k', hash: 'h' });
  assert.equal(item.system.type, 'maneuver');
  assert.equal(item.system.category, 'heroic');
  assert.equal(item.system.resource, 5);
  const free = heroAbilityItem({ name: 'Free', cost: 0 }, { known: KNOWN, key: 'k', hash: 'h' });
  assert.equal(free.system.category, '');
  assert.equal(free.system.resource, undefined);
});

test('a roll in other words stays above the tiers', () => {
  const item = heroAbilityItem({ name: 'Odd', power_roll: 'Might or the higher of your allies', tier1: '2 damage' }, { known: KNOWN, key: 'k', hash: 'h' });
  assert.match(item.system.effects.before0000000000.description, /Power roll: Might or the higher/);
  assert.deepEqual(item.system.power.roll.characteristics, []);
});

test('an action the system lacks falls back to its no-action type', () => {
  const item = heroAbilityItem({ name: 'Move', action_type: 'Move action' }, { known: { ...KNOWN, types: ['main', 'none'] }, key: 'k', hash: 'h' });
  assert.equal(item.system.type, 'none');
});

test('a kit sync made gives the hero its ability once', () => {
  const plan = planEntryAbilities({ items: [kitItem('Ember Archer')], fields: FIELDS, entriesByField: { kit: [KIT] }, known: KNOWN });
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].flags[SCOPE][ENTRY_ABILITY_FLAG], 'kit:ember archer:signature_ability');
  assert.deepEqual(plan.remove, []);
});

test('an unchanged ability is left alone; an edited one is replaced', () => {
  const key = 'kit:ember archer:signature_ability';
  const made = { id: 'ab1', name: 'Burning Shot', type: 'ability', flags: { [SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: key, [ENTRY_ABILITY_HASH]: fingerprint(BURNING_SHOT) } } };
  const same = planEntryAbilities({ items: [kitItem('Ember Archer'), made], fields: FIELDS, entriesByField: { kit: [KIT] }, known: KNOWN });
  assert.deepEqual(same, { create: [], remove: [] });
  const edited = { ...KIT, properties: { ...KIT.properties, signature_ability: { ...BURNING_SHOT, tier1: '4 + A or R fire damage' } } };
  const plan = planEntryAbilities({ items: [kitItem('Ember Archer'), made], fields: FIELDS, entriesByField: { kit: [edited] }, known: KNOWN });
  assert.deepEqual(plan.remove, ['ab1']);
  assert.equal(plan.create.length, 1);
});

test('swapping the kit takes its ability with it', () => {
  const made = { id: 'ab1', name: 'Burning Shot', type: 'ability', flags: { [SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: 'kit:ember archer:signature_ability', [ENTRY_ABILITY_HASH]: 'x' } } };
  const plan = planEntryAbilities({ items: [kitItem('Ember Archer', false), made], fields: FIELDS, entriesByField: { kit: [KIT] }, known: KNOWN });
  assert.deepEqual(plan, { create: [], remove: ['ab1'] });
});

test('only fields whose entries were read are touched', () => {
  const made = { id: 'ab1', name: 'Burning Shot', type: 'ability', flags: { [SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: 'kit:ember archer:signature_ability', [ENTRY_ABILITY_HASH]: 'x' } } };
  const plan = planEntryAbilities({ items: [kitItem('Ember Archer'), made], fields: FIELDS, entriesByField: {}, known: KNOWN });
  assert.deepEqual(plan, { create: [], remove: [] });
});

test('the GM\'s own ability under the same name wins; a creature ability never counts as theirs', () => {
  const gm = { id: 'gm1', name: 'burning shot', type: 'ability', flags: {} };
  const own = planEntryAbilities({ items: [kitItem('Ember Archer'), gm], fields: FIELDS, entriesByField: { kit: [KIT] }, known: KNOWN });
  assert.deepEqual(own, { create: [], remove: [] });
  const creature = { id: 'c1', name: 'Burning Shot', type: 'ability', flags: { [SCOPE]: { creatureAbility: 'abilities_json:burning shot' } } };
  const plan = planEntryAbilities({ items: [kitItem('Ember Archer'), creature], fields: FIELDS, entriesByField: { kit: [KIT] }, known: KNOWN });
  assert.equal(plan.create.length, 1);
  assert.deepEqual(plan.remove, []);
});

// A campaign's own ancestry: its signature traits become feature items.
const ANCESTRY = {
  name: 'Dryad',
  properties: {
    size: '1S',
    signature_traits: [
      { name: 'Barkskin', description: 'Your **skin** is bark.<script>x()</script>' },
      { name: 'Rooted', description: 'You can\'t be {@movement pushed|pushed} while standing on soil.' },
      { description: 'nameless' },
    ],
  },
};
const ANC_FIELDS = [{ fieldKey: 'ancestry', itemType: 'ancestry' }];
const ITEMS_MAP = { ancestry: { signature_traits: { type: 'feature' } } };
const WITH_TYPES = { ...KNOWN, itemTypes: ['ability', 'ancestry', 'feature', 'kit'] };
const ancestryItem = (made = true) => ({ id: 'anc', name: 'Dryad', type: 'ancestry', flags: made ? { [SCOPE]: { chronicleMade: true } } : {} });
const traitPlan = (items, extra = {}) => planEntryAbilities({
  items, fields: ANC_FIELDS, entriesByField: { ancestry: [ANCESTRY] }, known: WITH_TYPES, entryItemsByField: ITEMS_MAP, ...extra,
});

test('a list property the system maps gives one item per named object', () => {
  const found = entryListItems(ANCESTRY, ITEMS_MAP.ancestry, WITH_TYPES.itemTypes);
  assert.deepEqual(found.map((f) => [f.prop, f.type, f.item.name]), [['signature_traits', 'feature', 'Barkskin'], ['signature_traits', 'feature', 'Rooted']]);
  assert.deepEqual(entryListItems(ANCESTRY, { signature_traits: { type: 'spell' } }, WITH_TYPES.itemTypes), [], 'a type the system lacks makes nothing');
  assert.deepEqual(entryListItems(ANCESTRY, ITEMS_MAP.ancestry, null), [], 'unknown types make nothing');
  assert.deepEqual(entryListItems(ANCESTRY, { size: { type: 'feature' } }, WITH_TYPES.itemTypes), [], 'only a list');
});

test('a list item never takes a type an identity field syncs', () => {
  assert.deepEqual(entryListItems(ANCESTRY, { signature_traits: { type: 'kit' } }, WITH_TYPES.itemTypes, ['kit']), []);
  const own = traitPlan([ancestryItem()], { entryItemsByField: { ancestry: { signature_traits: { type: 'ancestry' } } } });
  assert.deepEqual(own.create, [], 'the field being planned is an identity field');
  const other = traitPlan([ancestryItem()], { entryItemsByField: { ancestry: { signature_traits: { type: 'kit' } } }, identityTypes: ['ancestry', 'kit'] });
  assert.deepEqual(other.create, [], 'nor one another identity field syncs, though it is not planned now');
});

test('two list objects whose names match give one item, the first', () => {
  const twins = { name: 'Dryad', properties: { signature_traits: [{ name: 'Barkskin', description: 'one' }, { name: ' barkskin ', description: 'two' }] } };
  const found = entryListItems(twins, ITEMS_MAP.ancestry, WITH_TYPES.itemTypes);
  assert.deepEqual(found.map((f) => f.item.description), ['one']);
});

test('a made ancestry gives its signature traits as features, cleaned and flagged', () => {
  const plan = traitPlan([ancestryItem()]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.create.map((c) => [c.type, c.name]), [['feature', 'Barkskin'], ['feature', 'Rooted']]);
  const [bark, rooted] = plan.create;
  assert.equal(bark.system.description.value, '<p>Your <strong>skin</strong> is bark.&lt;script&gt;x()&lt;/script&gt;</p>', 'Markdown, with raw markup shown as text');
  assert.match(rooted.system.description.value, /be pushed while/, 'rule markers read as words');
  assert.deepEqual(bark.flags[SCOPE], { chronicleMade: true, [ENTRY_ABILITY_FLAG]: 'ancestry:dryad:signature_traits:barkskin', [ENTRY_ABILITY_HASH]: fingerprint(ANCESTRY.properties.signature_traits[0]) });
});

test('traits follow the entry: unchanged left alone, edited rebuilt, dropped or swapped away removed', () => {
  const made = (name, hash) => ({ id: `t-${name}`, name, type: 'feature', flags: { [SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: `ancestry:dryad:signature_traits:${name.toLowerCase()}`, [ENTRY_ABILITY_HASH]: hash } } });
  const bark = made('Barkskin', fingerprint(ANCESTRY.properties.signature_traits[0]));
  const rooted = made('Rooted', 'old');
  const plan = traitPlan([ancestryItem(), bark, rooted]);
  assert.deepEqual(plan.remove, ['t-Rooted']);
  assert.deepEqual(plan.create.map((c) => c.name), ['Rooted']);
  const dropped = traitPlan([ancestryItem(), bark], { entriesByField: { ancestry: [{ ...ANCESTRY, properties: { signature_traits: [] } }] } });
  assert.deepEqual(dropped, { create: [], remove: ['t-Barkskin'] });
  assert.deepEqual(traitPlan([ancestryItem(false), bark]), { create: [], remove: ['t-Barkskin'] }, 'a swapped-in printed ancestry takes them away');
});

test('the GM\'s own feature of that name wins; their ability of that name does not count', () => {
  const gmFeature = { id: 'gm', name: 'barkskin', type: 'feature', flags: {} };
  assert.deepEqual(traitPlan([ancestryItem(), gmFeature]).create.map((c) => c.name), ['Rooted']);
  const gmAbility = { id: 'gm', name: 'Barkskin', type: 'ability', flags: {} };
  assert.deepEqual(traitPlan([ancestryItem(), gmAbility]).create.map((c) => c.name), ['Barkskin', 'Rooted']);
});

test('a trait whose text still holds GM-only content is not made', () => {
  const secret = { ...ANCESTRY, properties: { signature_traits: [{ name: 'Hidden', description: '<span data-secret>x</span>' }] } };
  assert.deepEqual(traitPlan([ancestryItem()], { entriesByField: { ancestry: [secret] } }).create, []);
});
