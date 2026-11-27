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
 *
 * A list property the field's `foundry_entry_items` names (an ancestry's
 * signature traits) gives one item of the mapped type per named object, with
 * its description, kept in step the same way.
 * `tools/test-entry-abilities.mjs`.
 */
import { FLAG_SCOPE } from './constants.mjs';
import { abilityItem, fingerprint, plainText, planAbilityItems } from './_creature-abilities.mjs';
import { hasClearSecrets } from './_gm-secrets.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';
import { entryTextHTML } from './_entry-text.mjs';

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
 * The items one list property of an entry gives under `foundry_entry_items`:
 * each named object in the list. A type the system doesn't define gives
 * none, so a mapping can't make a document Foundry would refuse; nor does a
 * type an identity field syncs, since sync would read a second ancestry or
 * kit as the hero's. Two objects whose names match give one item, the first.
 * @param {object} entry
 * @param {Record<string, {type: string}>} [entryItems]
 * @param {string[]|null} [itemTypes] - the system's item types
 * @param {string[]} [identityTypes] - the item types identity fields sync
 * @returns {Array<{prop: string, type: string, item: {name: string, description?: string}}>}
 */
export function entryListItems(entry, entryItems, itemTypes, identityTypes = []) {
  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  if (!Array.isArray(itemTypes)) return [];
  const out = [];
  for (const [prop, def] of Object.entries(entryItems ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const list = Object.hasOwn(props, prop) ? props[prop] : null;
    if (!Array.isArray(list) || typeof def?.type !== 'string' || !itemTypes.includes(def.type)) continue;
    if (identityTypes.includes(def.type)) continue;
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) continue;
      if (seen.has(norm(item.name))) continue;
      seen.add(norm(item.name));
      out.push({ prop, type: def.type, item });
    }
  }
  return out;
}

/**
 * One list object as item data: its name, and its description as the item's
 * text (Markdown or HTML, cleaned as every Chronicle text is). Null when the
 * text still holds GM-only content.
 */
export function entryListItemData({ type, item }, { key, hash }) {
  const html = typeof item.description === 'string' ? _sanitizeIncomingHTML(entryTextHTML(item.description)) : '';
  if (hasClearSecrets(html)) return null;
  return {
    name: item.name.trim().slice(0, 200),
    type,
    system: { description: { value: html } },
    flags: { [FLAG_SCOPE]: { chronicleMade: true, [ENTRY_ABILITY_FLAG]: key, [ENTRY_ABILITY_HASH]: hash } },
  };
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
 * @param {object} [args.known] - also `itemTypes`, the system's item types
 * @param {Record<string, object>} [args.entryItemsByField] - each field's `foundry_entry_items`
 * @param {string[]} [args.identityTypes] - every identity field's item type, not only `fields`'
 * @returns {{create: object[], remove: string[]}}
 */
export function planEntryAbilities({ items, fields, entriesByField, known = {}, entryItemsByField, identityTypes = [] }) {
  const notListable = [...identityTypes, ...(fields ?? []).map((f) => f.itemType)];
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
      for (const listed of entryListItems(entry, entryItemsByField?.[fieldKey], known.itemTypes, notListable)) {
        const key = `${fieldKey}:${norm(it.name)}:${listed.prop}:${norm(listed.item.name)}`;
        const hash = fingerprint(listed.item);
        const data = entryListItemData(listed, { key, hash });
        if (data) desired.push({ key, hash, data });
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
