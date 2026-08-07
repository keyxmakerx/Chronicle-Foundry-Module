#!/usr/bin/env node
/**
 * Source-level pins for the module's half of Chronicle's partial-update
 * contract (Chronicle sweep R4, 2026-08-07).
 *
 * The contract, documented in API-CONTRACT.md → "The partial-update
 * contract": an ABSENT key preserves the stored value, an EXPLICIT null
 * clears it, a present value replaces it. Chronicle's request structs bind
 * `patch.Field[T]`, which records presence during JSON decoding, so absent
 * and null are genuinely different.
 *
 * That contract is what makes this module's narrow bodies SAFE. Before it,
 * they were data loss:
 *
 *   - `actor-sync.mjs` pushes `{name}` alone on a rename. Chronicle's
 *     `apiUpdateEntityRequest.IsPrivate` was a value-typed `bool`, so the
 *     absent key bound `false` and PUBLISHED a hidden character entity to
 *     every player in the campaign. The struct had no `parent_id` member at
 *     all, so the same push also detached the entity from the hierarchy.
 *   - `calendar-sync.mjs` pushes five-key bodies from three paths. Each also
 *     wrote `is_recurring=false`, `all_day=false` and a cleared `entity_id`.
 *
 * Both were fixed on the server. What this file defends is the OTHER
 * direction: that nobody "repairs" these clients by echoing the untouched
 * fields back. An echo re-arms the endpoint for the next writer, and it goes
 * stale — which is exactly how the marker dialog lost the pairing key.
 *
 * These are source-level assertions, not runtime ones, because the thing
 * being pinned is the SHAPE of a request body that a hook builds — the same
 * reason Chronicle pins its own templ clients by reading their source.
 *
 * Run: `node --test tools/test-partial-put-contract.mjs`
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

test('calendar-sync: the Calendaria note payload stays six keys', () => {
  const src = read('scripts/calendar-sync.mjs');
  const idx = src.indexOf("name: name || 'Untitled Note',");
  assert.notEqual(idx, -1, 'the Calendaria note payload moved');
  const open = src.lastIndexOf('return {', idx);
  assert.deepEqual(
    topLevelKeys(src, open),
    ['day', 'description', 'month', 'name', 'visibility', 'year'].sort(),
    'the Calendaria note payload grew or shrank. A Foundry note edit means the name, the date, ' +
      'the body and the visibility — the server preserves everything absent, so echoing more is ' +
      'stale data waiting to be written.'
  );
});

test('calendar-sync: every inline PUT body to /calendar/events stays five keys', () => {
  const src = read('scripts/calendar-sync.mjs');
  // Find the PUT call sites by their URL, not by a field name — the create
  // path uses the same field expressions and would otherwise be matched.
  const marker = 'this._api.put(`/calendar/events/';
  const bodies = [];
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) {
    const comma = src.indexOf(', ', src.indexOf('`,', i));
    const after = src.slice(comma + 2, comma + 3);
    if (after !== '{') continue; // e.g. the Calendaria path, which passes a variable
    bodies.push(topLevelKeys(src, comma + 2));
  }
  assert.equal(bodies.length, 2, 'expected exactly two inline PUT bodies (legacy Calendaria + SimpleCalendar)');
  for (const keys of bodies) {
    assert.deepEqual(
      keys,
      ['day', 'description', 'month', 'name', 'year'],
      'an update push changed shape; keep it to what a Foundry note edit means. The server ' +
        'preserves every absent key now, so echoing more is stale data waiting to be written.'
    );
  }
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
