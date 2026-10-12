#!/usr/bin/env node
/**
 * Text that Chronicle or a user supplied must be HTML-escaped before it
 * reaches ui.notifications (Foundry v12 inserts that text as HTML), and
 * escapeHtml must neutralise markup, and noticeText escapes on every Foundry version.
 *
 * The guard scans every ui.notifications call in scripts/: each `${...}`
 * and each game.i18n.format substitution value must be wrapped in
 * noticeText(...) or be one of the plain numeric expressions listed below.
 * A new call with a bare name fails here; wrap it, or add the expression to
 * NUMERIC if it can only be a number.
 *
 * Run: node --test tools/test-notification-escape.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml, noticeText } from '../scripts/_escape-html.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

test('escapeHtml neutralises markup and quotes', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`a&b "c" 'd'`), 'a&amp;b &quot;c&quot; &#39;d&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('noticeText escapes markup and turns null and undefined into an empty string', () => {
  assert.equal(noticeText('<b>A&B</b>'), '&lt;b&gt;A&amp;B&lt;/b&gt;');
  assert.equal(noticeText(null), '');
  assert.equal(noticeText(undefined), '');
});

test('escapeHtml does not re-escape its own output differently on a second pass of raw text', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

// Expressions that can only be numbers or fixed strings.
const NUMERIC = new Set([
  'count', 'moved', 'n', 'done', 'updated', 'created', 'errors', 'failures', 'materialized',
  'updated + created', 'allEntities.length', 'allEntities.length - skipped', 'maps.length',
  'unmapped.length', "unmapped.length === 1 ? '' : 's'", 'status ? ` (HTTP ${status})` : \'\'',
  "n === 1 ? '' : 's'", "''", 'r.reason', // r.reason is a fixed code from _notes-grant.mjs
  'status', 'result.deleted', 'result.kept', "done.join(', ') || 'nothing to sync'",
]);

/** The text of a call starting at the `(` at `open`, balanced, string-aware. */
function callText(src, open) {
  let depth = 0;
  let quote = null;
  const tpl = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') { tpl.push(0); i++; quote = null; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (tpl.length && c === '{') { tpl[tpl.length - 1]++; continue; }
    if (tpl.length && c === '}') {
      if (tpl[tpl.length - 1] === 0) { tpl.pop(); quote = '`'; continue; }
      tpl[tpl.length - 1]--;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Every `${expr}` in the text, with nesting handled. */
function interpolations(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$' || text[i + 1] !== '{') continue;
    let depth = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      if (text[j] === '}' && --depth === 0) break;
    }
    out.push(text.slice(i + 2, j).trim());
    i = j;
  }
  return out;
}

// A label ternary wraps noticeText.
const SAFE_WRAP = /^noticeText\(|^label \? `[^`]*\$\{noticeText\(label\)\}[^`]*` : ''$/;

function isSafe(expr) {
  return SAFE_WRAP.test(expr) || NUMERIC.has(expr);
}

const findings = [];
for (const file of readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'))) {
  const src = readFileSync(SCRIPTS + file, 'utf8');
  const re = /ui\??\.notifications\??\.(?:info|warn|error)\??\.?\(/g;
  let m;
  while ((m = re.exec(src))) {
    const text = callText(src, m.index + m[0].length - 1);
    const line = src.slice(0, m.index).split('\n').length;
    for (const expr of interpolations(text)) {
      // A nested `${...}` inside an escaped or numeric expression is covered
      // by its outer expression, so only top-level ones are listed.
      if (!isSafe(expr)) findings.push(`${file}:${line}  \${${expr}}`);
    }
    const fmt = text.match(/game\.i18n\.format\(\s*(['"`][^'"`]*['"`])\s*,\s*\{/);
    if (fmt) {
      const body = text.slice(text.indexOf('{', fmt.index + fmt[0].length - 1));
      const props = [...body.matchAll(/(?:^|[{,]\s*)(\w+)\s*(?::\s*((?:escapeHtml\([^]*?\)|[^,}]+)))?(?=\s*[,}])/g)];
      for (const [, key, value] of props) {
        const v = (value || key).trim();
        if (!isSafe(v)) findings.push(`${file}:${line}  i18n ${key}: ${v}`);
      }
    }
  }
}

test('every ui.notifications call escapes Chronicle- and user-sourced text', () => {
  assert.deepEqual(findings, [], `unescaped values reach ui.notifications:\n${findings.join('\n')}`);
});
