#!/usr/bin/env node
/**
 * "Sync with Chronicle" in Dice So Nice (scripts/_rune-dice.mjs, wired in
 * scripts/dice-so-nice.mjs): the campaign's dice pick becomes copies of that
 * set's theme and dice under one fixed id, so a player who picks it follows
 * Chronicle. Runs against the shipped set list.
 *
 * Run: node --test tools/test-dice-sync.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  GROUP, MANIFEST_PATH, SYNC_ID, buildRegistrations, colorsetId, lookFromSettings, readLook, readManifest,
  syncRegistrations, systemId,
} from '../scripts/_rune-dice.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const { sets } = readManifest(JSON.parse(read(MANIFEST_PATH)));
const plan = buildRegistrations(sets, 'modules/chronicle-sync/');
const NAME = 'Sync with Chronicle';

test('the stored pick reads defensively', () => {
  assert.deepEqual(readLook('{"set":"oak","colour":"walnut"}'), { set: 'oak', colour: 'walnut' });
  assert.deepEqual(readLook(''), { set: '', colour: '' });
  assert.deepEqual(readLook('not json'), { set: '', colour: '' });
  assert.deepEqual(readLook({ set: '../x', colour: 5 }), { set: '', colour: '' });
  assert.deepEqual(lookFromSettings({ diceSet: 'nebula', diceColour: '' }), { set: 'nebula', colour: '' });
  assert.deepEqual(lookFromSettings(null), { set: '', colour: '' });
});

test('the picked set and colour are copied under the sync id', () => {
  const set = sets.find((s) => s.colours.length > 1);
  assert.ok(set, 'the shipped list has a set with several colours');
  const colour = set.colours[1].id;
  const sync = syncRegistrations(plan, { set: set.id, colour }, NAME);
  const source = plan.colorsets.find((cs) => cs.name === colorsetId(set.id, colour));
  assert.equal(sync.set, set.id);
  assert.equal(sync.colorset.name, SYNC_ID);
  assert.equal(sync.colorset.description, NAME);
  assert.equal(sync.colorset.category, GROUP);
  assert.equal(sync.colorset.background, source.background);
});

test('a set with faces gets a sync dice system; a colours-only set gets none', () => {
  const faces = Array.from({ length: 6 }, (_, i) => `assets/dice/rune/ember/d6-${i + 1}.webp`);
  const own = buildRegistrations([{ id: 'ember', name: 'Ember', colours: [{ id: 'default', name: 'Ember', values: { background: '#300' } }], material: '', faces: { d6: faces }, models: {} }], 'm/');
  const sync = syncRegistrations(own, { set: 'ember', colour: '' }, NAME);
  assert.deepEqual(sync.system, { id: SYNC_ID, name: NAME, group: GROUP });
  assert.equal(sync.presets.length, 1);
  assert.equal(sync.presets[0].system, SYNC_ID);
  assert.equal(sync.presets[0].colorset, SYNC_ID);
  assert.deepEqual(sync.presets[0].labels, own.presets[0].labels);
  assert.equal(own.presets[0].system, systemId('ember'));

  const plain = sets.find((s) => !Object.keys(s.faces).length && !Object.keys(s.models).length);
  if (plain) assert.equal(syncRegistrations(plan, { set: plain.id, colour: '' }, NAME).system, null);
});

test('the source registrations are never changed by the copy', () => {
  const before = JSON.stringify(plan);
  const sync = syncRegistrations(plan, { set: sets[0].id, colour: '' }, NAME);
  sync.presets.forEach((p) => p.labels?.push('x'));
  assert.equal(JSON.stringify(plan), before);
});

test('Chronicle\'s default, an unknown set or colour fall back, never to nothing', () => {
  const first = plan.setOf.get(plan.colorsets[0].name);
  assert.equal(syncRegistrations(plan, { set: '', colour: '' }, NAME).set, first);
  assert.equal(syncRegistrations(plan, { set: 'no-such-set', colour: '' }, NAME).set, first);
  const s = sets[0];
  const sync = syncRegistrations(plan, { set: s.id, colour: 'no-such-colour' }, NAME);
  const firstTheme = plan.colorsets.find((cs) => plan.setOf.get(cs.name) === s.id);
  assert.equal(sync.colorset.background, firstTheme.background);
  assert.equal(syncRegistrations({ colorsets: [], presets: [] }, { set: '', colour: '' }, NAME), null);
});

test('wiring: the GM reads the pick while connected, every client follows the world setting', () => {
  const gm = read('scripts/dice-look-sync.mjs');
  assert.match(gm, /'\/rolls\/settings'/);
  assert.match(gm, /activeGM\?\.isSelf/);
  assert.match(gm, /isRouteMissing\(err\)/);
  assert.match(read('scripts/dice-so-nice.mjs'), /scope: 'world'/);
  const mod = read('scripts/module.mjs');
  assert.match(mod, /registerDiceLookSetting\(\)/);
  assert.match(mod, /registerModule\(diceLookSync\)/);
  assert.equal(JSON.parse(read('lang/en.json')).CHRONICLE.Dice.SyncName, NAME);
});
