#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-5 (closes P-7 from FM-SECURITY-AUDIT).
 *
 * `campaignId` is read from the Foundry world setting at every Chronicle
 * API call boundary and interpolated into the request URL:
 *
 *   `${baseUrl}/api/v1/campaigns/${campaignId}${path}`
 *
 * A misconfigured value (typo, empty, non-UUID, whitespace, `../`)
 * silently 404s or — worst case — escapes the campaign scope.
 *
 * The fix: `isValidCampaignId(id)` + `describeCampaignIdError(id)` in
 * `scripts/_settings-validation.mjs`. `api-client.mjs::fetch` and
 * `uploadMedia` validate at the call boundary; invalid → throw +
 * `ui.notifications.error` with an actionable message.
 *
 * This test covers:
 *   - the validator's behavioral pattern (accept/reject cases)
 *   - the error-message helper's coverage
 *   - the static-source integration: api-client.mjs calls the validator
 *     at fetch AND uploadMedia boundaries.
 *
 * Run: `node --test tools/test-campaign-id-validation.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { isValidCampaignId, describeCampaignIdError } = await import('../scripts/_settings-validation.mjs');

// ---------------------------------------------------------------------
// isValidCampaignId — accept cases
// ---------------------------------------------------------------------

test('isValidCampaignId accepts a valid UUID v4', () => {
  // Random UUID-v4 (8-4-4-4-12 hex, version digit 4).
  assert.equal(isValidCampaignId('abc12345-6789-4abc-def0-123456789abc'), true);
});

test('isValidCampaignId accepts uppercase hex UUIDs', () => {
  assert.equal(isValidCampaignId('ABCDEF12-3456-7890-ABCD-EF0123456789'), true);
});

test('isValidCampaignId accepts mixed-case hex UUIDs', () => {
  assert.equal(isValidCampaignId('AbCdEf12-3456-7890-aBcD-eF0123456789'), true);
});

test('isValidCampaignId accepts UUIDs with any version digit (v1-v5)', () => {
  // Format-only validation — we don't gate on the version digit because
  // future Chronicle versions may shift convention.
  for (let v = 1; v <= 5; v++) {
    assert.equal(isValidCampaignId(`12345678-1234-${v}234-1234-123456789abc`), true, `v${v} should accept`);
  }
});

// ---------------------------------------------------------------------
// isValidCampaignId — reject cases
// ---------------------------------------------------------------------

test('isValidCampaignId rejects empty string', () => {
  assert.equal(isValidCampaignId(''), false);
});

test('isValidCampaignId rejects whitespace-padded UUID', () => {
  assert.equal(isValidCampaignId(' abc12345-6789-4abc-def0-123456789abc '), false);
});

test('isValidCampaignId rejects non-UUID strings', () => {
  for (const bad of ['hello', 'not-a-uuid', '12345', 'abc', 'undefined']) {
    assert.equal(isValidCampaignId(bad), false, `should reject: ${bad}`);
  }
});

test('isValidCampaignId rejects UUID with wrong dash positions', () => {
  assert.equal(isValidCampaignId('abc1234-56789-4abc-def0-123456789abc'), false);
  assert.equal(isValidCampaignId('abc12345-67894abc-def0-123456789abc'), false);
});

test('isValidCampaignId rejects UUID with non-hex characters', () => {
  assert.equal(isValidCampaignId('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'), false);
  assert.equal(isValidCampaignId('abc1234x-6789-4abc-def0-123456789abc'), false);
});

test('isValidCampaignId rejects path-traversal attempts', () => {
  // Defensive against URL-escape attacks; these all fail the strict regex.
  assert.equal(isValidCampaignId('../admin'), false);
  assert.equal(isValidCampaignId('abc12345-6789-4abc-def0-123456789abc/../admin'), false);
});

test('isValidCampaignId rejects non-string types', () => {
  assert.equal(isValidCampaignId(null), false);
  assert.equal(isValidCampaignId(undefined), false);
  assert.equal(isValidCampaignId(12345), false);
  assert.equal(isValidCampaignId({}), false);
  assert.equal(isValidCampaignId([]), false);
});

// ---------------------------------------------------------------------
// describeCampaignIdError — error-message coverage
// ---------------------------------------------------------------------

test('describeCampaignIdError returns null for a valid UUID', () => {
  assert.equal(describeCampaignIdError('abc12345-6789-4abc-def0-123456789abc'), null);
});

test('describeCampaignIdError messages distinguish empty, whitespace, non-UUID, non-string', () => {
  const empty = describeCampaignIdError('');
  const whitespace = describeCampaignIdError(' abc12345-6789-4abc-def0-123456789abc ');
  const nonUuid = describeCampaignIdError('not-a-uuid');
  const nonString = describeCampaignIdError(null);

  // Each path returns a distinct operator-actionable message.
  assert.ok(empty && empty.includes('empty'), 'empty path mentions "empty"');
  assert.ok(whitespace && whitespace.includes('whitespace'), 'whitespace path mentions "whitespace"');
  assert.ok(nonUuid && nonUuid.includes('UUID'), 'non-UUID path mentions "UUID"');
  assert.ok(nonString && (nonString.includes('missing') || nonString.includes('not a string')), 'non-string path mentions missing/string');

  // All point to the same operator-resolution path.
  for (const m of [empty, whitespace, nonUuid, nonString]) {
    assert.ok(m.includes('Module Settings'), `error message must direct operator to Module Settings: ${m}`);
  }
});

// ---------------------------------------------------------------------
// Static-source integration check
// ---------------------------------------------------------------------

test('api-client.mjs imports the validator', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  assert.ok(
    /from\s+['"]\.\/_settings-validation\.mjs['"]/.test(source),
    'api-client.mjs must import from ./_settings-validation.mjs',
  );
});

test('api-client.mjs::fetch validates campaignId at the call boundary', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  // Find the fetch method body and verify it calls the validator on campaignId.
  const fetchMatch = source.match(/async\s+fetch\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  assert.ok(fetchMatch, 'fetch method body could not be located');
  assert.ok(
    /_validateCampaignIdOrThrow\s*\(\s*getSetting\(['"]campaignId['"]\)\s*\)/.test(fetchMatch[1]),
    'fetch must call _validateCampaignIdOrThrow(getSetting(\'campaignId\')) — otherwise P-7 regression',
  );
});

test('api-client.mjs::uploadMedia validates campaignId at the call boundary', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/api-client.mjs'), 'utf8');
  const uploadMatch = source.match(/async\s+uploadMedia\s*\([^)]*\)\s*\{([\s\S]*?)^\s{2}\}/m);
  assert.ok(uploadMatch, 'uploadMedia method body could not be located');
  assert.ok(
    /_validateCampaignIdOrThrow\s*\(\s*getSetting\(['"]campaignId['"]\)\s*\)/.test(uploadMatch[1]),
    'uploadMedia must call _validateCampaignIdOrThrow(getSetting(\'campaignId\')) — otherwise P-7 regression',
  );
});
