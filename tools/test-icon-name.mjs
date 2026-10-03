#!/usr/bin/env node
/**
 * The import wizard sends category icons in the bare form Chronicle stores
 * (`fa-ship`), stripping a style token and defaulting a blank to fa-circle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_ICON, toIconName } from '../scripts/_icon-name.mjs';

test('style tokens are stripped', () => {
  for (const style of ['fa-solid', 'fas', 'fa-regular', 'far', 'fa']) {
    assert.equal(toIconName(`${style} fa-ship`), 'fa-ship', style);
  }
  assert.equal(toIconName('  fa-solid   fa-ship  '), 'fa-ship');
});

test('a bare name passes through trimmed', () => {
  assert.equal(toIconName('fa-ship'), 'fa-ship');
  assert.equal(toIconName(' fa-ship\n'), 'fa-ship');
});

test('blank or missing becomes the default', () => {
  for (const raw of ['', '   ', null, undefined]) assert.equal(toIconName(raw), DEFAULT_ICON);
  assert.equal(DEFAULT_ICON, 'fa-circle');
});

test('values Chronicle refuses are sent as typed, for its 400 to explain', () => {
  assert.equal(toIconName('fa-brands fa-github'), 'fa-brands fa-github');
  assert.equal(toIconName('fa-solid fa-ship fa-spin'), 'fa-ship fa-spin');
  assert.equal(toIconName('fa-solid'), 'fa-solid');
});

test('the import wizard has no style-prefixed icon literals left', async () => {
  const src = await readFile(new URL('../scripts/import-wizard.mjs', import.meta.url), 'utf8');
  assert.ok(!/icon:\s*'fa-solid fa-circle'/.test(src), 'new-type form default');
  assert.ok(!/icon\s*\|\|\s*'fa-solid/.test(src), 'create fallback');
  assert.match(src, /icon:\s*toIconName\(icon\)/);
});
