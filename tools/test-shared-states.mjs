#!/usr/bin/env node
/**
 * Every window draws "nothing here yet", "loading" and "can't reach
 * Chronicle" with the shared cs-state / cs-loading markup, so these checks
 * walk the templates for the shape and for the old one-off classes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = readdirSync(resolve(ROOT, 'templates')).filter((f) => f.endsWith('.hbs'));
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** Replaced by the shared blocks; none may come back. */
const RETIRED = ['cqb-msg', 'dms-error', 'wizard-loading', 'wizard-empty', 'cs-empty', 'log-empty'];

/** Each opening `<div class="... cs-state ...">` up to its first closing `</div>`. */
function stateBlocks(src) {
  const out = [];
  const re = /<div class="[^"]*\bcs-state\b[^"]*"[^>]*>/g;
  for (let m; (m = re.exec(src));) {
    const end = src.indexOf('</div>', m.index);
    out.push(src.slice(m.index, end));
  }
  return out;
}

test('no template uses a retired state class', () => {
  for (const f of TEMPLATES) {
    const src = read(`templates/${f}`);
    for (const cls of RETIRED) assert.ok(!src.includes(cls), `${f} still uses ${cls}`);
  }
});

test('no template shows a spinner glyph in place of content', () => {
  for (const f of ['sync-dashboard.hbs', 'quest-board.hbs', 'quest-sheet.hbs', 'dm-screen.hbs', 'stash-window.hbs', 'import-wizard.hbs']) {
    assert.ok(!read(`templates/${f}`).includes('fa-spin'), `${f} has a spinner`);
  }
});

test('every cs-state block has a bold title and a hidden icon', () => {
  let seen = 0;
  for (const f of TEMPLATES) {
    for (const block of stateBlocks(read(`templates/${f}`))) {
      seen++;
      assert.match(block, /<b>/, `${f}: cs-state without a <b> title`);
      assert.match(block, /<i class="fa-solid [^"]*" aria-hidden="true"><\/i>/, `${f}: cs-state without an aria-hidden icon`);
      assert.doesNotMatch(block, /fa-2x/, `${f}: cs-state icon is sized inline`);
    }
  }
  assert.ok(seen > 10, 'expected the shared blocks to be found');
});

test('every cs-loading has three skeleton bars and a status role', () => {
  let seen = 0;
  for (const f of TEMPLATES) {
    const src = read(`templates/${f}`);
    const re = /<div class="cs-loading[^"]*"[^>]*>(.*?)<\/div><\/div>/g;
    for (let m; (m = re.exec(src));) {
      seen++;
      assert.match(m[0], /role="status"/, `${f}: cs-loading without role=status`);
      assert.equal((m[0].match(/class="cs-skel"/g) || []).length, 3, `${f}: cs-loading needs three cs-skel`);
    }
  }
  assert.ok(seen >= 5);
});

test('every error state names the failure and sits in an alert', () => {
  for (const f of TEMPLATES) {
    for (const block of stateBlocks(read(`templates/${f}`)).filter((b) => b.includes('is-error'))) {
      assert.match(block, /role="alert"/, `${f}: is-error without role=alert`);
      assert.match(block, /CHRONICLE\.States\.CantReach/, `${f}: is-error without the shared title`);
    }
  }
});

test('the DOM-built states use the shared helper', () => {
  for (const f of ['scripts/player-notebook.mjs', 'scripts/shop-room-window.mjs']) {
    assert.match(read(f), /stateBlock\(/, `${f} should draw its states with stateBlock`);
  }
  assert.doesNotMatch(read('scripts/sync-history-tab.mjs'), /Loading…/);
});
