#!/usr/bin/env node
/**
 * The Chronicle hero sheet's templates keep the markup Draw Steel's hero
 * sheet handlers read. Nothing reports a broken one: a missing attribute
 * just makes a button or drop do nothing until someone clicks it in a live
 * world. So every look's header and stats templates are scanned here for
 * the actions, input names and attributes Draw Steel's sheet code reads,
 * and the header for anything a Limited viewer must not see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { HERO_LOOKS } from '../scripts/_hero-looks.mjs';

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

/** Hero data a Limited viewer never sees, so it never goes in a header. */
const NOT_IN_HEADER = /\b(stamina|recoveries|characteristics?|hero\.primary|hero\.epic|surges|potency|statuses|conditions|skills|kits|biography|director|damageIW|chronicle\.)/;

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
    for (const part of ['header', 'stats']) {
      assert.ok(existsSync(join(LOOKS_DIR, look.id, `${part}.hbs`)), `${look.id}/${part}.hbs`);
    }
  }
});

for (const look of looksOnDisk()) {
  const header = read(join(LOOKS_DIR, look, 'header.hbs'));
  const stats = read(join(LOOKS_DIR, look, 'stats.hbs'));

  test(`${look}: every action is one Draw Steel handles`, () => {
    for (const file of templatesOf(look)) {
      const src = read(file);
      for (const m of src.matchAll(/data-action="(\{\{[^}]*\}\}|[^"]*)"/g)) {
        // A computed action names each choice as a quoted string.
        const names = m[1].startsWith('{{') ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [m[1]];
        assert.ok(names.length, `${file}: no action in ${m[0]}`);
        for (const name of names) assert.ok(KNOWN_ACTIONS.has(name), `${file}: unknown action ${name}`);
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
    assert.match(h, /"showPortraitArtwork"/);
    assert.match(h, /"editImage"/);
    assert.match(h, /data-edit="img"/);
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

  test(`${look}: header shows nothing a Limited viewer may not see`, () => {
    const m = header.match(NOT_IN_HEADER);
    assert.equal(m, null, `header names ${m?.[0]}`);
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
    assert.match(s, /formInput systemFields\.skills\.fields\.value value=systemSource\.skills\.value options=skills\.options dataset=datasets\.isSource/);
  });

  test(`${look}: the boxes are not a tab, so they stay above the tab row`, () => {
    const root = tags(stats)[0];
    assert.equal(root.name, 'section');
    assert.doesNotMatch(root.attrs, /data-tab=|\bclass="[^"]*\btab\b/);
  });
}
