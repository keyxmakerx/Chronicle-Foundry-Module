/**
 * Pure rules for the Chronicle NPC and monster sheet (scripts/npc-looks.mjs):
 * which shape an actor is drawn in, which template each look draws a part
 * with, and the figures its boxes show: the negotiation, the villain actions
 * used this fight, the page's text and its people. Every number comes from
 * Draw Steel's prepared data or Chronicle's negotiation tracker; this file
 * only turns them into rows and labels. `tools/test-npc-looks.mjs`.
 */

/** The two shapes of the one sheet: talk first, or the stat block first. */
export const SHAPES = Object.freeze(['npc', 'monster']);

/** The actor flag holding a hand-picked shape, under the module's scope. */
export const SHAPE_FLAG = 'npcSheetShape';

/** The combat flag holding each monster's villain actions used this fight. */
export const VILLAIN_FLAG = 'villainActions';

/**
 * The shape to draw. A shape picked by hand wins; a creature page's actor is
 * a monster; an actor made from, or linked to, a character page is an NPC;
 * anything else (a bestiary monster) is a monster.
 * @param {{flag?: unknown, pageId?: unknown, creatureId?: unknown, linkedId?: unknown}} actor
 * @returns {'npc'|'monster'}
 */
export function sheetShape({ flag, pageId, creatureId, linkedId } = {}) {
  if (SHAPES.includes(flag)) return flag;
  if (creatureId) return 'monster';
  return pageId || linkedId ? 'npc' : 'monster';
}

/**
 * The Chronicle page an NPC actor follows: the page character sync made it
 * from, else a creature page, else one linked by a dropped journal.
 * @param {{pageId?: unknown, creatureId?: unknown, linkedId?: unknown}} flags
 * @returns {string|null}
 */
export function npcPageId({ pageId, creatureId, linkedId } = {}) {
  for (const id of [pageId, creatureId, linkedId]) if (typeof id === 'string' && id) return id;
  return null;
}

/** Where the NPC looks' templates live. */
export const NPC_LOOK_DIR = 'modules/chronicle-sync/templates/npc-looks';

/** The parts every look draws for each shape. */
export const NPC_LOOK_PARTS = Object.freeze(['header', 'stats', 'card']);

/**
 * The looks that have their own NPC and monster templates. A look without
 * them draws these sheets in the Chronicle look, rather than in a look that
 * would only half fit.
 */
export const NPC_LOOKS = Object.freeze(['chronicle']);

/**
 * The look an NPC sheet is drawn in: the hero look when it has NPC
 * templates, else the Chronicle look.
 * @param {string} heroLook  the resolved hero look
 * @returns {string}
 */
export function npcLook(heroLook) {
  return NPC_LOOKS.includes(heroLook) ? heroLook : NPC_LOOKS[0];
}

/**
 * The template a look draws one part of a shape with. Null for a part the
 * looks don't draw (Draw Steel's own tabs, and the shared panes).
 * @param {string} look
 * @param {'npc'|'monster'} shape
 * @param {string} part
 * @returns {string|null}
 */
export function npcLookTemplate(look, shape, part) {
  if (!NPC_LOOK_PARTS.includes(part) || !SHAPES.includes(shape)) return null;
  return `${NPC_LOOK_DIR}/${npcLook(look)}/${shape}-${part}.hbs`;
}

/** The panes and the Edit mode editors both shapes share, whatever the look. */
export const SHARED_TEMPLATES = Object.freeze({
  talk: `${NPC_LOOK_DIR}/talk.hbs`,
  people: `${NPC_LOOK_DIR}/people.hbs`,
  edit: `${NPC_LOOK_DIR}/edit-stats.hbs`,
});

/** The partials each look's templates include, by name in the look's folder. */
export const NPC_LOOK_PARTIALS = Object.freeze({
  chronicle: Object.freeze(['numbers-row', 'stamina-box']),
});

/** Every NPC look template and partial, for loading them before the first draw. */
export function allNpcLookTemplates() {
  const out = [...Object.values(SHARED_TEMPLATES)];
  for (const look of NPC_LOOKS) {
    for (const shape of SHAPES) for (const part of NPC_LOOK_PARTS) out.push(npcLookTemplate(look, shape, part));
    for (const name of NPC_LOOK_PARTIALS[look] ?? []) out.push(`${NPC_LOOK_DIR}/${look}/${name}.hbs`);
  }
  return [...new Set(out)];
}

/** The NPC shape's own tabs, ahead of Draw Steel's. */
const NPC_TABS = Object.freeze([{ id: 'talk' }, { id: 'people' }]);

/** Tab order on the NPC sheet; tabs Draw Steel adds later go last. */
const TAB_ORDER = ['talk', 'abilities', 'features', 'people', 'effects', 'biography'];

/**
 * Draw Steel's NPC tab group without its Stats tab (the boxes sit above the
 * tabs), with Talk and People added. Which of them a shape shows is decided
 * per draw (`shapeTabs`).
 * @param {{primary?: {tabs?: {id: string}[], initial?: string, labelPrefix?: string}}} baseTabs
 * @returns {object}
 */
export function npcTabs(baseTabs) {
  const primary = baseTabs?.primary ?? {};
  const rank = (id) => {
    const i = TAB_ORDER.indexOf(id);
    return i === -1 ? TAB_ORDER.length : i;
  };
  const own = NPC_TABS.map((t) => ({ ...t, label: `CHRONICLE.NpcSheet.Tabs.${t.id}` }));
  const tabs = [...own, ...(primary.tabs ?? []).filter((t) => t.id !== 'stats' && !NPC_TABS.some((o) => o.id === t.id))]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i)
    .map(({ t }) => t);
  return { ...baseTabs, primary: { ...primary, tabs, initial: 'abilities' } };
}

/** The tabs and parts only the NPC shape draws. */
export const NPC_ONLY = Object.freeze(['talk', 'people']);

/**
 * The tab a sheet opens on: Talk for an NPC, unless a fight is on, when
 * both shapes open on Abilities. The sheet never switches by itself once open.
 * @param {'npc'|'monster'} shape
 * @param {boolean} inCombat
 * @returns {string}
 */
export function openingTab(shape, inCombat) {
  return shape === 'npc' && !inCombat ? 'talk' : 'abilities';
}

/**
 * Draw Steel's parts in the sheet's order: header, the boxes above the tabs,
 * the tab row, then the panes, with Talk and People after the tab row.
 * Every part keeps its id, because Draw Steel prepares context and refreshes
 * parts by id.
 * @param {Record<string, object>} baseParts  Draw Steel's NPC PARTS
 * @param {{header: object, stats: object, card: object}} own
 * @returns {Record<string, object>}
 */
export function npcParts(baseParts, own) {
  const parts = { header: own.header, stats: own.stats };
  if (baseParts.tabs) parts.tabs = baseParts.tabs;
  parts.talk = { template: SHARED_TEMPLATES.talk, scrollable: [''] };
  parts.people = { template: SHARED_TEMPLATES.people, scrollable: [''] };
  for (const [id, part] of Object.entries(baseParts)) {
    if (!(id in parts)) parts[id] = part;
  }
  parts.card = own.card;
  return parts;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Interest and Patience run from 0 to 5 in Draw Steel. */
export const METER_MAX = 5;

/**
 * Lit pips for a meter, one per point up to METER_MAX.
 * @param {unknown} value
 * @returns {boolean[]}
 */
export function meterPips(value) {
  const v = Math.max(0, Math.min(METER_MAX, Math.trunc(num(value) ?? 0)));
  return Array.from({ length: METER_MAX }, (_, i) => i < v);
}

/**
 * The words for what the NPC would answer at an Interest, from Draw Steel's
 * offers: a key for each of 0 to 5, or null when Interest isn't known.
 * @param {unknown} interest
 * @returns {string|null}
 */
export function answerKey(interest) {
  const v = num(interest);
  if (v === null) return null;
  return `CHRONICLE.NpcSheet.Answer.${Math.max(0, Math.min(METER_MAX, Math.trunc(v)))}`;
}

/** Chronicle's slug for a motivation that Draw Steel spells differently. */
const SLUG_TO_KEY = Object.freeze({ 'higher-authority': 'authority' });

/**
 * Draw Steel's key for a tracker's motivation slug.
 * @param {unknown} slug
 * @returns {string}
 */
export function motiveKey(slug) {
  const s = String(slug ?? '');
  return SLUG_TO_KEY[s] ?? s;
}

const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [...(v ?? [])].filter((s) => typeof s === 'string' && s));
const isGmHalf = (gm) => !!gm && typeof gm === 'object' && !Array.isArray(gm) && Object.keys(gm).length > 0;

/**
 * The rows of motivations and pitfalls, each with its state: `found` once
 * the party has found it, `used` once a motivation was appealed to (it won't
 * move the NPC again), `hidden` while the party hasn't found it.
 * @param {{motivations?: string[], pitfalls?: string[], found?: {motivations?: string[], pitfalls?: string[]}, used?: string[]}} half
 * @param {(key: string) => string} labelOf
 * @param {{allFound?: boolean}} [opts]  rows from an actor, where every listed entry is known
 * @returns {{key: string, label: string, kind: 'motivation'|'pitfall', state: 'found'|'used'|'hidden'}[]}
 */
export function motiveRows(half, labelOf, { allFound = false } = {}) {
  const found = half?.found && typeof half.found === 'object' ? half.found : {};
  const foundM = new Set(list(found.motivations));
  const foundP = new Set(list(found.pitfalls));
  const used = new Set(list(half?.used));
  const rows = [];
  const seen = new Set();
  const add = (slug, kind) => {
    const key = motiveKey(slug);
    if (seen.has(`${kind}:${key}`)) return;
    seen.add(`${kind}:${key}`);
    let state = 'hidden';
    if (kind === 'motivation' && used.has(slug)) state = 'used';
    else if (allFound || (kind === 'motivation' ? foundM : foundP).has(slug)) state = 'found';
    rows.push({ key, label: labelOf(key) || key, kind, state });
  };
  for (const slug of list(half?.motivations)) add(slug, 'motivation');
  for (const slug of list(half?.pitfalls)) add(slug, 'pitfall');
  return rows;
}

/**
 * What the negotiation box, the Talk pane and the folded card show, and from
 * where. The Director of a linked NPC reads Chronicle's tracker live (never
 * saved in Foundry). Everyone else reads the actor, which holds only what
 * players may know: found entries, and the meters once shown. An actor with
 * no Chronicle page holds Draw Steel's own negotiation, shown as it is.
 * @param {{linked: boolean, isGM: boolean, live?: {gm?: object}|null, liveFailed?: boolean,
 *   actorNeg?: {interest?: number, patience?: number, impression?: number, motivations?: Iterable<string>, pitfalls?: Iterable<string>}|null,
 *   shownFlag?: unknown, labelOf?: (key: string) => string}} q
 * @returns {object}
 */
export function negotiationView({ linked, isGM, live = null, liveFailed = false, actorNeg = null, shownFlag, labelOf = (k) => k }) {
  const empty = { source: 'none', has: false, shown: false, interest: null, patience: null, impression: null, rows: [], log: [], over: false };
  const meters = (interest, patience) => ({
    interest: num(interest),
    patience: num(patience),
    interestPips: meterPips(interest),
    patiencePips: meterPips(patience),
    answer: answerKey(interest),
  });
  if (linked && isGM && isGmHalf(live?.gm)) {
    const gm = live.gm;
    const log = (Array.isArray(gm.log) ? gm.log : [])
      .filter((e) => e && typeof e.text === 'string' && e.text)
      .map((e) => ({ text: e.text, at: typeof e.at === 'string' ? e.at : null }))
      .reverse();
    return {
      ...empty,
      source: 'chronicle',
      has: true,
      shown: gm.shown === true,
      over: gm.over === true,
      impression: num(gm.impression),
      ...meters(gm.interest, gm.patience),
      rows: motiveRows(gm, labelOf),
      log,
    };
  }
  const neg = actorNeg && typeof actorNeg === 'object' ? actorNeg : null;
  if (linked && isGM && !liveFailed) return { ...empty, source: 'none' };
  if (!neg) return empty;
  const rows = motiveRows({ motivations: list(neg.motivations), pitfalls: list(neg.pitfalls) }, labelOf, { allFound: true });
  if (linked) {
    // The actor holds the players' half; the meters are real only once shown.
    const shown = shownFlag === true;
    return {
      ...empty,
      source: liveFailed ? 'offline' : 'players',
      has: true,
      shown,
      ...(shown ? meters(neg.interest, neg.patience) : meters(null, null)),
      rows,
    };
  }
  return {
    ...empty,
    source: 'actor',
    has: true,
    shown: true,
    impression: isGM ? num(neg.impression) : null,
    ...meters(neg.interest, neg.patience),
    rows,
  };
}

/**
 * Villain actions in Draw Steel's order, each `used` this fight, `next` (the
 * first one still unused) or `unused`.
 * @param {{id: string, name: string}[]} abilities  the actor's villain actions, in order
 * @param {Iterable<string>} used  item ids used this fight
 * @returns {{marks: {id: string, name: string, order: number, state: 'used'|'next'|'unused'}[], left: number, total: number}}
 */
export function villainMarks(abilities, used) {
  const usedSet = new Set(list(used));
  let nextGiven = false;
  const marks = (abilities ?? []).filter((a) => a?.id).map((a, i) => {
    let state = 'unused';
    if (usedSet.has(a.id)) state = 'used';
    else if (!nextGiven) {
      nextGiven = true;
      state = 'next';
    }
    return { id: a.id, name: String(a.name ?? ''), order: i + 1, state };
  });
  return { marks, left: marks.filter((m) => m.state !== 'used').length, total: marks.length };
}

/**
 * The key a monster's marks are kept under on the combat: its actor's uuid,
 * without dots, so Foundry doesn't read the key as a path. A token's own
 * actor has its own uuid, so two goblins from one sheet keep their own marks.
 * @param {unknown} uuid
 * @returns {string}
 */
export function villainKey(uuid) {
  return String(uuid ?? '').replace(/\./g, '~');
}

/**
 * The combat's villain action marks after one is marked used or unused.
 * Entries with nothing used are dropped.
 * @param {Record<string, string[]>|null|undefined} map
 * @param {string} key
 * @param {string} itemId
 * @param {boolean} [used]  set or clear; toggled when left out
 * @returns {Record<string, string[]>}
 */
export function withVillainUse(map, key, itemId, used) {
  const all = map && typeof map === 'object' ? map : {};
  const have = new Set(list(all[key]));
  const on = used ?? !have.has(itemId);
  if (on) have.add(itemId);
  else have.delete(itemId);
  const out = {};
  for (const [k, v] of Object.entries(all)) if (k !== key && list(v).length) out[k] = list(v);
  if (have.size) out[key] = [...have];
  return out;
}

/**
 * Whether an actor has a stat block to fight with. A Chronicle NPC page
 * arrives with Draw Steel's empty defaults, and the sheet shows no fight
 * numbers rather than those.
 * @param {{staminaMax?: unknown, abilityCount?: unknown}} actor
 * @returns {boolean}
 */
export function hasStatBlock({ staminaMax, abilityCount } = {}) {
  return (num(staminaMax) ?? 0) > 0 || (num(abilityCount) ?? 0) > 0;
}

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'section', 'figure', 'tr', 'pre']);
const VOID = new Set(['br', 'img', 'hr', 'input', 'wbr', 'area', 'base', 'col', 'embed', 'link', 'meta', 'source', 'track']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * A Chronicle page's text split into what players may read and the
 * Director's secrets, as plain text: paragraphs of open text, and each
 * secret span (`data-secret`) or GM-only picture caption on its own. Plain
 * text, so nothing from the page runs as markup on the sheet.
 * @param {unknown} html  the page's entry_html
 * @param {{maxParagraphs?: number}} [opts]
 * @returns {{open: string[], secrets: string[]}}
 */
export function pageText(html, { maxParagraphs = 12 } = {}) {
  const open = [];
  const secrets = [];
  let para = '';
  let secret = null;
  let secretDepth = 0;
  const stack = [];
  const flush = () => {
    const t = para.replace(/\s+/g, ' ').trim();
    if (t) open.push(t);
    para = '';
  };
  const endSecret = () => {
    const t = (secret ?? '').replace(/\s+/g, ' ').trim();
    if (t) secrets.push(t);
    secret = null;
  };
  const src = typeof html === 'string' ? html : '';
  for (const m of src.matchAll(TAG_RE)) {
    const [tok, name, attrs = ''] = m;
    if (tok.startsWith('<!--')) continue;
    if (name) {
      const tag = name.toLowerCase();
      const closing = tok.startsWith('</');
      if (closing) {
        const i = stack.lastIndexOf(tag);
        if (i >= 0) stack.length = i;
        if (secret !== null && stack.length < secretDepth) endSecret();
        if (BLOCK.has(tag) && secret === null) flush();
        continue;
      }
      if (tag === 'br') {
        if (secret !== null) secret += ' ';
        else para += ' ';
        continue;
      }
      if (BLOCK.has(tag) && secret === null) flush();
      if (VOID.has(tag) || tok.endsWith('/>')) continue;
      stack.push(tag);
      const isSecret = /\bdata-secret\s*=\s*["']?true/i.test(attrs) || /\bclass\s*=\s*["'][^"']*\b(?:secret|ce-img--gm)\b/i.test(attrs);
      if (isSecret && secret === null) {
        secret = '';
        secretDepth = stack.length;
      }
      continue;
    }
    if (tok === '<') continue;
    const text = decode(tok);
    if (secret !== null) secret += text;
    else para += text;
  }
  if (secret !== null) endSecret();
  flush();
  return { open: open.slice(0, maxParagraphs), secrets };
}

/**
 * The chips under an NPC's name: the page's faction, then its tags. Each is
 * shown only on the Director's screen, from the live page.
 * @param {{fields_data?: object, tags?: unknown[]}|null} entity
 * @param {{factionLabel?: string, tagLabel?: string}} labels
 * @returns {{kind: string, name: string}[]}
 */
export function pageChips(entity, { factionLabel = 'Faction', tagLabel = 'Tag' } = {}) {
  if (!entity || typeof entity !== 'object') return [];
  const out = [];
  const faction = entity.fields_data?.faction;
  if (typeof faction === 'string' && faction.trim()) out.push({ kind: factionLabel, name: faction.trim() });
  for (const t of Array.isArray(entity.tags) ? entity.tags : []) {
    const name = typeof t === 'string' ? t : t?.name;
    if (typeof name === 'string' && name.trim() && !t?.dmOnly && !t?.dm_only) out.push({ kind: tagLabel, name: name.trim() });
  }
  return out.slice(0, 8);
}

/**
 * The People pane's rows: who the page is linked to, from Chronicle's
 * relations, each with how it's linked. A Director-only link is marked.
 * @param {unknown} relations  GET /entities/:id/relations (a bare array or `{data}`)
 * @param {string} entityId
 * @returns {{id: string|null, name: string, how: string, dmOnly: boolean}[]}
 */
export function peopleRows(relations, entityId) {
  const rows = Array.isArray(relations) ? relations : Array.isArray(relations?.data) ? relations.data : [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const fromHere = !r.sourceEntityId || r.sourceEntityId === entityId;
    const name = r.targetEntityName ?? r.target_entity_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const how = (fromHere ? r.relationType : r.reverseRelationType) ?? r.relationType ?? '';
    out.push({ id: r.targetEntityId ?? null, name: name.trim(), how: String(how), dmOnly: r.dmOnly === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What changed between two draws of an NPC or monster sheet, for the look's
 * moves: the hero sheet's hit and heal and Edit mode, then a villain action
 * used, Malice gained, falling to winded, Interest up or down, a pitfall
 * found and a motivation or pitfall revealed.
 * @param {object|null} before
 * @param {object} after
 * @param {string[]} heroMoves  the hero sheet's moves for the same change
 * @returns {string[]}
 */
export function npcChanges(before, after, heroMoves = []) {
  if (!before || !after) return [];
  const out = heroMoves.filter((m) => m !== 'level');
  if (num(after.villainUsed) !== null && num(before.villainUsed) !== null && after.villainUsed > before.villainUsed) out.push('va');
  if (num(after.malice) !== null && num(before.malice) !== null && after.malice > before.malice) out.push('malice');
  if (before.band && before.band !== 'winded' && after.band === 'winded') out.push('winded');
  const bi = num(before.interest);
  const ai = num(after.interest);
  if (bi !== null && ai !== null && ai > bi) out.push('up');
  if (bi !== null && ai !== null && ai < bi) out.push('down');
  const was = new Map((before.motives ?? []).map((r) => [`${r.kind}:${r.key}`, r.state]));
  let pit = false;
  let reveal = false;
  for (const r of after.motives ?? []) {
    const prev = was.get(`${r.kind}:${r.key}`);
    if (prev === 'hidden' && r.state === 'found') {
      if (r.kind === 'pitfall') pit = true;
      else reveal = true;
    }
  }
  if (pit) out.push('pit');
  if (reveal) out.push('reveal');
  return out;
}
