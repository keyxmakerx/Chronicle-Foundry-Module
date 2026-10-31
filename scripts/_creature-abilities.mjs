/**
 * Chronicle creature abilities as Draw Steel ability items.
 *
 * Chronicle keeps a creature's abilities and villain actions as JSON text on
 * the page (`abilities_json`, `villain_actions_json`), with each tier result
 * written out ("6 damage; M < 2 {@condition slowed} (save ends)"). The Draw
 * Steel system only rolls an ability whose tiers are structured effects, so
 * this turns the text into its damage, applied (condition with potency),
 * forced-movement and other effects. A clause it can't read stays as that
 * tier's text, so nothing in the stat block is lost; it just has no Apply
 * button. Chronicle's bonus is used as written ("2d10 + 2" rolls +2).
 *
 * Only items carrying the ability flag are ours; an ability the GM put on the
 * actor (by hand or from the system's compendium) is never touched, and a
 * Chronicle ability of the same name is not added beside it.
 * `tools/test-creature-abilities.mjs`.
 */

import { escapeHtml } from './_escape-html.mjs';

/** Bump when the conversion changes, so existing actors are rebuilt once. */
export const CONVERTER_VERSION = 1;

/** Item flag naming the Chronicle ability an item was made from. */
export const ABILITY_FLAG = 'creatureAbility';

const SOURCE_FIELDS = ['abilities_json', 'villain_actions_json'];

const CHARACTERISTICS = { M: 'might', A: 'agility', R: 'reason', I: 'intuition', P: 'presence' };
const DAMAGE_TYPES = ['acid', 'cold', 'corruption', 'fire', 'holy', 'lightning', 'poison', 'psychic', 'sonic'];
const CONDITIONS = ['bleeding', 'dazed', 'frightened', 'grabbed', 'prone', 'restrained', 'slowed', 'taunted', 'weakened'];
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const TIERS = ['tier1', 'tier2', 'tier3'];
const POTENCY_DEFAULTS = ['@potency.weak', '@potency.average', '@potency.strong'];

// Chronicle's ability type → the system's action type and category.
const TYPES = {
  signature: ['main', 'signature'],
  action: ['main', ''],
  maneuver: ['maneuver', ''],
  triggered: ['triggered', ''],
  'free triggered': ['freeTriggered', ''],
  villain: ['villain', 'villain'],
  'villain-action': ['villain', 'villain'],
};

/** `{@condition slowed}` → "slowed", `{@duration save-ends|save ends}` → "save ends". */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\{@\w+ ([^}|]*)(?:\|([^}]*))?\}/g, (_, term, shown) => (shown || term))
    .replace(/\s+/g, ' ')
    .trim();
}

function count(word) {
  if (!word) return 1;
  return NUMBERS[word.toLowerCase()] ?? (Number(word) || 1);
}

/** "3 cube within 1" → the system's distance fields; anything unread is "special". */
export function parseDistance(text) {
  const s = plainText(text).toLowerCase().replace(/;.*$/, '').trim();
  const d = (type, primary = 1, secondary = 1, tertiary = 1, n = 1) => ({
    type, count: String(n), primary: String(primary), secondary: String(secondary), tertiary: String(tertiary),
  });
  let m;
  if ((m = s.match(/^melee (\d+) or ranged (\d+)$/))) return d('meleeRanged', m[1], m[2]);
  if ((m = s.match(/^melee (\d+)$/))) return d('melee', m[1]);
  if ((m = s.match(/^ranged (\d+)$/))) return d('ranged', m[1]);
  if ((m = s.match(/^(\d+) burst$/))) return d('burst', m[1]);
  if ((m = s.match(/^(?:(\d+) aura|aura (\d+))$/))) return d('aura', m[1] ?? m[2]);
  if ((m = s.match(/^(?:(\w+) )?(\d+) cubes? within (\d+)$/))) return d('cube', m[2], m[3], 1, count(m[1]));
  if ((m = s.match(/^(?:(\w+) )?(\d+) x (\d+) lines? within (\d+)$/))) return d('line', m[2], m[3], m[4], count(m[1]));
  if ((m = s.match(/^(\d+) wall within (\d+)$/))) return d('wall', m[1], m[2]);
  if (s === 'self') return d('self');
  return d('special');
}

/** "Two creatures or objects" → the system's target fields; anything unread keeps its words. */
export function parseTarget(text) {
  const raw = plainText(text);
  const s = raw.toLowerCase().replace(/\.$/, '');
  const perMinion = / per minion$/.test(s);
  const t = s.replace(/ per minion$/, '');
  const out = (type, value = null, custom = '') => ({ type, value, custom: perMinion ? raw : custom });
  if (t === 'self') return out('self');
  let m;
  if ((m = t.match(/^(one|two|three|four|five|six|\d+) (creatures?|enemy|enemies|ally|allies|objects?)( or objects?)?$/))) {
    const n = m[2];
    const base = n.startsWith('creature') ? 'creature' : n.startsWith('enem') ? 'enemy' : n.startsWith('all') ? 'ally' : 'object';
    const type = m[3] ? (base === 'creature' ? 'creatureObject' : base === 'enemy' ? 'enemyObject' : 'special') : base;
    return out(type, count(m[1]), type === 'special' ? raw : '');
  }
  if ((m = t.match(/^(?:each|all) (creature|enemy|enemies|creatures)(?: and| or) objects? in (?:the )?area$/))) {
    return out(m[1].startsWith('creature') ? 'creatureObject' : 'enemyObject');
  }
  if ((m = t.match(/^(?:each|all) (creatures?|enemy|enemies|ally|allies) in (?:the )?area$/))) {
    return out(m[1].startsWith('creature') ? 'creature' : m[1].startsWith('enem') ? 'enemy' : 'ally');
  }
  if (t === 'self and each ally in the area') return out('selfAlly');
  if (t === 'self or one ally') return out('selfOrAlly', 1);
  return out('special', null, raw);
}

/**
 * One tier's text as clauses: damage, a condition (with its potency), forced
 * movement, or other text the system can only show.
 */
export function parseTier(text, known = {}) {
  const damageTypes = known.damageTypes ?? DAMAGE_TYPES;
  const conditions = known.conditions ?? CONDITIONS;
  const clauses = [];
  // "push 2, prone" is two results; a comma inside other wording is left alone.
  const parts = String(text ?? '').split(';').flatMap((part) => {
    const pieces = part.split(',');
    const simple = /^\s*(?:vertical )?(?:\{@movement )?(?:push|pull|slide)\}? \d+\s*$|^\s*(?:\{@condition )?\w+\}?\s*$/i;
    return pieces.length > 1 && pieces.every((p) => simple.test(p)) ? pieces : [part];
  });
  for (const part of parts) {
    const clause = plainText(part);
    if (!clause) continue;
    let m = clause.match(/^(\d+)(?: (\w+))? damage$/i);
    if (m && (!m[2] || damageTypes.includes(m[2].toLowerCase()))) {
      clauses.push({ kind: 'damage', value: m[1], types: m[2] ? [m[2].toLowerCase()] : [] });
      continue;
    }
    let potency = null;
    let rest = clause;
    if ((m = clause.match(/^([MARIP]) ?< ?(-?\d+) (.+)$/))) {
      potency = { characteristic: CHARACTERISTICS[m[1]], value: m[2] };
      rest = m[3];
    }
    // "dazed and slowed (save ends)" is two conditions sharing one ending.
    if ((m = rest.match(/^(\w+)(?: and (\w+))?(?: \((save ends|eot|end of turn)\))?$/i))
      && [m[1], m[2]].filter(Boolean).every((c) => conditions.includes(c.toLowerCase()))) {
      const end = !m[3] ? '' : /save/i.test(m[3]) ? 'save' : 'turn';
      const tail = m[3] ? ` (${m[3]})` : '';
      for (const c of [m[1], m[2]].filter(Boolean)) {
        clauses.push({ kind: 'applied', condition: c.toLowerCase(), end, potency, display: `${potency ? '{{potency}} ' : ''}${c}${tail}` });
      }
      continue;
    }
    if ((m = rest.match(/^(vertical )?(push|pull|slide) (\d+)$/i))) {
      clauses.push({ kind: 'forced', movement: m[2].toLowerCase(), distance: m[3], vertical: !!m[1], potency });
      continue;
    }
    clauses.push({ kind: 'other', text: clause });
  }
  return clauses;
}

function tierPotency(potency, n) {
  if (potency) return { value: potency.value, characteristic: potency.characteristic };
  return { value: POTENCY_DEFAULTS[n], characteristic: n === 0 ? 'none' : '' };
}

/** A 16-character id the system accepts, stable for the same effect. */
function effectId(prefix, name = '') {
  return `${prefix}${name}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '0');
}

/**
 * The tiers' clauses as the system's power roll effects. A condition or
 * movement that a higher tier drops goes back to text: the system carries a
 * tier's wording up to the next tier, so it would read wrong there.
 */
export function powerEffects(tierTexts, known = {}) {
  const tiers = tierTexts.map((t) => parseTier(t, known));
  const has = (pred) => tiers.map((cl) => cl.some(pred));
  const steady = (flags) => flags.every((f, i) => i === 0 || f || !flags[i - 1]);
  const keep = new Set();
  for (const cl of tiers.flat()) {
    if (cl.kind === 'damage') continue;
    if (cl.kind === 'applied') keep.add(`applied:${cl.condition}`);
    if (cl.kind === 'forced') keep.add(`forced:${cl.movement}`);
  }
  for (const k of [...keep]) {
    const [kind, name] = k.split(':');
    const flags = has((c) => c.kind === kind && (c.condition ?? c.movement) === name);
    const twice = tiers.some((cl) => cl.filter((c) => c.kind === kind && (c.condition ?? c.movement) === name).length > 1);
    if (!steady(flags) || twice) keep.delete(k);
  }

  const effects = {};
  let sort = 0;
  const other = [[], [], []];
  const damage = tiers.map((cl) => cl.filter((c) => c.kind === 'damage'));
  if (damage.some((d) => d.length)) {
    const id = effectId('chrdamage');
    effects[id] = { _id: id, type: 'damage', name: '', img: null, sort: sort++, damage: {} };
    TIERS.forEach((t, n) => {
      const [first, ...extra] = damage[n];
      for (const x of extra) other[n].push(`${x.value}${x.types.length ? ` ${x.types[0]}` : ''} damage`);
      effects[id].damage[t] = {
        value: first ? first.value : '0', types: first ? first.types : [], ignoredImmunities: [], potency: tierPotency(null, n),
      };
    });
  }
  for (const k of keep) {
    const [kind, name] = k.split(':');
    const id = effectId(kind === 'applied' ? 'chrapp' : 'chrfrc', name);
    const effect = { _id: id, type: kind, name: kind === 'applied' ? name.charAt(0).toUpperCase() + name.slice(1) : name, img: null, sort: sort++, [kind]: {} };
    TIERS.forEach((t, n) => {
      const c = tiers[n].find((x) => x.kind === kind && (x.condition ?? x.movement) === name);
      if (kind === 'applied') {
        effect.applied[t] = {
          display: c ? c.display : '',
          potency: tierPotency(c?.potency, n),
          effects: c ? { [name]: { condition: c.potency ? 'failure' : 'always', end: c.end, properties: [] } } : {},
        };
      } else {
        effect.forced[t] = {
          display: c ? (c.potency ? '{{potency}} {{forced}}' : '{{forced}}') : '',
          movement: [name], distance: c ? c.distance : '0', properties: c?.vertical ? ['vertical'] : [],
          potency: tierPotency(c?.potency, n),
        };
      }
    });
    effects[id] = effect;
  }
  tiers.forEach((cl, n) => {
    for (const c of cl) {
      if (c.kind === 'other') other[n].push(c.text);
      else if (c.kind === 'applied' && !keep.has(`applied:${c.condition}`)) other[n].push(c.display.replace('{{potency}}', potencyText(c.potency)));
      else if (c.kind === 'forced' && !keep.has(`forced:${c.movement}`)) other[n].push(`${potencyText(c.potency)}${c.vertical ? 'vertical ' : ''}${c.movement} ${c.distance}`.trim());
    }
  });
  if (other.some((o) => o.length)) {
    const id = effectId('chrother');
    effects[id] = { _id: id, type: 'other', name: '', img: null, sort: sort++, other: {} };
    TIERS.forEach((t, n) => { effects[id].other[t] = { display: other[n].join('; '), potency: tierPotency(null, n) }; });
  }
  return effects;
}

function potencyText(potency) {
  if (!potency) return '';
  const letter = Object.keys(CHARACTERISTICS).find((k) => CHARACTERISTICS[k] === potency.characteristic);
  return `${letter} < ${potency.value} `;
}

/** "2d10 + 2" → "2"; no roll → no power roll (the tiers stay as text). */
export function rollBonus(text) {
  const m = plainText(text).replace(/\s+/g, '').match(/^2d10([+-]\d+)?$/i);
  if (!m) return null;
  return m[1] ? String(Number(m[1])) : '0';
}

/** A short, stable fingerprint; not for security, only to notice a change. */
export function fingerprint(value) {
  const s = `${CONVERTER_VERSION}:${JSON.stringify(value ?? null)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** One Chronicle ability as Draw Steel ability item data. */
export function abilityItem(ability, { villain = false, known = {}, key, hash, flagScope }) {
  const [type, category] = villain ? ['villain', 'villain'] : (TYPES[String(ability.type ?? '').toLowerCase()] ?? ['none', '']);
  const keywords = (ability.keywords || [])
    .map((k) => String(k).toLowerCase())
    .filter((k) => !known.keywords || known.keywords.includes(k));
  const tierTexts = TIERS.map((t) => ability[t] ?? '');
  const hasTiers = tierTexts.some((t) => plainText(t));
  const bonus = rollBonus(ability.power_roll);
  const special = {};
  const distanceText = plainText(ability.distance);
  const distance = parseDistance(distanceText);
  // Wording the fields can't hold is shown above the tiers instead.
  const before = [];
  if (distance.type === 'special' && distanceText && !/^special$/i.test(distanceText)) before.push(distanceText);
  if (bonus === null && plainText(ability.power_roll)) before.push(`Power roll: ${plainText(ability.power_roll)}`);
  if (before.length) {
    special.before0000000000 = {
      _id: 'before0000000000', type: 'base', before: true, name: '', img: null, sort: 0,
      description: before.map((b) => `<p>${escapeHtml(b)}</p>`).join(''),
    };
  }
  const effectText = plainText(ability.effect);
  if (effectText) {
    special.after00000000000 = { _id: 'after00000000000', type: 'base', before: false, name: '', img: null, sort: 1, description: `<p>${escapeHtml(effectText)}</p>` };
  }
  return {
    name: String(ability.name || 'Ability'),
    type: 'ability',
    system: {
      type,
      category,
      keywords,
      trigger: plainText(ability.trigger),
      distance,
      target: parseTarget(ability.target),
      power: {
        roll: { formula: bonus ?? '0', characteristics: [], reactive: false },
        effects: hasTiers ? powerEffects(tierTexts, known) : {},
      },
      effects: special,
    },
    flags: { [flagScope]: { [ABILITY_FLAG]: key, [`${ABILITY_FLAG}Hash`]: hash } },
  };
}

function readList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Whether a page carries any ability fields this conversion reads. */
export function hasAbilityFields(fieldsData) {
  return SOURCE_FIELDS.some((f) => fieldsData && f in fieldsData);
}

/** Fingerprint of a page's abilities, to skip actors already built from them. */
export function abilitiesFingerprint(fieldsData) {
  return fingerprint(SOURCE_FIELDS.map((f) => fieldsData?.[f] ?? null));
}

/** Every ability item the page should give its actor, keyed by list and name. */
export function desiredAbilities(fieldsData, { known = {}, flagScope }) {
  const out = [];
  const seen = new Map();
  for (const field of SOURCE_FIELDS) {
    for (const ability of readList(fieldsData?.[field])) {
      if (!ability || typeof ability !== 'object' || !ability.name) continue;
      const base = `${field}:${String(ability.name).toLowerCase()}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const key = n > 1 ? `${base}#${n}` : base;
      const hash = fingerprint(ability);
      out.push({ key, hash, data: abilityItem(ability, { villain: field === 'villain_actions_json', known, key, hash, flagScope }) });
    }
  }
  return out;
}

/**
 * What to change on an actor's items: ours that are stale or gone are
 * removed, missing ones created; the GM's own abilities stay, and a Chronicle
 * ability already there under the same name is left to the GM's copy.
 * @param {{key:string,hash:string,data:object}[]} desired
 * @param {{id:string,name:string,type:string,key?:string,hash?:string}[]} items
 */
export function planAbilityItems(desired, items) {
  const ours = new Map(items.filter((i) => i.key).map((i) => [i.key, i]));
  const theirs = new Set(items.filter((i) => !i.key && i.type === 'ability').map((i) => i.name.trim().toLowerCase()));
  const wanted = new Set();
  const create = [];
  const remove = [];
  for (const d of desired) {
    if (theirs.has(d.data.name.trim().toLowerCase())) continue;
    wanted.add(d.key);
    const have = ours.get(d.key);
    if (have && have.hash === d.hash) continue;
    if (have) remove.push(have.id);
    create.push(d.data);
  }
  for (const [key, item] of ours) if (!wanted.has(key)) remove.push(item.id);
  return { create, remove };
}
