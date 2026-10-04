#!/usr/bin/env node
/**
 * The import wizard's step list and its template panels must line up: a
 * panel shows when its data-step equals the current STEPS index. Also pins
 * that the scene-to-map link step stays gone: Chronicle maps materialize as
 * journal pages on connect, so linking scenes did nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../scripts/import-wizard.mjs', import.meta.url), 'utf8');
const hbs = await readFile(new URL('../templates/import-wizard.hbs', import.meta.url), 'utf8');

const stepKeys = [...src.matchAll(/\{\s*key:\s*'([a-z]+)',\s*labelKey:\s*'CHRONICLE\.Wizard\.Steps\./g)].map((m) => m[1]);

test('step list has no maps step and ends with review', () => {
  assert.deepEqual(stepKeys, ['connect', 'scan', 'types', 'tags', 'characters', 'review']);
});

test('template has one panel per step, numbered 0..n-1', () => {
  const panels = [...hbs.matchAll(/class="wizard-step" data-step="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(panels, stepKeys.map((_, i) => i));
});

test('no scene-to-map linking is left in the wizard or the import runner', async () => {
  const manager = await readFile(new URL('../scripts/sync-manager.mjs', import.meta.url), 'utf8');
  assert.ok(!/link-map/.test(src + hbs + manager));
  assert.ok(!/wizard-map-select|mapLinkPlan/.test(src + hbs));
});
