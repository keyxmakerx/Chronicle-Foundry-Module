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
 * Run locally: `node tools/check-package-descriptor.mjs`
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${path}: invalid JSON (${err.message})`);
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

// --- Schema version ---
if (descriptor.schemaVersion !== 1) {
  fail(`chronicle-package.json: schemaVersion must be 1 (got ${JSON.stringify(descriptor.schemaVersion)})`);
}

// --- package.id matches module.json#/id ---
const descriptorId = descriptor?.package?.id;
const moduleId = moduleJson?.id;
if (!descriptorId) {
  fail('chronicle-package.json: package.id is required');
} else if (descriptorId !== moduleId) {
  fail(`chronicle-package.json: package.id (${JSON.stringify(descriptorId)}) does not match module.json#/id (${JSON.stringify(moduleId)})`);
}

// --- package.kind ---
if (descriptor?.package?.kind !== 'foundry-module') {
  fail(`chronicle-package.json: package.kind must be "foundry-module" (got ${JSON.stringify(descriptor?.package?.kind)})`);
}

// --- package.moduleJsonPath points at an actual file ---
const moduleJsonPathField = descriptor?.package?.moduleJsonPath;
if (!moduleJsonPathField) {
  fail('chronicle-package.json: package.moduleJsonPath is required');
} else {
  const resolved = resolve(repoRoot, moduleJsonPathField);
  try {
    await readFile(resolved, 'utf8');
  } catch {
    fail(`chronicle-package.json: package.moduleJsonPath (${moduleJsonPathField}) does not resolve to a readable file at ${resolved}`);
  }
}

// --- serving.rewriteFields ---
const rewriteFields = descriptor?.serving?.rewriteFields;
if (!Array.isArray(rewriteFields) || rewriteFields.length === 0) {
  fail('chronicle-package.json: serving.rewriteFields must be a non-empty array');
} else {
  for (const field of rewriteFields) {
    if (!(field in moduleJson)) {
      warn(`chronicle-package.json: serving.rewriteFields references "${field}" which is not present in module.json — Chronicle will create the field when serving, which may be intentional but is worth noting`);
    }
  }
}

// --- serving.manifestEndpoint + downloadEndpoint ---
function validateEndpoint(field, value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    fail(`chronicle-package.json: serving.${field} must be a path starting with "/" (got ${JSON.stringify(value)})`);
    return;
  }
  if (!value.includes('{campaign_id}')) {
    fail(`chronicle-package.json: serving.${field} must include the {campaign_id} placeholder`);
  }
  if (descriptor?.serving?.perCampaignSignedToken === true && !value.includes('{token}')) {
    fail(`chronicle-package.json: serving.${field} must include the {token} placeholder when perCampaignSignedToken is true`);
  }
}
validateEndpoint('manifestEndpoint', descriptor?.serving?.manifestEndpoint);
validateEndpoint('downloadEndpoint', descriptor?.serving?.downloadEndpoint);

// --- serving.perCampaignSignedToken ---
if (typeof descriptor?.serving?.perCampaignSignedToken !== 'boolean') {
  fail('chronicle-package.json: serving.perCampaignSignedToken must be boolean');
}

// --- serving.zipContentRoot ---
if (typeof descriptor?.serving?.zipContentRoot !== 'string') {
  fail('chronicle-package.json: serving.zipContentRoot must be a string (empty string means zip root)');
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
