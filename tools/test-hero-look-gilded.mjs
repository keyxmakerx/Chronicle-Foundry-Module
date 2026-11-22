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

const TIME = /(\d*\.?\d+)(ms|s)\b/g;
const toMs = (n, u) => Number(n) * (u === 's' ? 1000 : 1);

/** Evaluates a delay written as calc(var(--i, 0) * Nms + Mms) for the last of five items (--i: 4). */
function calcMs(text) {
  const m = text.match(/calc\(\s*var\(--i,\s*\d+\)\s*\*\s*(\d*\.?\d+)(ms|s)\s*\+\s*(\d*\.?\d+)(ms|s)\s*\)/);
  return m ? 4 * toMs(m[1], m[2]) + toMs(m[3], m[4]) : null;
}

/**
 * The longest a move's animation rules run, in ms: each `animation` shorthand's
 * duration plus its own delay (a number, a time or a calc()), and, for a rule
 * that leaves its delay to a separate `animation-delay` rule, the largest of those.
 */
function longest(move) {
  let max = 0;
  const bare = new Map();
  const delays = new Map();
  for (const rule of css.matchAll(new RegExp(`(\\.cs-move-${move}\\b[^{]*)\\{([^}]*)\\}`, 'g'))) {
    // Rules for the nth item share the first item's selector, without the :nth-child().
    const key = rule[1].replace(/:nth-child\([^)]*\)/, '').trim();
    for (const d of rule[2].matchAll(/animation-delay:\s*(\d*\.?\d+)(ms|s)/g)) delays.set(key, Math.max(delays.get(key) ?? 0, toMs(d[1], d[2])));
    const decl = rule[2].match(/animation:\s*cs-gilded-[\w-]+\s+([^;]+);/);
    if (!decl) continue;
    const calc = calcMs(decl[1]);
    const times = [...decl[1].replace(/calc\(.*?\)\s*(?=[\w(]|$)/, ' ').matchAll(TIME)].map((t) => toMs(t[1], t[2]));
    const duration = times[0] ?? 0;
    const delay = calc ?? times[1];
    if (delay === undefined) bare.set(key, Math.max(bare.get(key) ?? 0, duration));
    else max = Math.max(max, duration + delay);
  }
  for (const [key, duration] of bare) max = Math.max(max, duration + (delays.get(key) ?? 0));
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
