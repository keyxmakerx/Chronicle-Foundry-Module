#!/usr/bin/env node
/**
 * Chronicle's shortcuts ship unbound, GM windows are GM-only, and a shortcut
 * that needs Chronicle lets the key through while the world isn't connected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerShortcuts, SHORTCUTS } from '../scripts/_keybindings.mjs';

const en = JSON.parse(readFileSync(new URL('../lang/en.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, p) => o?.[p], en);

function register(connected = true) {
  const calls = [];
  const opened = [];
  const run = Object.fromEntries(SHORTCUTS.map(({ action }) => [action, () => opened.push(action)]));
  registerShortcuts({ register: (ns, action, opts) => calls.push({ ns, action, opts }) }, 'chronicle-sync', {
    run, connected: () => connected,
  });
  return { calls, opened };
}

test('every shortcut ships with no key bound', () => {
  const { calls } = register();
  assert.equal(calls.length, SHORTCUTS.length);
  for (const { opts } of calls) assert.deepEqual(opts.editable, []);
});

test('GM windows are restricted to GMs; player windows are not', () => {
  const { calls } = register();
  const restricted = calls.filter((c) => c.opts.restricted).map((c) => c.action);
  assert.deepEqual(restricted, ['openDashboard', 'openDMScreen']);
});

test('each shortcut names keys found in en.json', () => {
  for (const { action, opts } of register().calls) {
    assert.equal(typeof lookup(opts.name), 'string', action);
    assert.equal(typeof lookup(opts.hint), 'string', action);
  }
});

test('four shortcuts: Chronicle Sync, DM Screen, Satchel and Calendar', () => {
  assert.deepEqual(SHORTCUTS.map((s) => s.action), ['openDashboard', 'openDMScreen', 'openSatchel', 'openCalendar']);
});

test('a pressed shortcut opens its window and consumes the key', () => {
  const { calls, opened } = register(true);
  const satchel = calls.find((c) => c.action === 'openSatchel');
  assert.equal(satchel.opts.onDown(), true);
  assert.deepEqual(opened, ['openSatchel']);
});

test('while not connected, Chronicle-only shortcuts let the key through', () => {
  const { calls, opened } = register(false);
  assert.equal(calls.find((c) => c.action === 'openSatchel').opts.onDown(), false);
  assert.equal(calls.find((c) => c.action === 'openDashboard').opts.onDown(), true);
  assert.deepEqual(opened, ['openDashboard']);
});
