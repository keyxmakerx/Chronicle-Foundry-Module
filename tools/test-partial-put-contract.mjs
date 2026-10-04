#!/usr/bin/env node
/**
 * Source-level pins for the module's half of Chronicle's partial-update
 * contract (API-CONTRACT.md → "The partial-update contract"): an ABSENT key
 * preserves the stored value, an EXPLICIT null clears it, a present value
 * replaces it. Chronicle's request structs bind `patch.Field[T]`, which
 * records presence during JSON decoding, so absent and null are genuinely
 * different.
 *
 * Callers must send only the fields they mean to change and must NOT
 * "harden" a narrow body by echoing untouched fields back — an echo re-arms
 * the endpoint for the next writer and goes stale. A rename push that widens
 * beyond `{name}` on the entity endpoint risks flipping visibility or
 * detaching hierarchy on absent keys; these are source-level assertions on
 * the request body shape a hook builds, not runtime ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * Returns the top-level keys of the first object literal that starts at
 * `startIndex`, by walking braces so nested objects do not leak keys.
 */
function topLevelKeys(src, startIndex) {
  const open = src.indexOf('{', startIndex);
  assert.notEqual(open, -1, 'no object literal found');
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, 'unterminated object literal');
  const body = src.slice(open + 1, end);

  // Strip nested literals and comments so only top-level keys remain.
  const stripped = body
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const keys = [];
  let d = 0;
  let line = '';
  for (const ch of stripped) {
    if (ch === '{' || ch === '[' || ch === '(') d++;
    if (ch === '}' || ch === ']' || ch === ')') d--;
    if (ch === ',' && d === 0) { line = ''; continue; }
    if (d === 0) {
      line += ch;
      if (ch === ':') {
        const m = line.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:$/);
        if (m) keys.push(m[1]);
        line = '';
      }
    }
  }
  return keys.sort();
}

test('actor-sync: a rename pushes only {name}', () => {
  const src = read('scripts/actor-sync.mjs');
  const idx = src.indexOf('const nameBody =');
  assert.notEqual(idx, -1, 'nameBody literal not found — did the rename push move?');
  assert.deepEqual(
    topLevelKeys(src, idx),
    ['name'],
    'the rename push must carry ONLY name. Echoing is_private / type_label / parent_id back ' +
      're-arms the endpoint for the next writer and goes stale; visibility has its own route ' +
      '(POST /entities/:id/reveal).'
  );
});

test('actor-sync: the only other key on the rename push is the concurrency token', () => {
  const src = read('scripts/actor-sync.mjs');
  // expected_updated_at is optimistic concurrency, not a data field — it is
  // added conditionally after construction, so it never appears in the
  // literal above. Anything ELSE assigned onto nameBody would be a data write.
  const assignments = [...src.matchAll(/nameBody\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(assignments)].sort(),
    ['expected_updated_at'],
    'something other than the concurrency token is being assigned onto the rename body'
  );
});

test('calendar-sync: sends no PUT to /calendar/events; the date PUT stays five keys', () => {
  const src = read('scripts/calendar-sync.mjs');
  // The module edits no event. A future event push must stay partial: only
  // the fields a Foundry edit means, never an echo of the stored event.
  assert.ok(!src.includes('this._api.put(`/calendar/events/'), 'an event update push appeared; pin its body here');
  const marker = "this._api.put('/calendar/date', ";
  const idx = src.indexOf(marker);
  assert.notEqual(idx, -1, 'the date push moved');
  assert.deepEqual(
    topLevelKeys(src, idx + marker.length),
    ['day', 'hour', 'minute', 'month', 'year'],
    'the date push changed shape; it carries the date and nothing else.'
  );
});

test('the contract is documented where the endpoints are described', () => {
  // Whitespace-normalised: the doc is hard-wrapped, so a phrase may straddle
  // a line break without having changed.
  const doc = read('API-CONTRACT.md').replace(/\s+/g, ' ');
  for (const phrase of [
    'The partial-update contract',
    'an explicit `null`',
    'published a hidden character entity to every player',
    '`parent_id` was not on the request struct at all',
  ]) {
    assert.ok(
      doc.includes(phrase),
      `API-CONTRACT.md no longer states ${JSON.stringify(phrase)}. The wire semantics of an ` +
        'absent key are the whole contract; a module author who cannot read them here will guess.'
    );
  }
});
