#!/usr/bin/env node
/**
 * Tests for `calendarStateFromError` (scripts/_calendar-probe-state.mjs) plus a
 * static pin for the 'auth' import-banner localization wiring.
 *
 * Background (AUDIT-2026-06-21 §2): a failed `GET /calendar` probe must map to
 * an actionable banner state — 404 → 'absent' (import a calendar), 401/403 →
 * 'auth' (fix the token), else 'unreachable'. The classifier keys on the HTTP
 * status (numeric `err.status`, or the api-client's "Chronicle API error
 * <status>:" prefix), NOT on a bare digit run, so a response body that merely
 * contains "404" can't misclassify the banner.
 *
 * Run: `node --test tools/test-sync-calendar-probe-state.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const { calendarStateFromError } = await import('../scripts/_calendar-probe-state.mjs');

// --- classification via the api-client "Chronicle API error <status>:" prefix ---

test('404 calendar_not_configured → absent', () => {
  const err = new Error('Chronicle API error 404: {"error":"calendar_not_configured","message":"No calendar is configured"}');
  assert.equal(calendarStateFromError(err), 'absent');
});

test('401 invalid_token → auth', () => {
  assert.equal(calendarStateFromError(new Error('Chronicle API error 401: {"error":"invalid_token"}')), 'auth');
});

test('403 → auth', () => {
  assert.equal(calendarStateFromError(new Error('Chronicle API error 403: {"error":"forbidden"}')), 'auth');
});

test('500 → unreachable', () => {
  assert.equal(calendarStateFromError(new Error('Chronicle API error 500: {"error":"internal"}')), 'unreachable');
});

test('network error (no status) → unreachable', () => {
  assert.equal(calendarStateFromError(new Error('Failed to fetch')), 'unreachable');
});

// --- numeric err.status takes precedence (e.g. a ConflictError-shaped error) ---

test('numeric err.status 404 → absent', () => {
  assert.equal(calendarStateFromError({ status: 404, message: 'x' }), 'absent');
});

test('numeric err.status 403 → auth', () => {
  assert.equal(calendarStateFromError({ status: 403, message: 'x' }), 'auth');
});

// --- false-positive guard (the hardening): a "404" in the body must NOT win ---

test('502 body containing "Room 404" → unreachable (status prefix wins, not body digits)', () => {
  const err = new Error('Chronicle API error 502: {"entity":"Room 404","note":"check the 401k page"}');
  assert.equal(calendarStateFromError(err), 'unreachable');
});

test('body-keyword fallback when no numeric status is present', () => {
  assert.equal(calendarStateFromError({ message: 'calendar_not_configured' }), 'absent');
  assert.equal(calendarStateFromError({ message: 'invalid_token' }), 'auth');
});

test('null / undefined → unreachable', () => {
  assert.equal(calendarStateFromError(null), 'unreachable');
  assert.equal(calendarStateFromError(undefined), 'unreachable');
});

// --- static wiring pin: 'auth' banner localization key + template references ---

test('lang/en.json defines CHRONICLE.SyncCalendar.Import.NotAuthorized', () => {
  const lang = JSON.parse(readFileSync(resolve(REPO_ROOT, 'lang/en.json'), 'utf8'));
  const v = lang?.CHRONICLE?.SyncCalendar?.Import?.NotAuthorized;
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0, 'NotAuthorized message must be non-empty');
});

test("sync-calendar.hbs renders the 'auth' banner branch in both banner copies", () => {
  const tpl = readFileSync(resolve(REPO_ROOT, 'templates/sync-calendar.hbs'), 'utf8');
  const branchCount = (tpl.match(/importBanner\.state "auth"/g) || []).length;
  assert.equal(branchCount, 2, "expected the 'auth' branch in both the degraded and inline banners");
  assert.ok(/CHRONICLE\.SyncCalendar\.Import\.NotAuthorized/.test(tpl), 'template must localize the NotAuthorized key');
});
