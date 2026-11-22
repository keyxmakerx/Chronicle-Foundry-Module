#!/usr/bin/env node
/**
 * The gilded card look's timings and moves: the sheet removes each move's
 * class after MOVE_MS, so a move must not run longer than that or it is cut.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MOVE_MS, lookContext } from '../scripts/_hero-look-gilded.mjs';

const css = readFileSync(new URL('../styles/hero-look-gilded.css', import.meta.url), 'utf8');
const SHARED = { open: 1500, hit: 950, heal: 1050, level: 2200, editin: 900, fold: 600 };
const ms = (move) => MOVE_MS[move] ?? SHARED[move];

/** The longest "<duration> <delay>" a move's animation rules ask for, in ms. */
function longest(move) {
  let max = 0;
  for (const rule of css.matchAll(new RegExp(`\\.cs-move-${move}\\b[^{]*\\{([^}]*)\\}`, 'g'))) {
    const decl = rule[1].match(/animation:\s*cs-gilded-[\w-]+\s+(\d+)ms(?:\s+(?:calc\(([^)]*\))|(\d+)ms))?/);
    if (!decl) continue;
    let end = Number(decl[1]);
    // The opening deals the characteristics in one after another: 70ms apart, five of them.
    if (decl[2]) end += 450 + 4 * 70;
    else if (decl[3]) end += Number(decl[3]);
    max = Math.max(max, end);
  }
  return max;
}

test('the gilded look adds no figures of its own and times only the fold and Edit mode', () => {
  assert.deepEqual(lookContext({}, {}), {});
  assert.deepEqual(Object.keys(MOVE_MS).sort(), ['editin', 'fold']);
  assert.ok(Object.values(MOVE_MS).every((v) => v > 0 && v <= 4000));
});

test('each move\'s window outlasts its animations', () => {
  for (const move of ['open', 'hit', 'heal', 'level', 'editin', 'fold']) {
    const need = longest(move);
    assert.ok(need > 0, `${move} has an animation rule`);
    assert.ok(ms(move) >= need, `${move}: ${ms(move)}ms window, ${need}ms of animation`);
  }
});

test('the fold turns the card over and Calm turns every move into a fade', () => {
  assert.match(css, /\.cs-move-fold \.cs-card \{ animation: cs-gilded-turn/);
  assert.match(css, /@keyframes cs-gilded-turn \{[^}]*rotateY/);
  assert.match(css, /html\[data-cs-motion="calm"\] [^{]*\.cs-move-open \{ animation-name: cs-gilded-fade; \}/);
  assert.match(css, /html\[data-cs-motion="calm"\] [^{]*\.cs-move-hit \{ animation: none; \}/);
});
