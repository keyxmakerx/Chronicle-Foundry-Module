#!/usr/bin/env node
/**
 * The connection test shows Chronicle-side strings (system names, echoed
 * errors). The Chronicle settings window renders each step as text, so a
 * system name like `<img onerror=...>` shows verbatim and runs nothing.
 * Neither the window nor the dashboard assigns innerHTML.
 *
 * A static-source pin: there's no DOM in Node's test runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function functionBody(source, name) {
  const start = source.match(new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!start) return null;
  let depth = 1;
  for (let i = start.index + start[0].length; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start.index, i);
  }
  return null;
}

test('connection test steps are rendered as text', () => {
  const body = functionBody(read('scripts/chronicle-settings.mjs'), 'stepItem');
  assert.ok(body, 'stepItem must exist in scripts/chronicle-settings.mjs');
  assert.match(body, /createTextNode/);
  assert.doesNotMatch(body, /\binnerHTML\b/);
});

test('the settings window and the dashboard assign no innerHTML', () => {
  for (const file of ['scripts/chronicle-settings.mjs', 'scripts/sync-dashboard.mjs']) {
    const sites = read(file).split(/\r?\n/)
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => /\binnerHTML\s*[+]?=/.test(line));
    assert.deepEqual(sites.map(({ num, line }) => `${file}:${num}: ${line.trim()}`), []);
  }
});
