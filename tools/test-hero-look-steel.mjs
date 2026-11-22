#!/usr/bin/env node
/**
 * Pins what the steel and banner look relies on that no other test sees: the
 * blade's number reads on every red and amber it can sit on, the blade's
 * fill and notch animation share one value, the banner turns into a pennant
 * across the top in narrow windows, and its ambient sway stops under Calm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookContext, MOVE_MS } from '../scripts/_hero-look-steel.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('styles/hero-look-steel.css');
const stats = read('templates/hero-looks/steel/stats.hbs');
const header = read('templates/hero-looks/steel/header.hbs');

const token = (name) => css.match(new RegExp(`--cs-steel-${name}: (#[0-9a-f]{6});`))?.[1];
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the blade\'s white lettering reads on every fill it can sit on', () => {
  for (const name of ['blade-hi', 'blade-lo', 'wind-hi', 'wind-lo']) {
    assert.ok(token(name), name);
    assert.ok(contrast(token('white'), token(name)) >= 4.5, `${name}: ${contrast(token('white'), token(name)).toFixed(2)}`);
  }
});

test('the blade carries its band and fill, and the notch drop starts from the same fill', () => {
  assert.match(stats, /class="cs-steel-blade" data-band="\{\{chronicle\.stamina\.band\}\}" style="--fill: \{\{chronicle\.stamina\.fill\}\};/);
  assert.match(css, /transform: scaleX\(calc\(var\(--fill, 0\) \/ 100\)\)/);
  assert.match(css, /@keyframes cs-steel-notch \{ from \{ transform: scaleX\(min\(1, calc\(\(var\(--fill, 0\) \+ \d+\) \/ 100\)\)\); \} \}/);
  assert.match(css, /\.cs-move-hit \.cs-steel-fill \{ animation: cs-steel-notch 450ms steps\(5, end\); \}/);
});

test('the picture sits in the banner\'s shield and a hero without one gets the look\'s own emblem', () => {
  assert.match(header, /class="cs-steel-crest">[\s\S]*cs-steel-emblem[\s\S]*class="cs-portrait-btn"/);
  assert.match(css, /\.cs-steel-crest:has\(\.cs-portrait:is\(\[src\$="mystery-man\.svg"\]/);
});

test('narrow windows hang the banner across the top, and Calm holds it still', () => {
  const narrow = css.slice(css.indexOf('@container cs-hero (max-width: 760px)'));
  assert.match(narrow, /\.cs-steel-banner \{[^}]*position: relative;/);
  assert.match(narrow, /grid-template-areas: "crest lvl cls" "crest lvl col";/);
  assert.match(css, /\.cs-steel-hang \{ animation: cs-steel-sway 7s ease-in-out infinite; \}/);
  assert.match(css, /html\[data-cs-motion="calm"\] [^{]*\.cs-steel-hang[^{]*\{ animation: none; \}/);
});

test('the look adds no figures of its own and keeps the shared move timings', () => {
  assert.deepEqual(lookContext({}, {}), {});
  assert.deepEqual(MOVE_MS, {});
});

const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Each `@container name (cond) { … }` in the stylesheet, with the selectors inside. */
function containerQueries() {
  const out = [];
  for (const m of bare.matchAll(/@container ([\w-]+) \([^)]*\) \{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth && i < bare.length) { if (bare[i] === '{') depth += 1; else if (bare[i] === '}') depth -= 1; i += 1; }
    const body = bare.slice(start, i - 1);
    out.push({ name: m[1], selectors: [...body.matchAll(/([^{}]+)\{/g)].map((x) => x[1].trim()) });
  }
  return out;
}

/** The last compound of each selector in a rule's list, e.g. `.cs-steel-id`. */
const lastCompounds = (list) => list.split(',').map((s) => s.trim().split(/[\s>+~]+/).at(-1).replace(/::?[\w-]+(\([^)]*\))?/g, ''));

test('no selector names the window twice, which could never match', () => {
  for (const m of bare.matchAll(/([^{}]+)\{/g)) {
    for (const sel of m[1].split(',')) assert.ok((sel.match(/chronicle-hero-sheet\[/g) ?? []).length <= 1, sel.trim());
  }
  // The check catches the slip it exists for.
  assert.equal(('.a .draw-steel.actor.chronicle-hero-sheet[x] .b'.match(/chronicle-hero-sheet\[/g) ?? []).length, 1);
});

test('every container query asks a container that exists, and restyles only what is inside it', () => {
  const declared = new Map();
  for (const m of bare.matchAll(/([^{}]+)\{[^{}]*\bcontainer: ([\w-]+) \//g)) declared.set(m[2], lastCompounds(m[1]));
  const queries = containerQueries();
  assert.ok(queries.length >= 5);
  const shared = read('styles/hero-looks.css');
  for (const q of queries) {
    assert.ok(declared.has(q.name) || shared.includes(`container: ${q.name} /`), `${q.name} is never declared`);
    const owners = declared.get(q.name) ?? [];
    for (const sel of q.selectors) {
      for (const c of lastCompounds(sel)) assert.ok(!owners.includes(c), `@container ${q.name} restyles its own container ${c}`);
    }
  }
});

test('the heal shine lives inside the clipped blade, so it never paints outside it', () => {
  assert.match(stats, /<span class="cs-steel-fillwrap">[^]*?cs-steel-shine[^]*?<\/span>/);
});

test('the sway begins and ends at rest, so a redraw never shows a jump', () => {
  const kf = bare.match(/@keyframes cs-steel-sway \{([^]*?)\n\}|@keyframes cs-steel-sway \{(.*)\}$/m);
  const body = bare.match(/@keyframes cs-steel-sway \{(.*)\}\s*$/m)?.[1] ?? '';
  assert.ok(kf);
  assert.doesNotMatch(body, /\b0%|\b100%/);
});

test('nothing sinks when pressed under Calm, whatever the control\'s own press rule', () => {
  assert.match(bare, /html\[data-cs-motion="calm"\][^{]*:active \{ translate: none !important; \}/);
});
