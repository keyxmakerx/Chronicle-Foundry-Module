#!/usr/bin/env node
/**
 * CI guard: forbid the operator's production hostname in tracked source.
 * `chronicle-package.json` ships with every module install, so any tracked
 * file naming it would hand it to every consumer.
 *
 * The guard holds only a SHA-256 fingerprint of the hostname's distinctive
 * label, never the label itself: a guard that spells out what it guards
 * publishes it. Every word of every walked file is hashed and compared, and
 * a hit is reported as file:line only, so the CI log doesn't repeat it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/** SHA-256 of each forbidden word, lowercased. */
const FORBIDDEN_SHA256 = new Set([
  'ac1714a0d116e09a0a7a89b76e7c51e8d88ce8fa7678d63ec3c5dec301f32868',
]);

/** Directories never walked. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** File extensions walked: text the module ships or documents itself with. */
const WALK_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts',
  '.json', '.jsonc',
  '.md', '.mdx',
  '.hbs', '.html', '.css',
  '.yml', '.yaml',
  '.sh',
]);

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
    if (!WALK_EXTENSIONS.has(ext)) continue;
    acc.push(full);
  }
}

const sha256 = (word) => createHash('sha256').update(word).digest('hex');

/** Lines of text holding a word whose fingerprint is in `forbidden`. */
function scanText(text, forbidden) {
  const seen = new Map();
  const hits = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const word of line.toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (!seen.has(word)) seen.set(word, forbidden.has(sha256(word)));
      if (seen.get(word)) { hits.push(idx + 1); break; }
    }
  });
  return hits;
}

function scanFile(absPath) {
  let text;
  try { text = readFileSync(absPath, 'utf8'); }
  catch { return []; }
  const rel = relative(REPO_ROOT, absPath);
  return scanText(text, FORBIDDEN_SHA256).map((line) => `${rel}:${line}`);
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test('every fingerprint is a SHA-256 hex digest', () => {
  assert.ok(FORBIDDEN_SHA256.size >= 1);
  for (const h of FORBIDDEN_SHA256) assert.match(h, /^[0-9a-f]{64}$/);
});

test('the scanner finds a fingerprinted word in any case, as a whole word', () => {
  const forbidden = new Set([sha256('example')]);
  assert.deepEqual(scanText('a\nhttps://chronicle.EXAMPLE.org/x\n', forbidden), [2]);
  assert.deepEqual(scanText('counterexamples only', forbidden), []);
});

test('no tracked source references the operator\'s production hostname', () => {
  const files = [];
  walk(REPO_ROOT, files);
  const hits = files.flatMap(scanFile);
  assert.equal(hits.length, 0,
    `The operator's production hostname appears in tracked source:\n  ${hits.join('\n  ')}\n` +
    'Replace it with a non-leaky placeholder or drop the field.');
});

test('chronicle-package.json carries no $schema URL', () => {
  // The schema is enforced by the server, so the descriptor needs no URL
  // pointing at any instance.
  const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, 'chronicle-package.json'), 'utf8'));
  assert.equal(parsed.$schema, undefined);
});
