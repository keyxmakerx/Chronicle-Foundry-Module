#!/usr/bin/env node
/**
 * Copies every vendored Chronicle file from a Chronicle checkout into
 * vendor/chronicle/ unchanged, then rewrites scripts/_vendor-manifest.mjs
 * with each copy's engine, source path and digest. The module never loads
 * code from the Chronicle server, so these copies are refreshed here, by
 * hand, and the freshness tests in CI say when one is due.
 *
 * Usage: CHRONICLE_DIR=../Chronicle node tools/refresh-vendor.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'chronicle');
const MANIFEST = join(ROOT, 'scripts', '_vendor-manifest.mjs');

const WIDGETS = 'static/js/widgets/';
const CRAFTING = 'internal/plugins/crafting/static/';

/** Every vendored file: its engine and its path in Chronicle. Adding a copy starts here. */
export const SOURCES = [
  ['cutscenes', 'static/js/cutscene_engine.js'],
  ['sky', `${WIDGETS}gl_shared.js`],
  ...['shop_room.js', 'shop_room_counter.js', 'shop_room_icons.js', 'shop_room_keeper.js',
    'shop_room_paper.js', 'shop_room_parts_places.js', 'shop_room_parts_strange.js',
    'shop_room_parts_trades.js'].map((f) => ['shop', WIDGETS + f]),
  ...['sky_2d.js', 'sky_events.js', 'sky_gl.js', 'sky_looks.js', 'sky_moon.js', 'sky_pane.js',
    'sky_shaders.js', 'sky_world.js'].map((f) => ['sky', WIDGETS + f]),
  ...['crafting_lib.js', 'crafting_tray.js', 'crafting_block.js'].map((f) => ['crafting', `${CRAFTING}js/${f}`]),
  ...['crafting.css', 'spoils.css'].map((f) => ['crafting', `${CRAFTING}css/${f}`]),
];

/** First 12 hex characters of the bytes' sha256; Chronicle reports the same. */
export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** The manifest module's source text, one line per copy. */
export function manifestSource(entries) {
  const lines = entries.map(({ file, engine, source, digest }) =>
    `  ${JSON.stringify(file)}: { engine: ${JSON.stringify(engine)}, source: ${JSON.stringify(source)}, digest: ${JSON.stringify(digest)} },`);
  return [
    '/**',
    ' * What is in vendor/chronicle/: each copy\'s engine, its path in Chronicle and',
    ' * the first 12 hex characters of its sha256. Written by',
    ' * tools/refresh-vendor.mjs, never by hand; tools/test-vendor-manifest.mjs',
    ' * checks it against the files.',
    ' */',
    'export const VENDOR_MANIFEST = Object.freeze({',
    ...lines,
    '});',
    '',
  ].join('\n');
}

function main() {
  const dir = process.env.CHRONICLE_DIR;
  if (!dir) {
    console.error('Set CHRONICLE_DIR to a Chronicle checkout.');
    process.exit(2);
  }
  const chronicle = resolve(dir);
  const missing = SOURCES.filter(([, src]) => !existsSync(join(chronicle, src)));
  if (missing.length) {
    console.error(`Not found in ${chronicle}:\n${missing.map(([, s]) => `  ${s}`).join('\n')}`);
    process.exit(1);
  }
  const entries = SOURCES.map(([engine, source]) => {
    const bytes = readFileSync(join(chronicle, source));
    const file = basename(source);
    const target = join(VENDOR, file);
    const changed = !existsSync(target) || !readFileSync(target).equals(bytes);
    if (changed) writeFileSync(target, bytes);
    console.log(`${changed ? 'updated  ' : 'unchanged'} ${file}`);
    return { file, engine, source, digest: digestOf(bytes) };
  });
  writeFileSync(MANIFEST, manifestSource(entries));
  const known = new Set(entries.map((e) => e.file));
  const extra = readdirSync(VENDOR).filter((f) => !known.has(f));
  if (extra.length) console.warn(`Not from Chronicle, left as is: ${extra.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
