#!/usr/bin/env node
/**
 * Pins the sidebar status dot's words (scripts/_status-dot.mjs): every
 * label and tooltip comes from lang/en.json, and the connected tooltip says
 * when Chronicle last sent a change.
 *
 * Run: `node --test tools/test-status-dot.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stateKey, statusLabel, statusTooltip, sinceText, isChronicleChange } from '../scripts/_status-dot.mjs';

const lang = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, k) => o?.[k], lang);
const localize = (key) => {
  const v = lookup(key);
  assert.equal(typeof v, 'string', `${key} is missing from lang/en.json`);
  return v;
};
const format = (key, data) => localize(key).replace(/\{(\w+)\}/g, (_, k) => data[k]);

test('every state has a label and a tooltip in lang/en.json', () => {
  for (const state of ['connected', 'connecting', 'reconnecting', 'disconnected']) {
    assert.ok(statusLabel(state, localize).startsWith('Chronicle'));
    assert.ok(statusTooltip(state, { lastChangeAt: null, now: 0, localize, format }).length > 0);
  }
});

test('an unknown state reads as disconnected', () => {
  assert.equal(stateKey('weird'), 'disconnected');
  assert.equal(statusLabel(undefined, localize), 'Chronicle: Disconnected');
});

test('connected tooltip says when the last change came', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const tip = statusTooltip('connected', { lastChangeAt: now - 3 * 60_000, now, lang: 'en', localize, format });
  assert.match(tip, /Click to open the dashboard\.\nLast change from Chronicle: 3 minutes ago\./);
});

test('connected tooltip before any change says so', () => {
  const tip = statusTooltip('connected', { lastChangeAt: null, now: 0, localize, format });
  assert.match(tip, /No changes from Chronicle since connecting\./);
});

test('other states leave the last-change line out', () => {
  const tip = statusTooltip('reconnecting', { lastChangeAt: 1, now: 2, localize, format });
  assert.doesNotMatch(tip, /Last change/);
});

test('sinceText picks a sensible unit', () => {
  const now = 10 * 86_400_000;
  assert.equal(sinceText(now, now, 'en'), 'now');
  assert.equal(sinceText(now - 45_000, now, 'en'), '45 seconds ago');
  assert.equal(sinceText(now - 2 * 3_600_000, now, 'en'), '2 hours ago');
  assert.equal(sinceText(now - 3 * 86_400_000, now, 'en'), '3 days ago');
  assert.equal(sinceText(now + 5000, now, 'en'), 'now', 'a clock running ahead never says "in 5 seconds"');
});

test('sinceText survives a language code Intl does not know', () => {
  assert.equal(typeof sinceText(0, 60_000, 'not a language!'), 'string');
});

test('only real Chronicle messages count as changes', () => {
  assert.equal(isChronicleChange({ type: 'entity.updated' }), true);
  assert.equal(isChronicleChange({ status: 'connected' }), false, 'sync.status carries no type');
  assert.equal(isChronicleChange({ type: 'sync.retryComplete' }), false);
  assert.equal(isChronicleChange(null), false);
});
