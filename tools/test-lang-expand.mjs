#!/usr/bin/env node
/**
 * CI guard for `lang/en.json` — simulates Foundry's `expandObject` and
 * fails loud on any structural collision that would cause Foundry to
 * reject the entire localization file.
 *
 * Bug context: 2026-05-19, FM-LANG-COLLISION-FIX. Operator's Foundry
 * console threw `TypeError: Cannot create property 'Visible' on string
 * 'Visibility'` because `lang/en.json` had both:
 *
 *   "Visibility": "Visibility",            // string at .Visibility
 *   "Visibility.Visible": "Visible..."     // expects .Visibility to be an object
 *
 * Foundry's `expandObject` (foundry.mjs:_expand) walks dotted keys as
 * nested paths, hits the string at `.Visibility`, and explodes. The
 * entire file was rejected — every `CHRONICLE.*` key on the Sync
 * dashboard rendered raw for an entire release cycle.
 *
 * This guard checks two failure modes:
 *
 *   (A) STRING-VS-OBJECT collision: a sibling key `X` is a string while
 *       `X.Y` exists as a dotted-flat key. Foundry's expansion throws.
 *
 *   (B) DUPLICATE-AFTER-EXPANSION: the same fully-qualified path is
 *       reachable via two routes, e.g. `"Foo.Bar": "x"` alongside
 *       `"Foo": { "Bar": "y" }`. JSON parses; one silently overrides
 *       the other; the lossy one is invisible until the operator
 *       wonders why a string changed.
 *
 * Run: `node --test tools/test-lang-expand.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LANG_PATH = resolve(__dirname, '..', 'lang', 'en.json');

/**
 * Walk the parsed JSON tree the same way Foundry's `expandObject` would,
 * collecting any key conflict that would crash `_expand`. Returns an
 * array of `{path, kind, detail}` records — empty array means clean.
 */
function findExpandCollisions(root) {
  const collisions = [];
  const walk = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj);
    // Failure mode A: sibling string head vs. dotted-flat key.
    for (const k of keys) {
      if (!k.includes('.')) continue;
      const [head] = k.split('.');
      if (head in obj && typeof obj[head] !== 'object') {
        collisions.push({
          kind: 'string-vs-object',
          path: `${path}.${k}`,
          collidesWith: `${path}.${head}`,
          detail: JSON.stringify(obj[head]).slice(0, 80),
        });
      }
    }
    for (const k of keys) walk(obj[k], `${path}.${k}`);
  };
  walk(root, '');
  return collisions;
}

/**
 * Detect failure mode B: the same final path is reachable two ways.
 * Walks both nested-object paths and dotted-flat-key paths, building a
 * flat path set; any duplicate-after-expansion is a silent override.
 */
function findDuplicateExpansions(root) {
  const seen = new Map(); // path → value
  const dupes = [];
  const visit = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      // A dotted key like "X.Y" expands into the path prefix.X.Y.
      const segments = k.split('.');
      const fullPath = [prefix, ...segments].filter(Boolean).join('.');
      if (typeof v === 'object' && v !== null) {
        visit(v, fullPath);
      } else {
        if (seen.has(fullPath)) {
          dupes.push({
            path: fullPath,
            first: seen.get(fullPath),
            second: v,
          });
        } else {
          seen.set(fullPath, v);
        }
      }
    }
  };
  visit(root, '');
  return dupes;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test('lang/en.json parses as valid JSON', () => {
  const raw = readFileSync(LANG_PATH, 'utf8');
  // Throws on parse error — assertion is implicit.
  const obj = JSON.parse(raw);
  assert.equal(typeof obj, 'object');
  assert.ok(obj && obj.CHRONICLE, 'top-level CHRONICLE namespace missing');
});

test('lang/en.json has no string-vs-object expandObject collisions', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const collisions = findExpandCollisions(obj);
  if (collisions.length > 0) {
    const lines = collisions.map((c) =>
      `  - ${c.path}\n      collides with sibling string ${c.collidesWith} = ${c.detail}`,
    );
    assert.fail(
      `Found ${collisions.length} expandObject collision(s) — Foundry will reject the entire lang file:\n${lines.join('\n')}\n\n` +
      `Fix: nest the dotted-key options inside a sibling object (e.g. rename "Foo.Bar" entries under a "FooOption" object).`,
    );
  }
});

test('lang/en.json has no duplicate-after-expansion paths', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const dupes = findDuplicateExpansions(obj);
  if (dupes.length > 0) {
    const lines = dupes.map((d) =>
      `  - ${d.path}\n      first: ${JSON.stringify(d.first).slice(0, 60)}\n      second: ${JSON.stringify(d.second).slice(0, 60)}`,
    );
    assert.fail(
      `Found ${dupes.length} path(s) reachable two ways (one silently overrides the other):\n${lines.join('\n')}`,
    );
  }
});

// ---------------------------------------------------------------------
// Regression pins for the specific keys that broke FM-LANG-COLLISION-FIX.
// If these tests start failing, somebody re-introduced the dotted-vs-
// string pattern. Run the sweep above to find all instances.
// ---------------------------------------------------------------------

test('regression: Visibility field label remains a flat string', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const v = obj?.CHRONICLE?.SyncCalendar?.NoteForm?.Visibility;
  assert.equal(typeof v, 'string', 'NoteForm.Visibility must stay a string label, not an object');
});

test('regression: VisibilityOption sub-object carries the three option labels', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const o = obj?.CHRONICLE?.SyncCalendar?.NoteForm?.VisibilityOption;
  assert.equal(typeof o, 'object', 'NoteForm.VisibilityOption must be an object');
  assert.ok(o.Visible, 'VisibilityOption.Visible label missing');
  assert.ok(o.Hidden,  'VisibilityOption.Hidden label missing');
  assert.ok(o.Secret,  'VisibilityOption.Secret label missing');
});

test('regression: DisplayStyle field label remains a flat string', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const v = obj?.CHRONICLE?.SyncCalendar?.NoteForm?.DisplayStyle;
  assert.equal(typeof v, 'string', 'NoteForm.DisplayStyle must stay a string label, not an object');
});

test('regression: DisplayStyleOption sub-object carries the three option labels', () => {
  const obj = JSON.parse(readFileSync(LANG_PATH, 'utf8'));
  const o = obj?.CHRONICLE?.SyncCalendar?.NoteForm?.DisplayStyleOption;
  assert.equal(typeof o, 'object', 'NoteForm.DisplayStyleOption must be an object');
  assert.ok(o.Icon,   'DisplayStyleOption.Icon label missing');
  assert.ok(o.Pip,    'DisplayStyleOption.Pip label missing');
  assert.ok(o.Banner, 'DisplayStyleOption.Banner label missing');
});
