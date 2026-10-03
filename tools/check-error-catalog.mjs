#!/usr/bin/env node
/**
 * CI check: API-CONTRACT.md's error-code table and update-info.mjs's
 * category set match Chronicle's published error-catalog.json. Exits
 * non-zero on any mismatch or when the catalog can't be read.
 *
 * Usage: node tools/check-error-catalog.mjs [path-or-url]
 * Defaults to the catalog on Chronicle's main branch. Pass a local path
 * (e.g. ../Chronicle/internal/plugins/foundry_vtt/error-catalog.json) to
 * check against a Chronicle checkout instead.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  compareCatalog,
  parseContractTable,
  parseModuleCategories,
} from './_error-catalog-check.mjs';

const CATALOG_URL =
  'https://raw.githubusercontent.com/keyxmakerx/Chronicle/main/internal/plugins/foundry_vtt/error-catalog.json';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

const source = process.argv[2] ?? CATALOG_URL;
let catalogText;
try {
  catalogText = /^https?:/.test(source)
    ? await fetchWithRetry(source)
    : await readFile(source, 'utf8');
} catch (err) {
  console.error(`Cannot read error catalog from ${source}: ${err.message}`);
  process.exit(1);
}

const catalog = JSON.parse(catalogText);
const contract = await readFile(resolve(repoRoot, 'API-CONTRACT.md'), 'utf8');
const updateInfo = await readFile(resolve(repoRoot, 'scripts/update-info.mjs'), 'utf8');

const problems = compareCatalog({
  tableRows: parseContractTable(contract),
  catalog,
  moduleCategories: parseModuleCategories(updateInfo),
});

if (problems.length) {
  console.error(`Error-code table is out of step with ${source}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Error-code table matches ${source}.`);
