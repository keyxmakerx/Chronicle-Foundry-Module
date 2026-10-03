#!/usr/bin/env node
/**
 * Pins the comparison behind tools/check-error-catalog.mjs (the CI check
 * that API-CONTRACT.md's error-code table matches Chronicle's
 * error-catalog.json), and that the real contract table and category set
 * still parse, so the live check can't pass by reading nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareCatalog,
  parseContractTable,
  parseModuleCategories,
} from './_error-catalog-check.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TABLE = [
  '| `error` code | `category` | Description | HTTP |',
  '|---|---|---|---|',
  '| `invalid_token` | `auth` | Token signature doesn\'t match | 403 |',
  '| `no_version_available` | `config` | Nothing pinned | 503 |',
  '',
  'Prose after the table.',
].join('\n');

const CATALOG = {
  schemaVersion: 1,
  categories: ['auth', 'config', 'internal'],
  codes: [
    { code: 'invalid_token', category: 'auth', httpStatus: 403 },
    { code: 'no_version_available', category: 'config', httpStatus: 503 },
    { code: '<dynamic>', category: 'internal', httpStatus: 500, wildcard: true },
  ],
};
const CATS = new Set(['auth', 'config', 'internal']);

const run = (over = {}) => compareCatalog({
  tableRows: parseContractTable(TABLE),
  catalog: CATALOG,
  moduleCategories: CATS,
  ...over,
});

test('matching table, catalog and categories report nothing', () => {
  assert.deepEqual(run(), []);
});

test('parser reads code, category and status, and stops at the table end', () => {
  assert.deepEqual(parseContractTable(TABLE), [
    { code: 'invalid_token', category: 'auth', httpStatus: 403 },
    { code: 'no_version_available', category: 'config', httpStatus: 503 },
  ]);
  assert.equal(parseContractTable('no table here'), null);
});

test('a code Chronicle added is reported missing', () => {
  const catalog = { ...CATALOG, codes: [...CATALOG.codes, { code: 'new_code', category: 'config', httpStatus: 503 }] };
  assert.match(run({ catalog }).join('\n'), /`new_code` is in error-catalog.json but missing/);
});

test('a code Chronicle removed is reported', () => {
  const catalog = { ...CATALOG, codes: CATALOG.codes.slice(1) };
  assert.match(run({ catalog }).join('\n'), /`invalid_token` is in the table but not/);
});

test('changed category or status is reported', () => {
  const catalog = { ...CATALOG, codes: [{ code: 'invalid_token', category: 'config', httpStatus: 401 }, CATALOG.codes[1]] };
  const out = run({ catalog }).join('\n');
  assert.match(out, /category `auth`, catalog says `config`/);
  assert.match(out, /HTTP 403, catalog says 401/);
});

test('wildcard entries are not expected in the table', () => {
  assert.ok(!run().some((p) => p.includes('<dynamic>')));
});

test('a new schema version is reported', () => {
  assert.match(run({ catalog: { ...CATALOG, schemaVersion: 2 } }).join('\n'), /schemaVersion is 2/);
});

test('category set drift either way is reported', () => {
  const out = run({ moduleCategories: new Set(['auth', 'config', 'legacy']) }).join('\n');
  assert.match(out, /`internal` is in error-catalog.json but not in update-info/);
  assert.match(out, /`legacy` is in update-info.mjs CHRONICLE_CATEGORIES but not/);
  assert.match(run({ moduleCategories: null }).join('\n'), /CHRONICLE_CATEGORIES set not found/);
});

test('the real API-CONTRACT.md table and update-info.mjs categories parse', async () => {
  const contract = await readFile(resolve(repoRoot, 'API-CONTRACT.md'), 'utf8');
  const rows = parseContractTable(contract);
  assert.ok(rows && rows.length >= 8, 'error-code table found with its rows');
  for (const r of rows) {
    assert.match(r.code, /^[a-z_]+$/);
    assert.ok(Number.isInteger(r.httpStatus), `${r.code} has a numeric HTTP status`);
  }
  const src = await readFile(resolve(repoRoot, 'scripts/update-info.mjs'), 'utf8');
  assert.deepEqual([...parseModuleCategories(src)].sort(), ['auth', 'config', 'internal', 'not_found', 'validation']);
});
