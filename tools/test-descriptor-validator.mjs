#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-7 (descriptor schema runtime re-validation).
 *
 * Two-layer test:
 *
 *   1. Behavioral tests for `validateDescriptor` (the shared validator
 *      called from BOTH CI `tools/check-package-descriptor.mjs` AND
 *      runtime `scripts/module.mjs::_runtimeValidateDescriptor`).
 *
 *   2. Static-source integration: confirm both CI script + module.mjs
 *      import from the shared module, so a future refactor that
 *      forgets to update one path triggers a test failure.
 *
 * The shared validator + runtime hook are defense-in-depth per
 * FM-SECURITY-AUDIT §0.5 D2=(b).
 *
 * Run: `node --test tools/test-descriptor-validator.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { validateDescriptor } = await import('../scripts/_descriptor-validator.mjs');

// ---------------------------------------------------------------------
// Fixtures — minimal valid descriptor + module.json
// ---------------------------------------------------------------------

function validDescriptor() {
  return {
    schemaVersion: 1,
    package: {
      id: 'chronicle-sync',
      kind: 'foundry-module',
      moduleJsonPath: 'module.json',
    },
    serving: {
      rewriteFields: ['manifest', 'download'],
      manifestEndpoint: '/api/v1/campaigns/{campaign_id}/foundry-vtt/module.json?token={token}',
      downloadEndpoint: '/api/v1/campaigns/{campaign_id}/foundry-vtt/module.zip?token={token}',
      perCampaignSignedToken: true,
      zipContentRoot: '',
    },
  };
}

function validModuleJson() {
  return { id: 'chronicle-sync', manifest: 'https://example.com/m.json', download: 'https://example.com/m.zip' };
}

// ---------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------

test('validateDescriptor: valid descriptor + module.json → no errors', () => {
  const result = validateDescriptor(validDescriptor(), validModuleJson());
  assert.equal(result.errors.length, 0, `Expected no errors, got: ${JSON.stringify(result.errors)}`);
  assert.equal(result.warnings.length, 0);
});

test('validateDescriptor: real on-disk chronicle-package.json + module.json → no errors', () => {
  // Pin the actual deployed pair against the validator. If anyone edits either
  // file in a way that breaks the schema, this test catches it at PR time.
  const desc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'chronicle-package.json'), 'utf8'));
  const mod = JSON.parse(readFileSync(resolve(REPO_ROOT, 'module.json'), 'utf8'));
  const result = validateDescriptor(desc, mod);
  assert.equal(result.errors.length, 0, `Expected no errors on the real descriptor; got: ${JSON.stringify(result.errors)}`);
});

// ---------------------------------------------------------------------
// Error paths — descriptor presence
// ---------------------------------------------------------------------

test('validateDescriptor: null descriptor → error', () => {
  const result = validateDescriptor(null, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('missing or unparseable')), 'should flag null descriptor');
});

test('validateDescriptor: null module.json → error', () => {
  const result = validateDescriptor(validDescriptor(), null);
  assert.ok(result.errors.some(e => e.includes('module.json')), 'should flag null module.json');
});

// ---------------------------------------------------------------------
// Error paths — schemaVersion
// ---------------------------------------------------------------------

test('validateDescriptor: wrong schemaVersion → error', () => {
  const d = validDescriptor();
  d.schemaVersion = 2;
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('schemaVersion')), 'should flag wrong schemaVersion');
});

test('validateDescriptor: missing schemaVersion → error', () => {
  const d = validDescriptor();
  delete d.schemaVersion;
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('schemaVersion')), 'should flag missing schemaVersion');
});

// ---------------------------------------------------------------------
// Error paths — package.id cross-reference
// ---------------------------------------------------------------------

test('validateDescriptor: package.id mismatch with module.json#/id → error', () => {
  const d = validDescriptor();
  d.package.id = 'other-module';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('does not match module.json')), 'should flag id mismatch');
});

test('validateDescriptor: missing package.id → error', () => {
  const d = validDescriptor();
  delete d.package.id;
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('package.id is required')), 'should flag missing id');
});

// ---------------------------------------------------------------------
// Error paths — package.kind
// ---------------------------------------------------------------------

test('validateDescriptor: wrong package.kind → error', () => {
  const d = validDescriptor();
  d.package.kind = 'wrong-kind';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('package.kind')), 'should flag wrong kind');
});

// ---------------------------------------------------------------------
// Error paths — endpoints
// ---------------------------------------------------------------------

test('validateDescriptor: manifestEndpoint missing {campaign_id} → error', () => {
  const d = validDescriptor();
  d.serving.manifestEndpoint = '/api/v1/foundry-vtt/module.json?token={token}';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('{campaign_id}')), 'should flag missing {campaign_id}');
});

test('validateDescriptor: manifestEndpoint missing {token} when perCampaignSignedToken true → error', () => {
  const d = validDescriptor();
  d.serving.manifestEndpoint = '/api/v1/campaigns/{campaign_id}/foundry-vtt/module.json';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('{token}')), 'should flag missing {token}');
});

test('validateDescriptor: endpoint not starting with / → error', () => {
  const d = validDescriptor();
  d.serving.manifestEndpoint = 'api/v1/campaigns/{campaign_id}/foundry-vtt/module.json?token={token}';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('starting with')), 'should flag missing leading slash');
});

// ---------------------------------------------------------------------
// Warnings — rewriteFields cross-reference
// ---------------------------------------------------------------------

test('validateDescriptor: rewriteFields references field NOT in module.json → warning (not error)', () => {
  const d = validDescriptor();
  d.serving.rewriteFields = ['manifest', 'nonexistent-field'];
  const result = validateDescriptor(d, validModuleJson());
  assert.equal(result.errors.length, 0, 'should be warning not error');
  assert.ok(result.warnings.some(w => w.includes('nonexistent-field')), 'should warn about missing field');
});

test('validateDescriptor: empty rewriteFields → error', () => {
  const d = validDescriptor();
  d.serving.rewriteFields = [];
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('non-empty array')), 'should flag empty array');
});

// ---------------------------------------------------------------------
// Error paths — perCampaignSignedToken + zipContentRoot
// ---------------------------------------------------------------------

test('validateDescriptor: non-boolean perCampaignSignedToken → error', () => {
  const d = validDescriptor();
  d.serving.perCampaignSignedToken = 'yes';
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('perCampaignSignedToken')), 'should flag non-boolean');
});

test('validateDescriptor: non-string zipContentRoot → error', () => {
  const d = validDescriptor();
  d.serving.zipContentRoot = null;
  const result = validateDescriptor(d, validModuleJson());
  assert.ok(result.errors.some(e => e.includes('zipContentRoot')), 'should flag non-string');
});

// ---------------------------------------------------------------------
// Static-source integration checks
// ---------------------------------------------------------------------

test('tools/check-package-descriptor.mjs imports from the shared validator', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'tools/check-package-descriptor.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][.]\/scripts\/_descriptor-validator\.mjs['"]/.test(source),
    'CI script must import validateDescriptor from ../scripts/_descriptor-validator.mjs — otherwise CI + runtime would diverge',
  );
});

test('scripts/module.mjs imports the shared validator (runtime path)', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/module.mjs'), 'utf8');
  assert.ok(
    /_descriptor-validator\.mjs/.test(source),
    'module.mjs must reference _descriptor-validator.mjs to perform the runtime re-validation',
  );
});

test('scripts/module.mjs has the runtime descriptor-validation function', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/module.mjs'), 'utf8');
  assert.ok(
    /_runtimeValidateDescriptor/.test(source),
    'module.mjs must define _runtimeValidateDescriptor (the runtime entry point for descriptor re-validation)',
  );
});
