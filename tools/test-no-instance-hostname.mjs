#!/usr/bin/env node
/**
 * CI guard: forbid operator's production hostname in tracked source.
 *
 * Context: 2026-05-20, FM-SCRUB-SCHEMA-URL. Operator asked we not
 * reference their production hostname anywhere in this repo's tracked
 * artifacts. `chronicle-package.json` ships with every module install;
 * every consumer would see the URL. The scrub PR drops the offending
 * `$schema` field and this test prevents the pattern from coming back.
 *
 * Sibling Chronicle-side dispatch C-SCRUB-INSTANCE-URLS does the same
 * thing on the server source.
 *
 * Approach: deny-list a small set of operator-specific token fragments
 * and walk every tracked source file. Anything containing one of the
 * fragments — except this test file itself, which references them as
 * literals — fails CI with a pointer to the offending line.
 *
 * Run: `node --test tools/test-no-instance-hostname.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Token fragments that must not appear anywhere in tracked source. Kept
 * narrow (single-token substring) so we don't accidentally false-positive
 * on words that happen to contain a substring. Operator may extend if
 * future production hostnames need scrubbing.
 */
const FORBIDDEN_FRAGMENTS = ['bnuuy'];

/**
 * Directories never walked. `.git` and `node_modules` are obvious; we
 * also skip Foundry's bundled `assets/` if it ever lands here (binary
 * content). Add more as needed.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * File extensions we walk. Anything else (binary, lockfiles, etc.) is
 * skipped — the operator's hostname appearing in a PNG would be a much
 * weirder bug than this guard is built to catch.
 */
const WALK_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts',
  '.json', '.jsonc',
  '.md', '.mdx',
  '.hbs', '.html', '.css',
  '.yml', '.yaml',
  '.sh',
]);

/**
 * Files allowed to mention the forbidden fragments because their job is
 * to detect them. Relative-to-repo-root paths.
 */
const SELF_REFERENCES = new Set([
  'tools/test-no-instance-hostname.mjs',
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

function scanFile(absPath) {
  const rel = relative(REPO_ROOT, absPath);
  if (SELF_REFERENCES.has(rel)) return [];
  let text;
  try { text = readFileSync(absPath, 'utf8'); }
  catch { return []; }
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const frag of FORBIDDEN_FRAGMENTS) {
      if (line.includes(frag)) {
        hits.push({ file: rel, line: idx + 1, fragment: frag, content: line.trim().slice(0, 200) });
      }
    }
  });
  return hits;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test('FORBIDDEN_FRAGMENTS is non-empty and tightly scoped', () => {
  assert.ok(FORBIDDEN_FRAGMENTS.length >= 1);
  for (const f of FORBIDDEN_FRAGMENTS) {
    assert.ok(typeof f === 'string' && f.length >= 4,
      'fragment must be at least 4 chars to avoid false positives');
  }
});

test('no tracked source references the operator\'s production hostname', () => {
  const files = [];
  walk(REPO_ROOT, files);
  const hits = files.flatMap(scanFile);
  if (hits.length > 0) {
    const lines = hits.map((h) =>
      `  - ${h.file}:${h.line}  (fragment "${h.fragment}")\n      ${h.content}`,
    );
    assert.fail(
      `Found ${hits.length} reference(s) to operator's production hostname in tracked source.\n` +
      `Operator's security policy: no instance-specific hostnames in shipped artifacts.\n\n` +
      `Hits:\n${lines.join('\n')}\n\n` +
      `Fix: replace with a non-leaky placeholder or drop the field entirely. ` +
      `See FM-SCRUB-SCHEMA-URL for the precedent.`,
    );
  }
});

test('regression: chronicle-package.json no longer carries $schema with the operator hostname', () => {
  const path = resolve(REPO_ROOT, 'chronicle-package.json');
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text);
  // The fix is Option A from the dispatch: drop the field entirely.
  assert.equal(parsed.$schema, undefined,
    'chronicle-package.json must not carry a $schema field that leaks the operator hostname. ' +
    'Option A (drop the field) was chosen in FM-SCRUB-SCHEMA-URL because the schema is server-enforced.');
});

test('self-reference allowance is intact — this test file is permitted to mention the fragments', () => {
  // This test exists to make the SELF_REFERENCES allowance explicit.
  // If somebody removes the allowance, this file's grep would fail
  // the main test and crash the suite circularly.
  assert.ok(SELF_REFERENCES.has('tools/test-no-instance-hostname.mjs'));
});
