#!/usr/bin/env node
/**
 * The Chronicle hero sheet's templates keep the markup Draw Steel's hero
 * sheet handlers read. Nothing reports a broken one: a missing attribute
 * just makes a button or drop do nothing until someone clicks it in a live
 * world. So every look's header and stats templates are scanned here for
 * the actions, input names and attributes Draw Steel's sheet code reads.
 * Every field they read must be one Draw Steel's own hero templates read, and
 * the header, which a Limited viewer gets with the tab row and Biography,
 * may read only what Draw Steel's header reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { HERO_LOOKS } from '../scripts/_hero-looks.mjs';
import { makeChronicleHeroSheet } from '../scripts/hero-looks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOOKS_DIR = resolve(ROOT, 'templates/hero-looks');
const strip = (src) => src.replace(/\{\{!--[\s\S]*?--\}\}/g, '').replace(/\{\{![^}]*\}\}/g, '');
const read = (p) => strip(readFileSync(p, 'utf8'));
const flat = (src) => src.replace(/\s+/g, ' ');

/** Actions Draw Steel's hero sheet (and Foundry's sheet base) handle. */
const KNOWN_ACTIONS = new Set([
  'roll', 'toggleStatus', 'createDoc', 'addOrigin', 'fillTrait', 'modifyItemQuantity', 'useAbility',
  'rollProject', 'rollFollower', 'levelUp', 'gainSurges', 'takeRespite', 'spendRecovery',
  'spendStaminaHeroToken', 'editCharacteristics', 'editCombat', 'showPortraitArtwork', 'editImage',
  'viewDoc', 'deleteDoc', 'toggleDocumentDescription', 'documentListContext', 'toggleMode',
  'createPseudoDocument', 'deletePseudoDocument', 'renderPseudoDocumentSheet',
]);

/** The sheet's own actions: the portrait menu and the card's way back to the full sheet. */
const CHRONICLE_ACTIONS = new Set(['csPortraitMenu', 'csUnfold', 'csFold', 'csLookPicker']);

/** The parts each look draws with its own templates. */
const LOOK_PARTS = ['header', 'stats', 'card'];

/** Draw Steel's stat editors, as its own stats template includes them. */
const DS_STAT_PARTIALS = ['characteristics', 'combat', 'movement', 'immunities-weaknesses']
  .map((n) => `systems/draw-steel/templates/sheets/actor/shared/partials/stats/${n}.hbs`);

/** The play-mode inputs bound to prepared values: each needs data-source="false" for effect locks. */
const PLAY_INPUTS = [
  'systemFields.stamina.fields.value value=system.stamina.value',
  'systemFields.stamina.fields.temporary value=system.stamina.temporary',
  'systemFields.recoveries.fields.value value=system.recoveries.value',
  'systemFields.hero.fields.primary.fields.value value=system.hero.primary.value',
  'systemFields.hero.fields.surges value=system.hero.surges',
  'systemFields.hero.fields.epic.fields.value value=system.hero.epic.value',
];

/**
 * Every form field Draw Steel 1.1.2's hero header, stats and stat partials
 * read, copied from those templates (a trailing `.label` dropped). A path
 * outside this list is a field Draw Steel doesn't have where we think it is:
 * formInput would get undefined and Edit mode would break.
 */
const DS_FIELDS = new Set([
  'systemFields.characteristics', 'systemFields.combat', 'systemFields.combat.fields.size',
  'systemFields.combat.fields.size.fields.letter', 'systemFields.combat.fields.size.fields.value',
  'systemFields.combat.fields.stability', 'systemFields.damage.fields.immunities',
  'systemFields.damage.fields.weaknesses', 'systemFields.hero.fields.epic.fields.value',
  'systemFields.hero.fields.primary.fields.value', 'systemFields.hero.fields.surges',
  'systemFields.hero.fields.victories', 'systemFields.hero.fields.xp', 'systemFields.movement',
  'systemFields.movement.fields.disengage', 'systemFields.movement.fields.hover',
  'systemFields.movement.fields.types', 'systemFields.movement.fields.value', 'systemFields.recoveries',
  'systemFields.recoveries.fields.max', 'systemFields.recoveries.fields.value', 'systemFields.skills.fields.value',
  'systemFields.stamina', 'systemFields.stamina.fields.temporary', 'systemFields.stamina.fields.value',
  'systemSource.combat.size.letter', 'systemSource.combat.size.value', 'systemSource.combat.stability',
  'systemSource.damage.immunities', 'systemSource.damage.weaknesses', 'systemSource.hero.victories',
  'systemSource.hero.xp', 'systemSource.movement.disengage', 'systemSource.movement.hover',
  'systemSource.movement.types', 'systemSource.movement.value', 'systemSource.skills.value',
]);

/** Draw Steel 1.1.2's skills editor, copied from its hero stats template. */
const DS_SKILLS_INPUT = '{{formInput systemFields.skills.fields.value value=systemSource.skills.value options=skills.options dataset=datasets.isSource}}';

/**
 * What Draw Steel 1.1.2's hero header reads: portrait, name, class,
 * subclasses, origins, level, XP and victories. A Limited viewer gets the
 * header, so ours reads nothing else. Block and partial parameters are
 * listed by the names our header gives them.
 */
const HEADER_MAY_READ = new Set([
  'document.img', 'document.name', 'document.system.class', 'document.system.subclasses',
  'document.system.ancestry', 'document.system.culture', 'document.system.career',
  'cls.uuid', 'cls.name', 'sub.uuid', 'sub.name', 'subclass', 'originDoc', 'originDoc.uuid', 'originDoc.name',
  'originType', 'noEdit', 'isPlay', '@root.isPlay', 'editable',
  'avatarProperties.objectFit', 'avatarProperties.objectPosition', 'fields.name', 'source.name',
  'system.level', 'system.advancementReady', 'system.hero.xp', 'system.nextLevelXP', 'system.hero.victories',
  'system.victoriesMax', 'systemFields.hero.fields.xp.label', 'systemFields.hero.fields.victories.label',
  'systemFields.hero.fields.xp', 'systemFields.hero.fields.victories', 'systemSource.hero.xp', 'systemSource.hero.victories',
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

/** Each systemFields/systemSource path a template reads, without a trailing `.label`. */
function fieldPaths(src) {
  return [...new Set([...src.matchAll(/\bsystem(?:Fields|Source)\.[\w.]+/g)].map((m) => m[0].replace(/\.label$/, '')))];
}

function looksOnDisk() {
  if (!existsSync(LOOKS_DIR)) return [];
  return readdirSync(LOOKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function templatesOf(look) {
  return readdirSync(join(LOOKS_DIR, look)).filter((f) => f.endsWith('.hbs')).map((f) => join(LOOKS_DIR, look, f));
}

/** Every opening tag in a template, with its attribute text. */
function tags(src) {
  return [...src.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"]|"[^"]*")*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2] }));
}

test('every look in the catalogue has its templates, and every template folder is a look', () => {
  assert.deepEqual(looksOnDisk(), HERO_LOOKS.map((l) => l.id).sort());
  for (const look of HERO_LOOKS) {
    for (const part of LOOK_PARTS) {
      assert.ok(existsSync(join(LOOKS_DIR, look.id, `${part}.hbs`)), `${look.id}/${part}.hbs`);
    }
  }
});

test('the sheet handles each of its own actions', () => {
  const Sheet = makeChronicleHeroSheet(class { static PARTS = {}; static TABS = {}; });
  assert.deepEqual(Object.keys(Sheet.DEFAULT_OPTIONS.actions).sort(), [...CHRONICLE_ACTIONS].sort());
  for (const name of CHRONICLE_ACTIONS) assert.ok(!KNOWN_ACTIONS.has(name), `${name} would hide a Draw Steel action`);
});

for (const look of looksOnDisk()) {
  const header = read(join(LOOKS_DIR, look, 'header.hbs'));
  const stats = read(join(LOOKS_DIR, look, 'stats.hbs'));
  const card = read(join(LOOKS_DIR, look, 'card.hbs'));

  test(`${look}: every action is one Draw Steel or the sheet handles`, () => {
    for (const file of templatesOf(look)) {
      const src = read(file);
      for (const m of src.matchAll(/data-action="(\{\{[^}]*\}\}|[^"]*)"/g)) {
        // A computed action names each choice as a quoted string.
        const names = m[1].startsWith('{{') ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [m[1]];
        assert.ok(names.length, `${file}: no action in ${m[0]}`);
        for (const name of names) assert.ok(KNOWN_ACTIONS.has(name) || CHRONICLE_ACTIONS.has(name), `${file}: unknown action ${name}`);
      }
    }
  });

  test(`${look}: drag handles and description toggles keep Draw Steel's shape`, () => {
    for (const file of templatesOf(look)) {
      for (const t of tags(read(file))) {
        if (/\bclass="[^"]*\bdraggable\b/.test(t.attrs)) {
          assert.match(t.attrs, /data-document-uuid=/, `${file}: .draggable needs data-document-uuid on the same element`);
        }
        if (/data-action="toggleDocumentDescription"/.test(t.attrs)) {
          assert.equal(t.name, 'a', `${file}: the description toggle must be an <a>`);
        }
      }
    }
  });

  test(`${look}: header keeps the portrait, name, origins, level and respite`, () => {
    const h = flat(header);
    // The portrait opens the portrait menu, which runs Draw Steel's showPortraitArtwork
    // and editImage on the image; Foundry's file picker reads data-edit off it.
    assert.match(h, /<button type="button" class="cs-portrait-btn" data-action="csPortraitMenu" aria-haspopup="menu"/);
    assert.match(h, /<img class="cs-portrait" [^>]*data-edit="img"/);
    assert.match(h, /--avatar-object-fit/);
    assert.match(h, /formInput fields\.name value=source\.name/);
    for (const type of ['ancestry', 'culture', 'career', 'class']) {
      assert.match(h, new RegExp(`originDoc=document\\.system\\.${type} originType="${type}"`), `origin ${type}`);
    }
    assert.match(h, /originDoc=subclass originType="subclass" noEdit=true/);
    assert.match(h, /data-document-uuid="\{\{originDoc\.uuid\}\}"/);
    assert.match(h, /data-action="viewDoc"/);
    assert.match(h, /data-action="deleteDoc"/);
    assert.match(h, /data-action="addOrigin" data-type="\{\{originType\}\}"/);
    assert.match(h, /\{\{#if system\.advancementReady\}\}.*data-action="levelUp"/);
    assert.match(h, /data-action="takeRespite"/);
    assert.match(h, /formGroup systemFields\.hero\.fields\.xp value=systemSource\.hero\.xp/);
    assert.match(h, /formGroup systemFields\.hero\.fields\.victories value=systemSource\.hero\.victories/);
  });

  test(`${look}: header reads only what Draw Steel's header reads, since a Limited viewer sees it`, () => {
    const extra = dataPaths(header).filter((p) => !HEADER_MAY_READ.has(p));
    assert.deepEqual(extra, [], `header reads ${extra.join(', ')}`);
  });

  test(`${look}: every field is one Draw Steel's own hero templates read`, () => {
    for (const file of templatesOf(look)) {
      const unknown = fieldPaths(read(file)).filter((p) => !DS_FIELDS.has(p));
      assert.deepEqual(unknown, [], `${file} reads fields Draw Steel's hero sheet doesn't: ${unknown.join(', ')}`);
    }
  });

  test(`${look}: stats keeps Draw Steel's inputs, effect locks and buttons`, () => {
    const s = flat(stats);
    for (const input of PLAY_INPUTS) {
      const call = s.match(new RegExp(`\\{\\{formInput ${input.replace(/\./g, '\\.')}[^}]*\\}\\}`));
      assert.ok(call, `missing input: ${input}`);
      assert.match(call[0], /dataset=datasets\.notSource/, `${input} needs dataset=datasets.notSource`);
    }
    assert.match(s, /data-action="roll" data-roll-type="characteristic" data-characteristic="\{\{key\}\}"/);
    assert.match(s, /\{\{disabled \(not @root\.owner\)\}\}/);
    for (const action of ['spendStaminaHeroToken', 'spendRecovery', 'gainSurges']) {
      assert.match(s, new RegExp(`\\{\\{#if editable\\}\\}[^{]*?data-action="${action}"`), `${action} is offered only to someone who can edit`);
    }
    assert.match(s, /data-action="fillTrait" data-type="skill"/);
    assert.match(s, /\{\{#if chronicle\.showEpic\}\}/);
  });

  test(`${look}: Edit mode is Draw Steel's own stat editors`, () => {
    const s = flat(stats);
    for (const partial of DS_STAT_PARTIALS) assert.ok(s.includes(`{{> "${partial}"`), partial);
    assert.ok(s.includes(DS_SKILLS_INPUT), 'skills editor differs from Draw Steel\'s');
  });

  test(`${look}: the card's characteristics roll as Draw Steel's do, and it offers only what the viewer may do`, () => {
    const c = flat(card);
    assert.match(c, /data-action="roll" data-roll-type="characteristic" data-characteristic="\{\{key\}\}"/);
    assert.match(c, /\{\{disabled \(not @root\.owner\)\}\}/);
    assert.match(c, /\{\{#if editable\}\}[^{]*?data-action="takeRespite"/);
    assert.match(c, /data-action="csUnfold" data-tab="abilities"/);
    assert.match(c, /data-action="csPortraitMenu" aria-haspopup="menu"/);
    // Read-only: the card changes nothing by typing.
    assert.doesNotMatch(c, /formInput|formGroup|<input|<select|<textarea|contenteditable/);
  });

  test(`${look}: the boxes are not a tab, so they stay above the tab row`, () => {
    const root = tags(stats)[0];
    assert.equal(root.name, 'section');
    assert.doesNotMatch(root.attrs, /data-tab=|\bclass="[^"]*\btab\b/);
  });
}

test('the path readers catch a Limited leak and a field Draw Steel lacks', () => {
  const leak = '{{#if (eq system.hero.primary.value 2)}}<b>{{system.stamina.value}}</b>{{/if}}{{> csOrigin originDoc=document.system.kits}}';
  const extra = dataPaths(leak).filter((p) => !HEADER_MAY_READ.has(p));
  assert.deepEqual(extra.sort(), ['document.system.kits', 'system.hero.primary.value', 'system.stamina.value']);
  assert.deepEqual(dataPaths('{{#each document.system.subclasses as |sub|}}<a>{{sub.name}}</a>{{/each}}'), ['document.system.subclasses', 'sub.name']);
  const wrong = '{{formInput systemFields.hero.fields.skills value=systemSource.hero.skills}}';
  assert.deepEqual(fieldPaths(wrong).filter((p) => !DS_FIELDS.has(p)), ['systemFields.hero.fields.skills', 'systemSource.hero.skills']);
});
