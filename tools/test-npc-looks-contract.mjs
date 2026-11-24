#!/usr/bin/env node
/**
 * The Chronicle NPC and monster sheet's templates keep the markup Draw
 * Steel's NPC sheet handlers read, and keep what only the Director may know
 * off everyone else's screen. Nothing reports either going wrong: a missing
 * attribute makes a button do nothing, and a Director-only value drawn for a
 * player is a leak nobody notices until a player does. So every template is
 * scanned for its actions, inputs and lang keys, the header (which a Limited
 * viewer gets) for what it reads, and the sheet's figures are built as a
 * player and as the Director to check what each screen holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { allNpcLookTemplates, npcLookTemplate, NPC_LOOKS, SHAPES, NPC_LOOK_PARTS } from '../scripts/_npc-looks.mjs';
import { makeChronicleNpcSheet, registerNpcLooks, NPC_SHEET_CLASS, CREATURE_FLAG } from '../scripts/npc-looks.mjs';
import { LINK_FLAG } from '../scripts/npc-presence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'templates/npc-looks');
const strip = (src) => src.replace(/\{\{!--[\s\S]*?--\}\}/g, '').replace(/\{\{![^}]*\}\}/g, '');
const read = (p) => strip(readFileSync(p, 'utf8'));
const flat = (src) => src.replace(/\s+/g, ' ');
const onDisk = (path) => resolve(ROOT, path.replace(/^modules\/chronicle-sync\//, ''));

/** Actions Draw Steel's NPC sheet, its actor sheet and its document sheet handle. */
const KNOWN_ACTIONS = new Set([
  'updateSource', 'editMonsterMetadata', 'freeStrike', 'toggleWithCaptainEffect',
  'toggleStatus', 'roll', 'editCombat', 'useAbility', 'editCharacteristics',
  'toggleMode', 'viewDoc', 'createDoc', 'deleteDoc', 'toggleDocumentDescription',
  'createPseudoDocument', 'deletePseudoDocument', 'renderPseudoDocumentSheet', 'showPortraitArtwork', 'editImage',
]);

/** The hero sheet's own actions, which the NPC sheet inherits. */
const HERO_ACTIONS = new Set(['csPortraitMenu', 'csUnfold', 'csFold', 'csLookPicker']);

/** The NPC sheet's own actions. useAbility wraps Draw Steel's, so it is not new. */
const NPC_ACTIONS = new Set(['csTalk', 'csVillain', 'csShape', 'csOpenPage', 'csToggleLog', 'csOnlyYou']);

/** Draw Steel's stat editors, as its own NPC stats template includes them. */
const DS_STAT_PARTIALS = ['characteristics', 'combat', 'movement', 'immunities-weaknesses']
  .map((n) => `systems/draw-steel/templates/sheets/actor/shared/partials/stats/${n}.hbs`);

/**
 * What Draw Steel 1.2's NPC header reads, under the names ours gives them,
 * plus system.monster.level (the prepared twin of the level it reads). A
 * Limited viewer gets the header, so ours reads nothing else of the actor.
 */
const HEADER_MAY_READ = new Set([
  'avatarProperties.objectFit', 'avatarProperties.objectPosition', 'document.img', 'document.name', 'isPlay',
  'fields.name', 'source.name', 'monsterKeywords', 'monsterKeywords.length', 'keyword', 'system.monster.organizationLabel',
  'system.monster.roleLabel', 'systemFields.monster.fields.level.label', 'system.monster.level', 'system.evLabel',
  'showMalice', 'malice.label', 'malice.value',
]);

/**
 * What the header adds from the sheet's own figures. Each is empty or false
 * on a player's screen (checked below by building the figures as a player),
 * and the Director-only ones sit inside a Director-only block.
 */
const HEADER_FIGURES = new Set([
  'npc.villain.inFight', 'npc.page.chips.length', 'npc.page.chips', 'chip.kind', 'chip.name', 'npc.isGM',
  'npc.negotiation.impressionText', 'npc.talk.show', 'npc.talk.pressed',
]);

/** Template helpers, keywords and literals, which are not data. */
const HELPERS = new Set([
  'if', 'unless', 'each', 'with', 'else', 'as', 'this', 'localize', 'concat', 'ifThen', 'disabled', 'not', 'or',
  'and', 'eq', 'formInput', 'formGroup', 'numberFormat', 'lookup', 'true', 'false', 'null',
]);

/** Every data path a template reads, from each {{…}} expression. */
function dataPaths(src) {
  const paths = new Set();
  for (const m of src.matchAll(/\{\{\{?([\s\S]*?)\}?\}\}/g)) {
    let body = m[1].trim();
    if (/^(\/|else\b|#\*inline)/.test(body)) continue;
    const partial = body.startsWith('>');
    body = body.replace(/^[#>~]\s*/, '')
      .replace(/"[^"]*"/g, ' ')
      .replace(/\|[^|]*\|/g, ' ')
      .replace(/[\w-]+=/g, ' ')
      .replace(/[()]/g, ' ');
    const words = body.split(/\s+/).filter(Boolean);
    if (partial) words.shift();
    for (const w of words) if (!HELPERS.has(w) && !/^-?\d/.test(w)) paths.add(w);
  }
  return [...paths];
}

/** Every .hbs under templates/npc-looks, as module paths. */
function templatesOnDisk(dir = DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? templatesOnDisk(join(dir, e.name))
    : e.name.endsWith('.hbs') ? [`modules/chronicle-sync/${relative(ROOT, join(dir, e.name))}`] : []));
}

/** The lang file's keys, dotted. */
function langKeys() {
  const out = new Set();
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
      else out.add(`${prefix}${k}`);
    }
  };
  walk(JSON.parse(readFileSync(resolve(ROOT, 'lang/en.json'), 'utf8')), '');
  return out;
}

/** The text between an `{{#if cond}}` and its matching `{{/if}}`, for each such block. */
function ifBlocks(src, cond) {
  const out = [];
  const open = `{{#if ${cond}}}`;
  for (let at = src.indexOf(open); at !== -1; at = src.indexOf(open, at + 1)) {
    let depth = 0;
    const re = /\{\{(#if|\/if)\b[^}]*\}\}/g;
    re.lastIndex = at;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      depth += m[1] === '#if' ? 1 : -1;
      if (depth === 0) {
        out.push(src.slice(at, m.index));
        break;
      }
    }
  }
  return out;
}

/** Every template on disk, so a look's templates are checked before it joins the catalogue. */
const TEMPLATES = templatesOnDisk();

/** The look folders on disk. */
const LOOKS = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

/** The template a look on disk draws a part with: its own, else the Chronicle look's. */
function lookPart(look, shape, part) {
  const own = resolve(DIR, look, `${shape}-${part}.hbs`);
  return existsSync(own) ? own : resolve(DIR, 'chronicle', `${shape}-${part}.hbs`);
}

test('every look in the catalogue has its templates, and every template on disk is one the sheet draws', () => {
  assert.deepEqual(LOOKS, [...NPC_LOOKS].sort());
  const drawn = allNpcLookTemplates();
  for (const path of drawn) assert.ok(existsSync(onDisk(path)), `missing ${path}`);
  assert.deepEqual([...TEMPLATES].sort(), [...drawn].sort());
  for (const look of NPC_LOOKS) {
    for (const shape of SHAPES) {
      for (const part of NPC_LOOK_PARTS) assert.ok(drawn.includes(npcLookTemplate(look, shape, part)), `${look} ${shape}-${part}`);
    }
  }
});

test('a look without NPC templates draws the Chronicle look, and parts it doesn\'t draw are Draw Steel\'s', () => {
  assert.equal(npcLookTemplate('hall', 'npc', 'header'), 'modules/chronicle-sync/templates/npc-looks/chronicle/npc-header.hbs');
  assert.equal(npcLookTemplate('chronicle', 'monster', 'tabs'), null);
});

test('the sheet handles its own actions, and none hides a Draw Steel action but the ability use it wraps', () => {
  const Sheet = makeChronicleNpcSheet(class { static PARTS = {}; static TABS = {}; });
  assert.deepEqual(Object.keys(Sheet.DEFAULT_OPTIONS.actions).sort(), [...NPC_ACTIONS, 'useAbility'].sort());
  for (const name of [...NPC_ACTIONS, ...HERO_ACTIONS]) assert.ok(!KNOWN_ACTIONS.has(name), `${name} would hide a Draw Steel action`);
  assert.ok(Sheet.DEFAULT_OPTIONS.classes.includes('chronicle-npc-sheet'));
  assert.equal(NPC_SHEET_CLASS, 'chronicle-sync.ChronicleNpcSheet');
});

test('the creature flag is the one creature sync writes', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/creature-sync.mjs'), 'utf8');
  assert.match(src, new RegExp(`export const CREATURE_FLAG = '${CREATURE_FLAG}';`));
});

test('every action in every template is one Draw Steel or the sheet handles', () => {
  for (const path of TEMPLATES) {
    const src = read(onDisk(path));
    for (const m of src.matchAll(/data-action="([^"]*)"/g)) {
      const name = m[1];
      assert.ok(KNOWN_ACTIONS.has(name) || HERO_ACTIONS.has(name) || NPC_ACTIONS.has(name), `${path}: unknown action ${name}`);
    }
  }
});

test('every lang key the templates and the sheet use exists', () => {
  const keys = langKeys();
  const used = new Set();
  for (const path of TEMPLATES) {
    const src = read(onDisk(path));
    for (const m of src.matchAll(/"(CHRONICLE\.[\w.]+[\w])"/g)) used.add(m[1]);
    // A key built with concat: every value the sheet's figures can give it.
    for (const m of src.matchAll(/concat "(CHRONICLE\.NpcSheet\.[\w.]+\.)"/g)) used.add(`${m[1]}*`);
  }
  const values = {
    'CHRONICLE.NpcSheet.Villain.State.': ['used', 'next', 'unused'],
    'CHRONICLE.NpcSheet.Kind.': ['motivation', 'pitfall'],
    'CHRONICLE.NpcSheet.State.': ['found', 'used', 'hidden'],
    // The Seen line is drawn only when there is a negotiation, so never for source "none".
    'CHRONICLE.NpcSheet.Seen.': ['chronicle', 'players', 'offline', 'actor'].flatMap((s) => [`${s}Shown`, `${s}Hidden`]),
  };
  for (const key of [...used]) {
    if (!key.endsWith('*')) continue;
    used.delete(key);
    const prefix = key.slice(0, -1);
    assert.ok(values[prefix], `no known values for ${prefix}`);
    for (const v of values[prefix]) used.add(`${prefix}${v}`);
  }
  for (let n = 0; n <= 5; n++) used.add(`CHRONICLE.NpcSheet.Answer.${n}`);
  for (const id of SHAPES) used.add(`CHRONICLE.NpcSheet.Shape.${id}`);
  for (const id of ['talk', 'people']) used.add(`CHRONICLE.NpcSheet.Tabs.${id}`);
  for (const file of ['scripts/npc-looks.mjs', 'scripts/_npc-looks.mjs']) {
    for (const m of readFileSync(resolve(ROOT, file), 'utf8').matchAll(/'(CHRONICLE\.[\w.]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `missing lang keys: ${missing.join(', ')}`);
});

for (const shape of SHAPES) {
  for (const look of LOOKS) {
    const header = read(lookPart(look, shape, 'header'));
    const stats = read(lookPart(look, shape, 'stats'));
    const card = read(lookPart(look, shape, 'card'));

    test(`${look} ${shape}: the header reads only Draw Steel's header and the sheet's player-safe figures`, () => {
      const extra = dataPaths(header).filter((p) => !HEADER_MAY_READ.has(p) && !HEADER_FIGURES.has(p));
      assert.deepEqual(extra, [], `header reads ${extra.join(', ')}`);
      // Director-only figures sit inside the Director's blocks.
      const outside = (src, cond) => ifBlocks(src, cond).reduce((s, block) => s.replace(block, ''), src);
      assert.doesNotMatch(outside(header, 'npc.isGM'), /impressionText/);
      assert.doesNotMatch(outside(header, 'showMalice'), /data-setting="malice"|malice\.value/);
    });

    test(`${look} ${shape}: the header keeps the portrait, the name and Draw Steel's metadata button`, () => {
      const h = flat(header);
      assert.match(h, /data-action="csPortraitMenu" aria-haspopup="menu"/);
      assert.match(h, /<img class="cs-portrait" [^>]*data-edit="img"/);
      assert.match(h, /formInput fields\.name value=source\.name/);
      assert.match(h, /\{\{#unless isPlay\}\}.*data-action="editMonsterMetadata"/);
    });

    test(`${look} ${shape}: stats keep Draw Steel's inputs and its stat editors`, () => {
      const s = flat([stats, ...TEMPLATES.filter((p) => p.includes(`/${look}/`) && !/-(header|stats|card)\.hbs$/.test(p)).map((p) => read(onDisk(p)))].join(' '));
      if (shape === 'monster' || /numbers-row/.test(stats)) {
        assert.match(s, /data-action="roll" data-roll-type="characteristic" data-characteristic="\{\{key\}\}"/);
        assert.match(s, /\{\{disabled \(not @root\.owner\)\}\}/);
        assert.match(s, /\{\{#if editable\}\}[^{]*?data-action="freeStrike"/);
        for (const input of ['systemFields.stamina.fields.value value=system.stamina.value', 'systemFields.stamina.fields.temporary value=system.stamina.temporary']) {
          const call = s.match(new RegExp(`\\{\\{formInput ${input.replace(/\./g, '\\.')}[^}]*\\}\\}`));
          assert.ok(call, `missing input: ${input}`);
          assert.match(call[0], /dataset=datasets\.notSource/, `${input} needs dataset=datasets.notSource`);
        }
        assert.match(s, /name="squadStaminaValue" value="\{\{combatGroup\.system\.staminaValue\}\}"/);
      }
      assert.match(flat(stats), /\{\{else\}\} \{\{> "modules\/chronicle-sync\/templates\/npc-looks\/edit-stats\.hbs"\}\}/);
      const edit = flat(read(resolve(DIR, 'edit-stats.hbs')));
      for (const partial of DS_STAT_PARTIALS) assert.ok(edit.includes(`{{> "${partial}"`), partial);
      assert.match(edit, /formGroup systemFields\.stamina\.fields\.max value=systemSource\.stamina\.max dataset=datasets\.isSource/);
      assert.match(edit, /formGroup systemFields\.monster\.fields\.freeStrike value=systemSource\.monster\.freeStrike dataset=datasets\.isSource/);
    });

    test(`${look} ${shape}: the boxes are not a tab, so they stay above the tab row`, () => {
      const root = stats.match(/<section([^>]*)>/);
      assert.ok(root);
      assert.doesNotMatch(root[1], /data-tab=|\bclass="[^"]*\btab\b/);
    });

    test(`${look} ${shape}: the card changes nothing by typing but Malice, which only the Director gets`, () => {
      const c = flat(card);
      assert.match(c, /data-action="csUnfold"/);
      assert.match(c, /data-action="csPortraitMenu" aria-haspopup="menu"/);
      const outside = ifBlocks(card, 'showMalice').reduce((s, block) => s.replace(block, ''), card);
      assert.doesNotMatch(outside, /formInput|formGroup|<input|<select|<textarea|contenteditable/);
      for (const block of ifBlocks(card, 'showMalice')) assert.match(block, /data-setting="malice"/);
    });
  }
}

test('every Director-only thing has the amber edge, the mark and the words', () => {
  for (const path of TEMPLATES) {
    const src = read(onDisk(path));
    for (const m of src.matchAll(/class="[^"]*\bcs-dm-only\b[^"]*"|class="cs-dm-only"/g)) {
      const after = src.slice(m.index, m.index + 600);
      assert.match(after, /cs-dm-mark/, `${path}: a Director-only box needs the ⊘ mark`);
      assert.match(after, /CHRONICLE\.NpcSheet\.OnlyYou/, `${path}: a Director-only box needs the words`);
    }
  }
});

test('the Talk and People tabs are tabs of the primary group', () => {
  for (const id of ['talk', 'people']) {
    const src = read(resolve(DIR, `${id}.hbs`));
    assert.match(src, new RegExp(`<section class="tab [^"]*\\{\\{tab\\.cssClass\\}\\}" data-group="primary" data-tab="${id}"`));
  }
});

test('the path reader catches a Director-only figure in the header', () => {
  const leak = '{{#if npc.isGM}}{{npc.negotiation.impressionText}}{{/if}}{{npc.page.open}}{{system.negotiation.interest}}';
  const extra = dataPaths(leak).filter((p) => !HEADER_MAY_READ.has(p) && !HEADER_FIGURES.has(p));
  assert.deepEqual(extra.sort(), ['npc.page.open', 'system.negotiation.interest']);
  assert.equal(ifBlocks('a{{#if x}}b{{#if y}}c{{/if}}d{{/if}}e', 'x')[0], '{{#if x}}b{{#if y}}c{{/if}}d');
});

/* ---- The figures each screen holds ---- */

/** A stand-in for Draw Steel's NPC sheet: only what the Chronicle sheet calls. */
class FakeNpcSheet {
  static PARTS = {};
  static TABS = {};
  static DEFAULT_OPTIONS = { actions: { useAbility() {} } };
  constructor(actor) { this._actor = actor; this.tabGroups = {}; }
  get document() { return this._actor; }
  async _prepareContext() { return {}; }
}

function fakeActor(flags = {}) {
  return {
    uuid: 'Actor.orsen',
    name: 'Orsen',
    limited: false,
    isOwner: true,
    statuses: new Set(),
    itemTypes: { ability: [] },
    system: {
      negotiation: { interest: 4, patience: 3, impression: 6, motivations: new Set(['wealth']), pitfalls: new Set(['power']) },
      stamina: { value: 10, max: 20, temporary: 0, winded: 10, min: -10 },
      monster: { level: 2, freeStrike: 2 },
    },
    getFlag: (scope, key) => (scope === 'chronicle-sync' ? flags[key] : undefined),
    getActiveTokens: () => [{ id: 'tok1', document: { getFlag: () => null } }],
  };
}

const PAGE = {
  negotiation: {
    gm: {
      interest: 2, patience: 4, impression: 7, shown: false,
      motivations: ['wealth', 'legacy'], pitfalls: ['power'],
      found: { motivations: ['wealth'], pitfalls: [] }, used: [],
      log: [{ text: 'Offered him the deed', at: '2026-11-01T00:00:00Z' }],
    },
  },
  entity: {
    entry_html: '<p>Runs the ferry at Gallow Bend.</p><p><span data-secret="true">He sold the party out to the Baron.</span></p>',
    fields_data: { faction: 'River Guild' },
    tags: [{ name: 'Ally' }, { name: 'Traitor', dmOnly: true }],
  },
  relations: [
    { targetEntityId: 'p2', targetEntityName: 'Mira', relationType: 'sister of' },
    { targetEntityId: 'p3', targetEntityName: 'The Baron', relationType: 'informant for', dmOnly: true },
  ],
};

/** Build the sheet on the stand-in, with Foundry's globals set for one test, and return its figures. */
async function figuresAs({ isGM, flags }) {
  const calls = [];
  const api = {
    get: async (path) => {
      calls.push(path);
      if (path.endsWith('/negotiation')) return PAGE.negotiation;
      if (path.endsWith('/relations')) return PAGE.relations;
      return PAGE.entity;
    },
  };
  const saved = Object.fromEntries(['game', 'ds', 'CONFIG', 'foundry', 'Hooks'].map((k) => [k, globalThis[k]]));
  let Sheet = null;
  Object.assign(globalThis, {
    game: {
      system: { id: 'draw-steel', version: '1.2.0' },
      user: { isGM },
      i18n: { localize: (k) => k },
      settings: { get: () => '' },
      actors: { malice: { value: 3 } },
      combat: null,
    },
    ds: { applications: { sheets: { DrawSteelNPCSheet: FakeNpcSheet } }, CONFIG: { negotiation: { motivations: {} } }, CONST: {} },
    CONFIG: { statusEffects: {} },
    foundry: { documents: { collections: { Actors: { registerSheet: (scope, cls) => { Sheet = cls; } } } } },
    Hooks: { on() {} },
  });
  try {
    assert.equal(registerNpcLooks(() => api), true);
    const sheet = new Sheet(fakeActor(flags));
    const context = await sheet._prepareContext({});
    return { npc: context.npc, calls };
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('a player\'s screen holds nothing the Director only may know, and never asks Chronicle', async () => {
  const { npc, calls } = await figuresAs({ isGM: false, flags: { entityId: 'page-1' } });
  assert.equal(npc.shape, 'npc');
  assert.deepEqual(calls, []);
  assert.deepEqual(npc.page, { open: [], chips: [] });
  assert.deepEqual(npc.people, []);
  assert.equal(npc.pageUrl, null);
  assert.equal(npc.talk.show, false);
  assert.equal(npc.malice.show, false);
  assert.equal(npc.onlyYou, null);
  assert.doesNotMatch(JSON.stringify(npc), /sold the party out|Traitor|Baron|Gallow/);
  assert.equal(npc.negotiation.source, 'players');
  assert.equal(npc.negotiation.impression, null);
  assert.equal(npc.negotiation.impressionText, '–');
  // The meters aren't shown yet, so Draw Steel's starting values aren't passed off as real.
  assert.equal(npc.negotiation.interest, null);
  assert.equal(npc.negotiation.shown, false);
  assert.ok(npc.negotiation.rows.every((r) => r.state === 'found'));
});

test('a player sees the meters once the Director has shown them', async () => {
  const { npc } = await figuresAs({ isGM: false, flags: { entityId: 'page-1', negotiationShown: true } });
  assert.equal(npc.negotiation.shown, true);
  assert.equal(npc.negotiation.interest, 4);
  assert.equal(npc.negotiation.impression, null);
});

test('the Director\'s screen reads the page live, its secret text only in the "Only you" drawer', async () => {
  const { npc, calls } = await figuresAs({ isGM: true, flags: { entityId: 'page-1' } });
  assert.deepEqual(calls.sort(), ['/entities/page-1', '/entities/page-1/relations', '/entities/page-1/system-state/drawsteel/negotiation']);
  assert.equal(npc.negotiation.source, 'chronicle');
  assert.equal(npc.negotiation.impression, 7);
  assert.deepEqual(npc.negotiation.rows.map((r) => `${r.key}:${r.state}`), ['wealth:found', 'legacy:hidden', 'power:hidden']);
  assert.deepEqual(npc.page.open, ['Runs the ferry at Gallow Bend.']);
  assert.deepEqual(npc.page.chips.map((c) => c.name), ['River Guild', 'Ally']);
  assert.deepEqual(npc.people.map((p) => [p.name, p.dmOnly]), [['Mira', false], ['The Baron', true]]);
  assert.equal(npc.talk.show, true);
  // The page's secret text is only in the drawer, never in the open text or the chips.
  assert.deepEqual(npc.onlyYou.secrets, ['He sold the party out to the Baron.']);
  assert.deepEqual(npc.onlyYou.hidden.map((r) => r.key), ['legacy', 'power']);
  assert.deepEqual(npc.onlyYou.given.map((r) => r.key), ['wealth']);
  assert.equal(npc.onlyYou.impressionText, '7');
  assert.doesNotMatch(JSON.stringify({ ...npc, onlyYou: null }), /sold the party out/);
});

test('a monster asks Chronicle nothing, even for the Director', async () => {
  const { npc, calls } = await figuresAs({ isGM: true, flags: { [CREATURE_FLAG]: 'page-9', [LINK_FLAG]: 'page-1' } });
  assert.equal(npc.shape, 'monster');
  assert.deepEqual(calls, []);
  assert.equal(npc.negotiation, null);
  assert.equal(npc.malice.show, true);
});
