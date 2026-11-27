#!/usr/bin/env node
/**
 * scripts/_vendor-manifest.mjs is the module's record of what it vendored
 * from Chronicle; the version check compares it with Chronicle's own list.
 * It must describe the bytes actually in vendor/chronicle/, cover every
 * file there, and name the same files the freshness tests compare with
 * Chronicle, so a copy can't be added without a byte-for-byte check.
 * Needs no Chronicle checkout.
 *
 * Run: node --test tools/test-vendor-manifest.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
