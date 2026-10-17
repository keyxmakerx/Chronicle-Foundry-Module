#!/usr/bin/env node
/**
 * Rune dice for Dice So Nice (scripts/_rune-dice.mjs): one bad set never
 * drops the others, no set can point Dice So Nice outside the module's dice
 * folder, and a die whose set didn't register keeps the viewer's own look.
 * Also pins that the shipped list reads cleanly and every file it names is
 * in the repo, so a moved file fails here before it ships.
 *
 * Run: node --test tools/test-rune-dice.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ASSET_ROOT, GROUP, MANIFEST_PATH, RUNE_SET_IDS, appearanceFor, buildRegistrations, colorsetId, readManifest, safeAssetPath, systemId,
} from '../scripts/_rune-dice.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const faces = (type, n) => Array.from({ length: n }, (_, i) => `${ASSET_ROOT}ember/${type}-${i + 1}.webp`);

test('a broken list is one problem, never a throw', () => {
  for (const bad of [undefined, null, 'x', 4, {}, { sets: 'no' }]) {
    const r = readManifest(bad);
    assert.deepEqual(r.sets, []);
    assert.equal(r.problems[0].code, 'ManifestShape');
  }
  assert.equal(readManifest({ version: 2, sets: [] }).problems[0].code, 'ManifestVersion');
});

test('a bad set drops alone; good sets keep loading', () => {
  const r = readManifest({
    version: 1,
    sets: [
      { id: 'Bad Id!', name: 'x' },
      {
        id: 'cage', name: 'Verdant cage', material: 'metal',
        colours: [
          { id: 'bronze', name: 'Bronze', background: '#330000', foreground: 'red' },
          { id: 'bronze', name: 'Again' },
          { id: 'Iron!' },
          { id: 'iron', name: 'Iron', edge: '#222' },
        ],
      },
      { id: 'cage', name: 'Again' },
      { id: 'frost', material: 'lava', faces: { d6: faces('d6', 6), d13: [] } },
    ],
  });
  assert.deepEqual(r.sets.map((s) => s.id), ['cage', 'frost']);
  assert.deepEqual(r.sets[0].colours, [
    { id: 'bronze', name: 'Bronze', values: { background: '#330000' } },
    { id: 'iron', name: 'Iron', values: { edge: '#222' } },
  ]);
  assert.equal(r.sets[0].material, 'metal');
  assert.equal(r.sets[1].name, 'frost');
  assert.equal(r.sets[1].material, null);
  assert.deepEqual(r.sets[1].colours, [{ id: 'default', name: 'frost', values: {} }]);
  assert.deepEqual(Object.keys(r.sets[1].faces), ['d6']);
  assert.deepEqual(r.problems.map((p) => p.code), ['SetId', 'SetColour', 'ColourId', 'ColourId', 'SetDuplicate', 'SetUnknown', 'SetMaterial', 'FaceType']);
});

test('no path can leave the dice folder or the module', () => {
  const img = /\.(png|webp)$/;
  assert.equal(safeAssetPath(`${ASSET_ROOT}a/d6-1.webp`, img), `${ASSET_ROOT}a/d6-1.webp`);
  for (const p of [
    `${ASSET_ROOT}../../../dice-so-nice/x.webp`,
    'modules/other/x.webp',
    'https://evil.example/x.webp',
    `${ASSET_ROOT}a.webp?x=1`,
    `${ASSET_ROOT}a\\b.webp`,
    `${ASSET_ROOT}a.svg`,
    42,
  ]) assert.equal(safeAssetPath(p, img), null, String(p));
});

test('a face list must cover every face of its die', () => {
  const short = readManifest({ version: 1, sets: [{ id: 'cage', faces: { d20: faces('d20', 19) } }] });
  assert.deepEqual(short.sets[0].faces, {});
  assert.equal(short.problems[0].code, 'FaceList');
  const outside = faces('d6', 6);
  outside[2] = 'modules/other/x.webp';
  assert.equal(readManifest({ version: 1, sets: [{ id: 'cage', faces: { d6: outside } }] }).problems[0].code, 'FaceList');
});

test('registrations: a theme per set colour, a dice set only where there is art', () => {
  const { sets } = readManifest({
    version: 1,
    sets: [
      {
        id: 'cage', name: 'Verdant cage',
        colours: [{ id: 'bronze', name: 'Bronze', background: '#300' }, { id: 'iron', name: 'Iron' }],
        faces: { d6: faces('d6', 6) }, models: { d20: `${ASSET_ROOT}ember/d20.glb` },
      },
      { id: 'plain', name: 'Plain' },
    ],
  });
  const r = buildRegistrations(sets, 'modules/chronicle-sync');
  assert.deepEqual(r.colorsets.map((c) => c.name), [colorsetId('cage', 'bronze'), colorsetId('cage', 'iron'), colorsetId('plain', 'default')]);
  assert.deepEqual(r.colorsets.map((c) => c.description), ['Verdant cage: Bronze', 'Verdant cage: Iron', 'Plain']);
  assert.equal(r.colorsets[0].category, GROUP);
  assert.equal(r.colorsets[0].background, '#300');
  assert.equal(r.setOf.get(colorsetId('cage', 'iron')), 'cage');
  assert.deepEqual(r.systems, [{ id: systemId('cage'), name: 'Verdant cage', group: GROUP }]);
  assert.deepEqual(r.presets.map((p) => [p.type, p.colorset]), [['d6', colorsetId('cage', 'bronze')], ['d20', colorsetId('cage', 'bronze')]]);
  assert.ok(r.presets[0].labels.every((p) => p.startsWith('modules/chronicle-sync/assets/dice/rune/')));
  assert.equal(r.presets[1].modelFile, 'modules/chronicle-sync/assets/dice/rune/ember/d20.glb');
  assert.equal(r.files.length, 7);
  assert.notEqual(colorsetId('a-b', 'c'), colorsetId('a', 'b-c'));
});

test("a die wears its roller's set and colour only when they registered here", () => {
  const registered = {
    colorsets: new Set([colorsetId('cage', 'bronze'), colorsetId('cage', 'iron'), colorsetId('plain', 'default')]),
    systems: new Set([systemId('cage')]),
    defaults: new Map([['cage', colorsetId('cage', 'bronze')], ['plain', colorsetId('plain', 'default')]]),
  };
  assert.deepEqual(appearanceFor({ set: 'cage', colour: 'iron' }, registered), { colorset: colorsetId('cage', 'iron'), system: systemId('cage') });
  assert.deepEqual(appearanceFor({ set: 'cage', colour: 'gold' }, registered), { colorset: colorsetId('cage', 'bronze'), system: systemId('cage') });
  assert.deepEqual(appearanceFor({ set: 'cage' }, registered), { colorset: colorsetId('cage', 'bronze'), system: systemId('cage') });
  assert.deepEqual(appearanceFor({ set: 'plain', colour: 'url(x)' }, registered), { colorset: colorsetId('plain', 'default') });
  assert.equal(appearanceFor({ set: 'gone' }, registered), null);
  assert.equal(appearanceFor({}, registered), null);
  assert.equal(appearanceFor({ set: 'cage' }, null), null);
});

test('the shipped list reads cleanly and every file it names exists', () => {
  const raw = JSON.parse(readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf8'));
  const r = readManifest(raw);
  assert.deepEqual(r.problems, []);
  assert.equal(r.sets.length, raw.sets.length);
  for (const f of buildRegistrations(r.sets, '').files) assert.ok(existsSync(resolve(ROOT, f)), f);
});

test('the twelve rune sets are known; anything else is flagged but still loads', () => {
  assert.equal(RUNE_SET_IDS.length, 12);
  const known = readManifest({ version: 1, sets: RUNE_SET_IDS.map((id) => ({ id })) });
  assert.deepEqual(known.problems, []);
  const odd = readManifest({ version: 1, sets: [{ id: 'ember' }] });
  assert.deepEqual(odd.problems, [{ code: 'SetUnknown', set: 'ember' }]);
  assert.equal(odd.sets.length, 1);
});
