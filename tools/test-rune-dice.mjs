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
  ASSET_ROOT, GROUP, MANIFEST_PATH, appearanceFor, buildRegistrations, colorsetId, readManifest, safeAssetPath, systemId,
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
      { id: 'ember', name: 'Ember', colours: { background: '#330000', foreground: 'red' }, material: 'metal' },
      { id: 'ember', name: 'Again' },
      { id: 'frost', material: 'lava', faces: { d6: faces('d6', 6), d13: [] } },
    ],
  });
  assert.deepEqual(r.sets.map((s) => s.id), ['ember', 'frost']);
  assert.deepEqual(r.sets[0].colours, { background: '#330000' });
  assert.equal(r.sets[0].material, 'metal');
  assert.equal(r.sets[1].name, 'frost');
  assert.equal(r.sets[1].material, null);
  assert.deepEqual(Object.keys(r.sets[1].faces), ['d6']);
  assert.deepEqual(r.problems.map((p) => p.code), ['SetId', 'SetColour', 'SetDuplicate', 'SetMaterial', 'FaceType']);
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
  const short = readManifest({ version: 1, sets: [{ id: 'a', faces: { d20: faces('d20', 19) } }] });
  assert.deepEqual(short.sets[0].faces, {});
  assert.equal(short.problems[0].code, 'FaceList');
  const outside = faces('d6', 6);
  outside[2] = 'modules/other/x.webp';
  assert.equal(readManifest({ version: 1, sets: [{ id: 'a', faces: { d6: outside } }] }).problems[0].code, 'FaceList');
});

test('registrations: a colour theme per set, a dice set only where there is art', () => {
  const { sets } = readManifest({
    version: 1,
    sets: [
      { id: 'ember', name: 'Ember', colours: { background: '#300' }, faces: { d6: faces('d6', 6) }, models: { d20: `${ASSET_ROOT}ember/d20.glb` } },
      { id: 'plain', name: 'Plain' },
    ],
  });
  const r = buildRegistrations(sets, 'modules/chronicle-sync');
  assert.deepEqual(r.colorsets.map((c) => c.name), [colorsetId('ember'), colorsetId('plain')]);
  assert.equal(r.colorsets[0].category, GROUP);
  assert.equal(r.colorsets[0].background, '#300');
  assert.deepEqual(r.systems, [{ id: systemId('ember'), name: 'Ember', group: GROUP }]);
  assert.deepEqual(r.presets.map((p) => p.type), ['d6', 'd20']);
  assert.ok(r.presets[0].labels.every((p) => p.startsWith('modules/chronicle-sync/assets/dice/rune/')));
  assert.equal(r.presets[1].modelFile, 'modules/chronicle-sync/assets/dice/rune/ember/d20.glb');
  assert.equal(r.files.length, 7);
});

test("a die wears its roller's set only when that set registered here", () => {
  const registered = { colorsets: new Set([colorsetId('ember'), colorsetId('plain')]), systems: new Set([systemId('ember')]) };
  assert.deepEqual(appearanceFor({ set: 'ember' }, registered), { colorset: colorsetId('ember'), system: systemId('ember') });
  assert.deepEqual(appearanceFor({ set: 'plain', colour: '#123456' }, registered), { colorset: colorsetId('plain'), background: '#123456' });
  assert.deepEqual(appearanceFor({ set: 'plain', colour: 'url(x)' }, registered), { colorset: colorsetId('plain') });
  assert.equal(appearanceFor({ set: 'gone' }, registered), null);
  assert.equal(appearanceFor({}, registered), null);
  assert.equal(appearanceFor({ set: 'ember' }, null), null);
});

test('the shipped list reads cleanly and every file it names exists', () => {
  const raw = JSON.parse(readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf8'));
  const r = readManifest(raw);
  assert.deepEqual(r.problems, []);
  assert.equal(r.sets.length, raw.sets.length);
  for (const f of buildRegistrations(r.sets, '').files) assert.ok(existsSync(resolve(ROOT, f)), f);
});
