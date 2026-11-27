#!/usr/bin/env node
/**
 * scripts/_vendor-manifest.mjs is the module's record of what it vendored
 * from Chronicle; the version check compares it with Chronicle's own list.
 * It must describe the bytes actually in vendor/chronicle/, cover every
 * file there, and name the same files the freshness tests compare with
 * Chronicle, so a copy can't be added without a byte-for-byte check. With
 * CHRONICLE_DIR set, a source Chronicle moved or renamed fails those tests
 * rather than skipping them. Needs no Chronicle checkout.
 *
 * Run: node --test tools/test-vendor-manifest.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_MANIFEST } from '../scripts/_vendor-manifest.mjs';
import { SHOP_ROOM_FILES } from '../scripts/_shop-room-data.mjs';
import { SOURCES, digestOf, manifestSource } from './refresh-vendor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'chronicle');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('every digest is the sha256 of the vendored bytes', () => {
  for (const [file, { digest }] of Object.entries(VENDOR_MANIFEST)) {
    assert.match(digest, /^[0-9a-f]{12}$/, file);
    assert.equal(digest, digestOf(readFileSync(join(VENDOR, file))),
      `${file} changed without the manifest; run tools/refresh-vendor.mjs`);
  }
});

test('the manifest and vendor/chronicle/ list the same files', () => {
  assert.deepEqual(Object.keys(VENDOR_MANIFEST).sort(), readdirSync(VENDOR).sort());
});

test('the manifest is what the refresh tool writes', () => {
  const entries = SOURCES.map(([engine, source]) => {
    const file = source.split('/').pop();
    return { file, engine, source, digest: VENDOR_MANIFEST[file]?.digest };
  });
  assert.equal(read('scripts/_vendor-manifest.mjs'), manifestSource(entries));
});

// The freshness tests are read as text: importing one would run its tests.
// Each pairs a copy with the Chronicle path it is compared against.
function freshnessPairs() {
  const pairs = new Map();
  const cut = read('tools/test-cutscene-relay.mjs');
  assert.match(cut, /'static', 'js', 'cutscene_engine\.js'/);
  pairs.set('cutscene_engine.js', 'static/js/cutscene_engine.js');
  for (const f of SHOP_ROOM_FILES) pairs.set(f, `static/js/widgets/${f}`);
  const sky = read('tools/test-sky-clock.mjs').match(/const SKY_FILES = \[([^\]]*)\]/);
  assert.ok(sky, 'test-sky-clock.mjs keeps its SKY_FILES list');
  for (const [, f] of sky[1].matchAll(/'([\w.]+)'/g)) pairs.set(f, `static/js/widgets/${f}`);
  const craft = read('tools/test-craft-relay.mjs');
  const craftPairs = [...craft.matchAll(/\['([\w.]+\.(?:js|css))', '(js|css)'\]/g)];
  assert.ok(craftPairs.length, 'test-craft-relay.mjs keeps its file list');
  for (const [, f, from] of craftPairs) pairs.set(f, `internal/plugins/crafting/static/${from}/${f}`);
  return pairs;
}

test('the freshness tests compare exactly the manifest\'s files, from the same sources', () => {
  const pairs = freshnessPairs();
  assert.deepEqual([...pairs.keys()].sort(), Object.keys(VENDOR_MANIFEST).sort());
  for (const [file, source] of pairs) assert.equal(VENDOR_MANIFEST[file].source, source, file);
});

test('engines are the four the version check names', () => {
  const engines = new Set(Object.values(VENDOR_MANIFEST).map((e) => e.engine));
  assert.deepEqual([...engines].sort(), ['crafting', 'cutscenes', 'shop', 'sky']);
});

const FRESHNESS_TESTS = {
  cutscenes: 'tools/test-cutscene-relay.mjs',
  shop: 'tools/test-shop-room.mjs',
  sky: 'tools/test-sky-clock.mjs',
  crafting: 'tools/test-craft-relay.mjs',
};

// True when the Chronicle comparison itself was skipped. Node 20 also
// reports every test the name pattern filtered out as skipped, so the
// total skip count can't tell.
function comparisonSkipped(out) {
  return /^\s*ok \d+ - [^\n]*needs CHRONICLE_DIR[^\n]*# SKIP/m.test(out);
}

// Runs only the Chronicle comparison of one freshness test. The parent
// runner's context is dropped so the child reports on its own.
function runFreshness(file, chronicleDir) {
  const env = { ...process.env, CHRONICLE_DIR: chronicleDir };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=needs CHRONICLE_DIR', file], { cwd: ROOT, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('with CHRONICLE_DIR set, a source Chronicle moved fails its freshness test and names it', () => {
  const fake = mkdtempSync(join(tmpdir(), 'fake-chronicle-'));
  try {
    for (const [file, { source }] of Object.entries(VENDOR_MANIFEST)) {
      mkdirSync(join(fake, dirname(source)), { recursive: true });
      copyFileSync(join(VENDOR, file), join(fake, source));
    }
    for (const [engine, testFile] of Object.entries(FRESHNESS_TESTS)) {
      const all = runFreshness(testFile, fake);
      assert.equal(all.code, 0, `${testFile} passes against a Chronicle with every source:\n${all.out}`);
      assert.match(all.out, /# pass [1-9]/, `${testFile} ran its comparison`);
      const [, { source }] = Object.entries(VENDOR_MANIFEST).filter(([, e]) => e.engine === engine).at(-1);
      rmSync(join(fake, source));
      const moved = runFreshness(testFile, fake);
      assert.notEqual(moved.code, 0, `${testFile} fails when Chronicle has no ${source}`);
      assert.ok(moved.out.includes(source), `${testFile} names ${source}:\n${moved.out}`);
      assert.ok(!comparisonSkipped(moved.out), `${testFile} does not skip:\n${moved.out}`);
    }
    // A whole folder gone (Chronicle moved the widgets) used to skip.
    const empty = mkdtempSync(join(tmpdir(), 'empty-chronicle-'));
    try {
      for (const testFile of Object.values(FRESHNESS_TESTS)) {
        const gone = runFreshness(testFile, empty);
        assert.notEqual(gone.code, 0, `${testFile} fails against a Chronicle without the folder`);
        assert.match(gone.out, /Chronicle has no [\w/]+\.(?:js|css)/, `${testFile} names the missing path:\n${gone.out}`);
        assert.ok(!comparisonSkipped(gone.out), `${testFile} does not skip:\n${gone.out}`);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});
