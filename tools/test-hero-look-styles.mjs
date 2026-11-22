#!/usr/bin/env node
/**
 * Pins the rules every look's stylesheet (styles/hero-look-<look>.css) keeps,
 * so the looks stay apart: one set of values for the sheet's tokens, every
 * rule under the look's own [data-cs-look], its keyframes named for it, a
 * Calm version of its moves, and every font it loads shipped with its
 * licence. The looks after the hall also keep every colour in their token
 * block, so a colour changes in one place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HERO_LOOKS } from '../scripts/_hero-looks.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LOOKS = HERO_LOOKS.slice(1).map((l) => l.id);
const sheetFor = (id) => `styles/hero-look-${id}.css`;
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector is exactly `sel`. */
function block(css, sel) {
  const at = css.indexOf(`${sel} {`);
  assert.ok(at >= 0, sel);
  return css.slice(at, css.indexOf('}', at) + 1);
}

/** Every style rule's selector list, inside @container, @media and @supports too. */
function selectors(css) {
  const out = [];
  const src = noComments(css);
  let i = 0;
  const walk = (end) => {
    while (i < end) {
      const open = src.indexOf('{', i);
      const close = src.indexOf('}', i);
      if (open < 0 || open > end || (close >= 0 && close < open)) { i = close < 0 ? end : close + 1; return; }
      const prelude = src.slice(i, open).trim();
      i = open + 1;
      if (/^@(container|media|supports|layer)\b/.test(prelude)) walk(end);
      else if (/^@(font-face|keyframes)\b/.test(prelude)) {
        let depth = 1;
        while (depth && i < end) { if (src[i] === '{') depth += 1; else if (src[i] === '}') depth -= 1; i += 1; }
      } else {
        out.push(prelude);
        i = src.indexOf('}', i) + 1;
      }
    }
  };
  walk(src.length);
  return out;
}

/** A selector list split at its top-level commas, not those inside :is() or :has(). */
function splitList(list) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  out.push(list.slice(from));
  return out;
}

test('every look after the first has its stylesheet, loaded after the sheet\'s', () => {
  const styles = JSON.parse(read('module.json')).styles;
  for (const id of LOOKS) {
    assert.ok(existsSync(new URL(`../${sheetFor(id)}`, import.meta.url)), id);
    assert.ok(styles.indexOf(sheetFor(id)) > styles.indexOf('styles/hero-looks.css'), id);
  }
});

test('each look gives every token the sheet reads a value, in one block', () => {
  const base = read('styles/hero-looks.css');
  const read_ = new Set([...base.matchAll(/var\((--cs-hero-[a-z-]+)/g)].map((m) => m[1]));
  read_.delete('--cs-hero-ease');
  for (const id of LOOKS) {
    const tokens = block(read(sheetFor(id)), `.chronicle-hero-sheet[data-cs-look="${id}"]`);
    const names = new Set([...tokens.matchAll(/(--cs-hero-[a-z-]+)\s*:/g)].map((m) => m[1]));
    for (const t of read_) assert.ok(names.has(t), `${id}: ${t}`);
    assert.match(tokens, /--cs-hero-radius: \d+px;/, id);
  }
});

test('every rule in a look\'s stylesheet is scoped to that look', () => {
  for (const id of LOOKS) {
    const scope = `[data-cs-look="${id}"]`;
    for (const list of selectors(read(sheetFor(id)))) {
      for (const sel of splitList(list)) assert.ok(sel.includes(scope), `${id}: ${sel.trim()}`);
    }
  }
});

test('a look\'s keyframes are named for it, its moves each have a rule and Calm has its own', () => {
  for (const id of LOOKS) {
    const css = noComments(read(sheetFor(id)));
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) assert.ok(m[1].startsWith(`cs-${id}-`), `${id}: ${m[1]}`);
    for (const move of ['open', 'hit', 'heal', 'level', 'editin']) assert.match(css, new RegExp(`\\.cs-move-${move}\\b`), `${id}: ${move}`);
    assert.match(css, new RegExp(`html\\[data-cs-motion="calm"\\] \\.chronicle-hero-sheet\\[data-cs-look="${id}"\\]`), id);
    // A pseudo-element inside :is() voids the whole selector.
    assert.doesNotMatch(css, /:is\([^)]*::/, id);
  }
});

test('every font a look loads ships in fonts/ with its licence', () => {
  for (const id of LOOKS) {
    for (const m of read(sheetFor(id)).matchAll(/url\("\.\.\/fonts\/([^"]+)"\)/g)) {
      assert.ok(existsSync(new URL(`../fonts/${m[1]}`, import.meta.url)), `${id}: ${m[1]}`);
      assert.match(read(`fonts/${m[1].split('-')[0]}-OFL.txt`), /SIL Open Font License/, m[1]);
    }
  }
});

test('the looks after the hall keep every colour in their token block', () => {
  const COLOUR = /#[0-9a-f]{3,8}\b|%23[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/gi;
  for (const id of LOOKS.filter((l) => l !== 'hall')) {
    const css = noComments(read(sheetFor(id)));
    const rest = css.replace(block(css, `.chronicle-hero-sheet[data-cs-look="${id}"]`), '');
    assert.deepEqual(rest.match(COLOUR), null, id);
  }
});

test('no selector in a look asks for the window inside itself', () => {
  for (const id of LOOKS) {
    for (const list of selectors(read(sheetFor(id)))) {
      for (const sel of splitList(list)) {
        assert.ok((sel.match(/\.chronicle-hero-sheet\b/g) ?? []).length <= 1, `${id}: ${sel.trim()}`);
      }
    }
  }
});

test('every container a look\'s queries name is declared, in its stylesheet or the sheet\'s', () => {
  const declared = (css) => new Set([...noComments(css).matchAll(/container(?:-name)?:\s*([a-z][\w-]*)/g)].map((m) => m[1]));
  const base = declared(read('styles/hero-looks.css'));
  for (const id of LOOKS) {
    const css = read(sheetFor(id));
    const names = new Set([...base, ...declared(css)]);
    for (const m of noComments(css).matchAll(/@container\s+([a-z][\w-]*)\s*\(/g)) assert.ok(names.has(m[1]), `${id}: ${m[1]}`);
  }
});
