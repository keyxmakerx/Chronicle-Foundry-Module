#!/usr/bin/env node
/**
 * Tool windows take their colours from styles/tokens.css so they follow
 * Foundry's light and dark themes. This guard fails when a status or text
 * colour tuned for dark windows only comes back as a literal in a tool
 * window's stylesheet, and checks both themes define every token.
 *
 * Paper windows (quests.css, map-frames.css) and the parts of
 * chronicle-sync.css that draw the shop room, the calendar strip's sky and
 * the NPC banner over the canvas keep their own palettes and are not walked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** The dark-only status palette the tokens replaced. */
const DARK_ONLY = ['#4ade80', '#f87171', '#60a5fa', '#fbbf24', '#fb923c', '#ff7b72', '#94a3b8', '#cbd5e1', '#e2e8f0'];

/** Stylesheets whose every rule is a tool window. */
const TOOL_SHEETS = ['styles/import-wizard.css', 'styles/stashes.css', 'styles/dm-screen.css'];

/** chronicle-sync.css with its own-palette sections cut out. */
function chronicleSyncToolRules() {
  const css = read('styles/chronicle-sync.css');
  const cut = (s, from, to) => {
    const a = s.indexOf(from);
    const b = s.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `section markers moved: ${from}`);
    return s.slice(0, a) + s.slice(b);
  };
  let s = cut(css, '/* Shop room window.', '/* ===');
  s = cut(s, '/* NPC spotlight name banner', '/* ---- Pictures inside');
  s = s.slice(0, s.indexOf('/* Built-in calendar:'));
  return s;
}

function literalsIn(css) {
  const lower = css.toLowerCase();
  return DARK_ONLY.filter((hex) => new RegExp(`${hex}(?![0-9a-f])`).test(lower));
}

test('tool-window stylesheets use tokens, not dark-only literals', () => {
  for (const sheet of TOOL_SHEETS) assert.deepEqual(literalsIn(read(sheet)), [], sheet);
  assert.deepEqual(literalsIn(chronicleSyncToolRules()), [], 'styles/chronicle-sync.css');
});

test('every token has a light and a dark value', () => {
  const css = read('styles/tokens.css');
  const blocks = [...css.matchAll(/\{([^}]*)\}/g)].map((m) => new Set([...m[1].matchAll(/(--cs-[a-z0-9-]+)\s*:/g)].map((x) => x[1])));
  assert.equal(blocks.length, 2, 'one light block and one dark block');
  assert.deepEqual([...blocks[1]].sort(), [...blocks[0]].sort());
});

test('tokens load before every other stylesheet', () => {
  const styles = JSON.parse(read('module.json')).styles;
  assert.equal(styles[0], 'styles/tokens.css');
});
