#!/usr/bin/env node
/**
 * `_renderTestResults` in scripts/sync-dashboard.mjs renders the
 * test-connection diagnostic into the Config tab, including Chronicle-side
 * strings (entity-type names, system names, echoed error messages). It must
 * build the DOM with `textContent` / `createTextNode`, never `innerHTML`, or
 * a malicious Chronicle-returned string (e.g. a system name containing
 * `<img onerror=...>`) executes in the dashboard's DOM context.
 *
 * This is a static-source pin (string-grep on the source), not a runtime DOM
 * test: there's no DOM in the Node test runner and `_renderTestResults` is a
 * private method on a heavyweight Application class. It still catches the
 * regression that matters — `innerHTML = ...` reappearing in the method.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const dashboardScript = readFileSync(resolve(REPO_ROOT, 'scripts/sync-dashboard.mjs'), 'utf8');

/**
 * Extract the body of `_renderTestResults` from the source. The body
 * runs from the opening `{` after the parameter list up to its matching
 * closing `}`. We use a brace-counting scan rather than a regex so a
 * future contributor can rename helpers / add control flow without
 * breaking the extraction.
 */
function extractRenderTestResultsBody(source) {
  const startMatch = source.match(/_renderTestResults\s*\([^)]*\)\s*\{/);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(startIdx, i);
    }
  }
  return null;
}

test('_renderTestResults is present in sync-dashboard.mjs', () => {
  const body = extractRenderTestResultsBody(dashboardScript);
  assert.ok(body, '_renderTestResults function body could not be located in scripts/sync-dashboard.mjs — refactored? rename?');
});

test('_renderTestResults does NOT use innerHTML assignment (M-1 fix)', () => {
  const body = extractRenderTestResultsBody(dashboardScript);
  assert.ok(body, '_renderTestResults must exist');
  // Catch both `el.innerHTML = ...` and `el.innerHTML +=...` forms.
  assert.ok(
    !/\binnerHTML\s*[+]?=/.test(body),
    '_renderTestResults uses innerHTML assignment — this re-introduces M-1 (XSS via Chronicle-side strings). '
    + 'Use textContent / createTextNode / replaceChildren / appendChild instead. '
    + 'See FM-SEC-CHUNK-1 + reports/foundry/2026-05-22-fm-security-audit.md §2 M-1.',
  );
});

test('_renderTestResults uses safe DOM construction (textContent or createTextNode or replaceChildren)', () => {
  const body = extractRenderTestResultsBody(dashboardScript);
  assert.ok(body, '_renderTestResults must exist');
  const usesSafePattern = /\b(textContent|createTextNode|replaceChildren)\b/.test(body);
  assert.ok(
    usesSafePattern,
    '_renderTestResults must use safe DOM construction — at least one of `textContent`, `createTextNode`, or `replaceChildren` should appear. '
    + 'See FM-SEC-CHUNK-1.',
  );
});

test('the only innerHTML site remaining in sync-dashboard.mjs is the static spinner (line ~1641)', () => {
  // Inventory all innerHTML sites. We allow EXACTLY ONE — the static
  // spinner that assigns a constant `<i class="fa-solid fa-spinner">`.
  // Any other site is flagged by this test for review.
  const innerHTMLLines = dashboardScript
    .split(/\r?\n/)
    .map((line, idx) => ({ line, num: idx + 1 }))
    .filter(({ line }) => /\binnerHTML\s*[+]?=/.test(line));

  // The static spinner is the only acceptable site. Its line contains the
  // exact `fa-spinner` class — distinguishes it from any Chronicle-data
  // interpolation.
  const acceptableSites = innerHTMLLines.filter(({ line }) =>
    /fa-spinner/.test(line) && !/\$\{/.test(line),
  );
  const unexpectedSites = innerHTMLLines.filter(({ line }) =>
    !(/fa-spinner/.test(line) && !/\$\{/.test(line)),
  );

  if (unexpectedSites.length > 0) {
    const sitesList = unexpectedSites.map(({ num, line }) =>
      `  scripts/sync-dashboard.mjs:${num}: ${line.trim()}`,
    ).join('\n');
    assert.fail(
      `Unexpected innerHTML assignment site(s) found in scripts/sync-dashboard.mjs:\n${sitesList}\n`
      + 'Each unexpected innerHTML is a potential XSS regression. '
      + 'Either (a) audit the site for Chronicle-data interpolation and fix; or '
      + '(b) if static-only, update this guard\'s allowlist. See FM-SEC-CHUNK-1.',
    );
  }
  assert.ok(
    acceptableSites.length >= 1,
    'Expected the static-spinner innerHTML site to remain (the only acceptable form). If it was removed, update the guard.',
  );
});
