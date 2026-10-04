#!/usr/bin/env node
/**
 * Tests for `calendarStateFromError` (scripts/_calendar-probe-state.mjs).
 *
 * A failed `GET /calendar` probe must map to an actionable banner state: 503
 * → 'rebuilding', 404 → 'absent' (no calendar configured), 401/403 → 'auth' (fix
 * the token), else 'unreachable'. The classifier keys on the HTTP status
 * (numeric `err.status`, or the api-client's "Chronicle API error <status>:"
 * prefix), not on a bare digit run, so a response body that merely contains
 * "404" can't misclassify the banner.
 *
 * Run: `node --test tools/test-sync-calendar-probe-state.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
