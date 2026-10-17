#!/usr/bin/env node
/**
 * The Dice So Nice check (scripts/_dice-so-nice-check.mjs) and the bridge's
 * wiring (scripts/dice-so-nice.mjs). Dice So Nice is another author's module,
 * so these pin that each way it can change or be missing reads as a plain row
 * with a fix, that a world without it is "not in use" rather than an error,
 * and that the bridge never reaches into Dice So Nice's own folder.
 *
 * Run: node --test tools/test-dice-so-nice-check.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { REQUIRED_API, TESTED_VERSION, compareVersions, judgeDiceSoNice } from '../scripts/_dice-so-nice-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Dice.Check;

const running = {
  installed: true, active: true, version: TESTED_VERSION, hasApi: true, ready: true,
  methods: [...REQUIRED_API, 'preloadPresets', 'isEnabled'], enabled: true,
  manifest: { ok: true, problems: [], setCount: 12 },
  registration: { colorsets: 12, systems: 12, presets: 84, errors: [] },
};
const codes = (r) => r.rows.map((x) => x.code);

test('versions compare by number', () => {
  assert.ok(compareVersions('6.10', '6.9') > 0);
  assert.equal(compareVersions('6.4.4', '6.4.4'), 0);
  assert.ok(compareVersions('5', '6.0.1') < 0);
  assert.equal(compareVersions(undefined, ''), 0);
});

test('no Dice So Nice is "not in use", never an error', () => {
  assert.deepEqual(judgeDiceSoNice({ installed: false }), { state: 'off', rows: [{ level: 'info', code: 'NotInstalled', data: {} }] });
  assert.equal(judgeDiceSoNice({ installed: true, active: false }).rows[0].code, 'NotActive');
  assert.equal(judgeDiceSoNice().state, 'off');
});

test('everything working is ok', () => {
  const r = judgeDiceSoNice(running);
  assert.equal(r.state, 'ok');
  assert.deepEqual(codes(r), ['VersionTested', 'ApiOk', 'SetsListed', 'Registered']);
});

test('a new major version warns; a renamed call is an error', () => {
  assert.equal(judgeDiceSoNice({ ...running, version: '7.0.0' }).state, 'warn');
  assert.equal(judgeDiceSoNice({ ...running, version: '6.5.0' }).state, 'ok');
  const gone = judgeDiceSoNice({ ...running, methods: ['addSystem'] });
  assert.equal(gone.state, 'error');
  assert.deepEqual(gone.rows.find((x) => x.code === 'ApiMissing').data, { methods: 'addDicePreset, addColorset' });
});

test('stuck start-up waits its grace period before it is an error', () => {
  assert.equal(judgeDiceSoNice({ ...running, hasApi: false, ready: false }).rows[1].code, 'Starting');
  assert.equal(judgeDiceSoNice({ ...running, hasApi: false, ready: false, waitedLong: true }).state, 'error');
  assert.ok(codes(judgeDiceSoNice({ ...running, ready: false, waitedLong: true })).includes('NoReadyHook'));
  assert.deepEqual(codes(judgeDiceSoNice({ ...running, hasApi: false, streamView: true })).slice(0, 2), ['VersionTested', 'StreamView']);
  assert.equal(judgeDiceSoNice({ ...running, hasApi: false, noCanvas: true, waitedLong: true }).state, 'ok');
});

test('list, registration and file problems each name what broke', () => {
  assert.equal(judgeDiceSoNice({ ...running, manifest: { ok: false, error: 'HTTP 404' } }).state, 'error');
  const skipped = judgeDiceSoNice({ ...running, manifest: { ok: true, problems: [{ code: 'SetDuplicate', set: 'ember' }], setCount: 11 } });
  assert.equal(skipped.state, 'warn');
  assert.deepEqual(skipped.rows.find((x) => x.code === 'ManifestProblem').data, { problem: 'SetDuplicate', set: 'ember', detail: '' });
  const refused = judgeDiceSoNice({ ...running, registration: { ...running.registration, errors: [{ step: 'preset', id: 'x/d20', message: 'bad' }] } });
  assert.equal(refused.state, 'error');
  const files = judgeDiceSoNice({ ...running, files: [{ path: 'a.webp', ok: true }, { path: 'b.webp', ok: false, status: 404 }] });
  assert.deepEqual(files.rows.at(-1), { level: 'error', code: 'FileMissing', data: { path: 'b.webp', status: 404 } });
  assert.equal(judgeDiceSoNice({ ...running, files: [{ path: 'a.webp', ok: true }] }).rows.at(-1).code, 'FilesOk');
  assert.equal(judgeDiceSoNice({ ...running, manifest: { ok: true, problems: [], setCount: 0 }, registration: null }).rows.at(-1).code, 'NoSets');
});

test('every row has words, every error and warning says what to do', () => {
  const all = [
    judgeDiceSoNice({ installed: false }), judgeDiceSoNice({ installed: true }),
    judgeDiceSoNice({ ...running, version: '' }), judgeDiceSoNice({ ...running, version: '7.0' }),
    judgeDiceSoNice({ ...running, version: '6.1', methods: [], enabled: false, ready: false, waitedLong: true }),
    judgeDiceSoNice({ ...running, hasApi: false, waitedLong: true }),
    judgeDiceSoNice({ ...running, manifest: { ok: false } }),
    judgeDiceSoNice({ ...running, manifest: { ok: true, problems: [{ code: 'SetId' }] }, registration: { errors: [{}] }, files: [{ ok: false }] }),
  ].flatMap((r) => r.rows);
  for (const r of all) {
    assert.equal(typeof lang[r.code], 'string', r.code);
    if (r.level === 'error' || r.level === 'warn') assert.equal(typeof lang[`${r.code}Fix`], 'string', `${r.code}Fix`);
  }
  for (const code of ['ManifestShape', 'ManifestVersion', 'SetId', 'SetDuplicate', 'SetColour', 'SetMaterial', 'FaceType', 'FaceList', 'ModelPath']) {
    assert.equal(typeof lang.Problem[code], 'string', code);
  }
});

test('the bridge runs on every client and never imports from Dice So Nice', () => {
  const glue = read('scripts/dice-so-nice.mjs');
  assert.doesNotMatch(glue, /from ['"][^'"]*dice-so-nice\//);
  assert.doesNotMatch(glue, /import\(/);
  assert.doesNotMatch(glue, /isGM/);
  assert.match(glue, /Hooks\.once\('diceSoNiceReady'/);
  const mod = read('scripts/module.mjs');
  const init = mod.slice(mod.indexOf("Hooks.once('init'"), mod.indexOf("Hooks.once('ready'"));
  assert.match(init, /registerDiceSoNice\(\)/);
  const manifest = JSON.parse(read('module.json'));
  assert.ok(manifest.relationships.recommends.some((r) => r.id === 'dice-so-nice'));
  assert.ok(!(manifest.relationships.requires ?? []).some((r) => r.id === 'dice-so-nice'));
});
