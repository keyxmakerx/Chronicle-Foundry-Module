#!/usr/bin/env node
/**
 * Regression pin: the dashboard's local-calendar-date read must use modern
 * Calendaria's `globalThis.CALENDARIA.api` (`getCurrentDateTime`), not ONLY the
 * legacy `game.Calendaria.getDate()`.
 *
 * Reading only the legacy global made `_getLocalCalendarDate` return null on
 * Calendaria 1.x, so the dashboard Calendar tab showed "Foundry: Unable to
 * read", the sync badge was permanently "Out of Sync", and the Push-date button
 * silently no-op'd (it returns early on a null local date). See
 * AUDIT-2026-06-21-foundry-errors.md §2.
 *
 * Static-source pin — mirrors the other sync-dashboard tests, which avoid
 * importing the heavy ApplicationV2 class.
 *
 * Run: node --test tools/test-dashboard-local-calendar-date.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../scripts/sync-dashboard.mjs'), 'utf8');

/** Slice out a method body by brace-matching from its definition. */
function methodBody(defAnchor) {
  const start = src.indexOf(defAnchor);
  assert.notEqual(start, -1, `method definition not found: ${defAnchor}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceStart, i + 1); }
  }
  throw new Error(`unbalanced braces for ${defAnchor}`);
}

const body = methodBody('_getLocalCalendarDate(calModule) {');

test('_getLocalCalendarDate reads the modern Calendaria API (CALENDARIA.api.getCurrentDateTime)', () => {
  assert.ok(body.includes('globalThis.CALENDARIA'),
    'must reference the modern globalThis.CALENDARIA.api surface');
  assert.ok(body.includes('getCurrentDateTime'),
    'must call getCurrentDateTime() — the method Calendaria 1.x exposes (per diagnostics)');
});

test('_getLocalCalendarDate still handles the Calendaria branch', () => {
  assert.ok(/calModule === 'Calendaria'/.test(body),
    'Calendaria branch must remain');
});

test('_getLocalCalendarDate does not depend SOLELY on the legacy game.Calendaria.getDate', () => {
  // game.Calendaria may remain as a fallback, but the modern path must exist so
  // a Calendaria 1.x install resolves a date (the prior bug was legacy-only).
  assert.ok(body.includes('globalThis.CALENDARIA'),
    'modern API path required; legacy game.Calendaria.getDate alone is the regressed shape');
});
