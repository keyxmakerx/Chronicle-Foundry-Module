/**
 * The abilities a campaign's own entry gives the hero (a homemade kit's
 * signature ability), as Draw Steel ability items. PURE: no Foundry globals.
 *
 * Chronicle keeps such an ability as an object of named text parts, the shape
 * a package kit gives its `signature_ability`, and checks it on save
 * (Chronicle `internal/systems/entry_ability.go`). Each one becomes an
 * ability item beside the item sync made for the entry, flagged with the
 * entry and part it came from and a fingerprint of the ability: an edit in
 * Chronicle replaces it, and it goes when its kit goes. The text conversion
 * is the creature one (`_creature-abilities.mjs`), with a hero's power roll:
 * the characteristics it names, and "3 + A or R" damage read as `3 + @chr`.
 * `tools/test-entry-abilities.mjs`.
 */
import { FLAG_SCOPE } from './constants.mjs';
import { abilityItem, fingerprint, plainText, planAbilityItems } from './_creature-abilities.mjs';

/** Item flag naming the entry ability an item was made from: `field:entry name:part`. */
export const ENTRY_ABILITY_FLAG = 'entryAbility';
/** Item flag holding that ability's fingerprint, to notice an edit. */
export const ENTRY_ABILITY_HASH = 'entryAbilityHash';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const CHARACTERISTICS = ['might', 'agility', 'reason', 'intuition', 'presence'];
// The book's action names, as the system's ability types.
const ACTIONS = {
  'main action': 'main', action: 'main', maneuver: 'maneuver', 'triggered action': 'triggered', triggered: 'triggered',
  'free triggered action': 'freeTriggered', 'free triggered': 'freeTriggered', 'free maneuver': 'freeManeuver',
  'move action': 'move', 'no action': 'none',
};
const TIERS = ['tier1', 'tier2', 'tier3'];

/**
 * The abilities an entry holds: each property that is an object with a name.
 * @param {object} entry - one `GET /system-entries` row
 * @returns {Array<{prop: string, ability: object}>}
 */
export function entryAbilities(entry) {
  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  return Object.keys(props).sort()
    .filter((k) => { const v = props[k]; return v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && v.name.trim(); })
    .map((prop) => ({ prop, ability: props[prop] }));
}

/** "Agility, Reason, or Presence" → ['agility', 'reason', 'presence']; null when a word isn't one. */
export function rollCharacteristics(text) {
  const words = plainText(text).split(/\s*,\s*(?:or\s+)?|\s+or\s+/i).map(norm).filter(Boolean);
  if (!words.length) return null;
  const out = [];
  for (const w of words) {
    if (!CHARACTERISTICS.includes(w)) return null;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** "3 + A or R fire damage" → "3 + @chr fire damage": the system adds the characteristic rolled. */
export function heroTierText(text) {
  return String(text ?? '').replace(/^(\s*\d+)\s*\+\s*[MARIP](?:\s*,?\s*(?:or\s+)?[MARIP])*(?=\s)/, '$1 + @chr');
}

/**
 * One entry ability as Draw Steel ability item data.
 * @param {object} ability
 * @param {{known?: object, key: string, hash: string}} opts - `known` lists the system's keywords, damage types, conditions and ability types
 */
export function heroAbilityItem(ability, { known = {}, key, hash }) {
  const chars = rollCharacteristics(ability.power_roll);
  const tiers = Object.fromEntries(TIERS.map((t) => [t, heroTierText(ability[t])]));
  // A roll that names only characteristics is the system's; any other wording stays above the tiers.
  const data = abilityItem({ ...ability, ...tiers, power_roll: chars ? '' : ability.power_roll }, { known, key, hash, flagScope: FLAG_SCOPE });
  if (chars) data.system.power.roll = { formula: '@chr', characteristics: chars, reactive: false };
  let type = ACTIONS[norm(ability.action_type)] ?? data.system.type;
  if (Array.isArray(known.types) && !known.types.includes(type)) type = known.types.includes('none') ? 'none' : data.system.type;
  data.system.type = type;
  const cost = typeof ability.cost === 'number' ? ability.cost : Number.parseInt(String(ability.cost ?? ''), 10);
  data.system.category = norm(ability.type) === 'signature' ? 'signature' : Number.isInteger(cost) && cost > 0 ? 'heroic' : '';
  if (Number.isInteger(cost) && cost > 0) data.system.resource = cost;
  data.flags = { [FLAG_SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: key, [ENTRY_ABILITY_HASH]: hash } };
  return data;
}

/**
 * The ability items to make and remove on an actor so the abilities match
 * the entries of the items sync made from campaign entries. Only fields
 * whose entries were read are planned; a field's made abilities go when its
 * item is no longer one sync made (the kit was swapped) or its entry no
 * longer holds them. An ability the GM put on the actor under the same name
 * wins, as with creatures.
 * @param {object} args
 * @param {Array<{id: string, name: string, type: string, flags?: object}>} args.items
 * @param {Array<{fieldKey: string, itemType: string}>} args.fields - identity fields
 * @param {Record<string, Array<object>>} args.entriesByField - only the fields read
 * @param {object} [args.known]
 * @returns {{create: object[], remove: string[]}}
 */
export function planEntryAbilities({ items, fields, entriesByField, known = {} }) {
  const list = Array.isArray(items) ? items : [];
  const read = (fields ?? []).filter((f) => Array.isArray(entriesByField?.[f.fieldKey]));
  const desired = [];
  for (const { fieldKey, itemType } of read) {
    for (const it of list.filter((i) => i?.type === itemType && i.flags?.[FLAG_SCOPE]?.chronicleMade)) {
      const entry = entriesByField[fieldKey].find((e) => e && norm(e.name) === norm(it.name));
      for (const { prop, ability } of entryAbilities(entry)) {
        const key = `${fieldKey}:${norm(it.name)}:${prop}`;
        const hash = fingerprint(ability);
        desired.push({ key, hash, data: heroAbilityItem(ability, { known, key, hash }) });
      }
    }
  }
  const prefixes = read.map((f) => `${f.fieldKey}:`);
  const mine = list.map((i) => ({
    id: i.id, name: i.name ?? '', type: i.type,
    key: i.flags?.[FLAG_SCOPE]?.[ENTRY_ABILITY_FLAG] ?? null,
    hash: i.flags?.[FLAG_SCOPE]?.[ENTRY_ABILITY_HASH] ?? null,
  })).filter((i) => !i.key || prefixes.some((p) => i.key.startsWith(p)));
  // A creature ability's flag is another key; it never counts as the GM's own here.
  const others = mine.filter((i) => i.key || !list.find((x) => x.id === i.id)?.flags?.[FLAG_SCOPE]?.creatureAbility);
  return planAbilityItems(desired, others);
}
