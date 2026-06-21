#!/usr/bin/env node
/**
 * Tests for the Foundry V1 → V2 dialog shim (scripts/_dialogs.mjs).
 *
 * Verified against the Foundry DialogV2 API docs:
 *  - DialogV2.confirm resolves true (yes) / false (no), or null when dismissed
 *    with rejectClose:false. The yes/no buttons carry built-in true/false
 *    callbacks, so the shim must NOT override them.
 *  - DialogV2.prompt's ok.callback signature is (event, button, dialog); the
 *    dialog's root element (dialog.element) is what the caller queries for its
 *    <form>.
 *
 * Plus a static pin that no module file (besides this shim) still uses the V1
 * Dialog.confirm / Dialog.prompt / new Dialog API, nor the V1 render(true).
 *
 * The rendered dialog itself can only be exercised in a live Foundry client;
 * these tests cover the shim's branching, the option shape passed to DialogV2,
 * the close→cancel coercion, and the V1 fallback.
 *
 * Run: node --test tools/test-dialogs.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPTS = resolve(REPO_ROOT, 'scripts');

const { confirmDialog, promptDialog } = await import('../scripts/_dialogs.mjs');

function clearGlobals() {
  delete globalThis.foundry;
  delete globalThis.Dialog;
  delete globalThis.game;
}
function setDialogV2(impl) {
  globalThis.foundry = { applications: { api: { DialogV2: impl } } };
}

// ---------------------------------------------------------------------
// confirmDialog — DialogV2 path
// ---------------------------------------------------------------------

test('confirmDialog: yes → true; sends window.title + content + rejectClose:false; no yes/no override', async () => {
  clearGlobals();
  let recorded = null;
  setDialogV2({ confirm: async (opts) => { recorded = opts; return true; } });
  const out = await confirmDialog({ title: 'T', content: '<p>C</p>' });
  assert.equal(out, true);
  assert.deepEqual(recorded.window, { title: 'T' });
  assert.equal(recorded.content, '<p>C</p>');
  assert.equal(recorded.rejectClose, false);
  assert.equal(recorded.yes, undefined, 'must NOT override the built-in yes button');
  assert.equal(recorded.no, undefined, 'must NOT override the built-in no button');
});

test('confirmDialog: no → false', async () => {
  clearGlobals();
  setDialogV2({ confirm: async () => false });
  assert.equal(await confirmDialog({ title: 'T' }), false);
});

test('confirmDialog: dismissed (null) → false', async () => {
  clearGlobals();
  setDialogV2({ confirm: async () => null });
  assert.equal(await confirmDialog({ title: 'T' }), false);
});

test('confirmDialog: DialogV2.confirm throws → falls back to V1 Dialog.confirm', async () => {
  clearGlobals();
  setDialogV2({ confirm: async () => { throw new Error('boom'); } });
  let v1called = false;
  globalThis.Dialog = { confirm: async () => { v1called = true; return true; } };
  assert.equal(await confirmDialog({ title: 'T' }), true);
  assert.equal(v1called, true);
});

test('confirmDialog: no DialogV2 → V1 Dialog.confirm (v12 floor), defaultYes forwarded', async () => {
  clearGlobals();
  let passed = null;
  globalThis.Dialog = { confirm: async (opts) => { passed = opts; return true; } };
  assert.equal(await confirmDialog({ title: 'T', content: 'C', defaultYes: false }), true);
  assert.equal(passed.defaultYes, false);
  assert.equal(passed.rejectClose, false);
});

test('confirmDialog: neither API present → false (never throws)', async () => {
  clearGlobals();
  assert.equal(await confirmDialog({ title: 'T' }), false);
});

// ---------------------------------------------------------------------
// promptDialog — DialogV2 path
// ---------------------------------------------------------------------

test('promptDialog: ok.callback gets dialog.element (root); returns the callback value', async () => {
  clearGlobals();
  const fakeRoot = { id: 'root' };
  let recorded = null;
  setDialogV2({
    prompt: async (opts) => {
      recorded = opts;
      // emulate Foundry invoking the button callback as (event, button, dialog)
      return opts.ok.callback({}, { form: {} }, { element: fakeRoot });
    },
  });
  const out = await promptDialog({
    title: 'T', content: 'C', label: 'Go',
    callback: (root) => (root === fakeRoot ? 'OK' : 'WRONG'),
  });
  assert.equal(out, 'OK');
  assert.deepEqual(recorded.window, { title: 'T' });
  assert.equal(recorded.rejectClose, false);
  assert.equal(recorded.ok.label, 'Go');
});

test('promptDialog: DialogV2.prompt throws → falls back to V1 Dialog.prompt', async () => {
  clearGlobals();
  setDialogV2({ prompt: async () => { throw new Error('boom'); } });
  let v1 = false;
  globalThis.Dialog = { prompt: async (opts) => { v1 = true; return opts.callback({}); } };
  assert.equal(await promptDialog({ title: 'T', callback: () => 'V1VAL' }), 'V1VAL');
  assert.equal(v1, true);
});

test('promptDialog: neither API present → null', async () => {
  clearGlobals();
  assert.equal(await promptDialog({ title: 'T', callback: () => 'x' }), null);
});

// ---------------------------------------------------------------------
// Static regression — V1 APIs must not reappear outside the shim
// ---------------------------------------------------------------------

test('no module script (besides _dialogs.mjs) uses the V1 Dialog.confirm/prompt/new Dialog API', () => {
  const offenders = [];
  for (const f of readdirSync(SCRIPTS)) {
    if (!f.endsWith('.mjs') || f === '_dialogs.mjs') continue;
    const src = readFileSync(resolve(SCRIPTS, f), 'utf8');
    if (/\bDialog\.(confirm|prompt|wait)\s*\(/.test(src) || /\bnew\s+Dialog\s*\(/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `still using V1 Dialog API: ${offenders.join(', ')}`);
});

test('no module script uses the V1 render(true) signature', () => {
  const offenders = [];
  for (const f of readdirSync(SCRIPTS)) {
    if (!f.endsWith('.mjs')) continue;
    const src = readFileSync(resolve(SCRIPTS, f), 'utf8');
    if (/\.render\(\s*true\s*\)/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `still calling .render(true): ${offenders.join(', ')}`);
});
