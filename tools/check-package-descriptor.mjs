#!/usr/bin/env node
/**
 * check-package-descriptor.mjs
 *
 * CI consistency check for the Chronicle package descriptor.
 *
 * Validates that `chronicle-package.json` is well-formed and that its
 * cross-references into `module.json` resolve correctly. Exits non-zero
 * on any failure so CI fails the PR.
 *
 * The descriptor is Chronicle's source-of-truth for HOW to serve this
 * module: where the manifest lives in the zip, what URL shape to emit,
 * whether per-campaign signing is required. Chronicle reads it via a
 * PostInstallHook (see Chronicle C-FMC-5b) with a fallback to hardcoded
 * defaults if the file is absent or malformed.
 *
 * Per FM-SEC-CHUNK-7 the validation rules live in
 * `scripts/_descriptor-validator.mjs` (shared with the runtime check in
 * `scripts/module.mjs::Hooks.once('ready')`). This script handles only
 * the CI-specific bits: file I/O + the `package.moduleJsonPath` exists-
 * on-disk check (which is meaningless at runtime).
 *
 * Run locally: `node tools/check-package-descriptor.mjs`
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { validateDescriptor } from '../scripts/_descriptor-validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const errors = [];
const warnings = [];

async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    errors.push(`${path}: cannot read (${err.message})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    errors.push(`${path}: invalid JSON (${err.message})`);
    return null;
  }
}

const descriptorPath = resolve(repoRoot, 'chronicle-package.json');
const moduleJsonPath = resolve(repoRoot, 'module.json');

const descriptor = await readJson(descriptorPath);
const moduleJson = await readJson(moduleJsonPath);

if (!descriptor || !moduleJson) {
  printResults();
  process.exit(1);
}

// Run the shared validation rules.
const result = validateDescriptor(descriptor, moduleJson);
errors.push(...result.errors);
warnings.push(...result.warnings);

// CI-only check: package.moduleJsonPath resolves to an actual file on disk.
// (Runtime can't easily check this without a fetch; CI verifies the zip
// would be self-consistent.)
const moduleJsonPathField = descriptor?.package?.moduleJsonPath;
if (moduleJsonPathField && typeof moduleJsonPathField === 'string') {
  const resolved = resolve(repoRoot, moduleJsonPathField);
  try {
    await readFile(resolved, 'utf8');
  } catch {
    errors.push(`chronicle-package.json: package.moduleJsonPath (${moduleJsonPathField}) does not resolve to a readable file at ${resolved}`);
  }
}

function printResults() {
  for (const w of warnings) console.warn(`WARN: ${w}`);
  for (const e of errors)   console.error(`FAIL: ${e}`);
  if (errors.length === 0) {
    console.log(`chronicle-package.json: OK (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
  } else {
    console.error(`\nchronicle-package.json: ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  }
}

printResults();
process.exit(errors.length === 0 ? 0 : 1);
