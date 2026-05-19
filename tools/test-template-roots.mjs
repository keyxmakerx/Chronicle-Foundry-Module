#!/usr/bin/env node
/**
 * CI guard for ApplicationV2 PARTS templates — each template registered
 * via a `static PARTS = { ..., template: 'modules/.../templates/X.hbs' }`
 * binding must render exactly ONE root HTML element in every possible
 * branch combination.
 *
 * Foundry's `_parsePartHTML` (foundry.mjs:32135) throws on any rendering
 * that doesn't produce a single root: "Template part 'X' must render a
 * single HTML element." This caps each `PARTS.X.template` to one root
 * regardless of {{#if}}/{{else}} branches taken at runtime.
 *
 * Bug context: 2026-05-19, FM-SYNCCAL-ROOT-FIX. Operator's Foundry
 * console threw the above message every time Sync Calendar opened.
 * `templates/sync-calendar.hbs` had a top-level `{{#if degraded}}<section/>{{else}}<header/><main/><footer/>{{/if}}`
 * — the `else` branch had three sibling roots → reject → app dead.
 *
 * Same footgun class as F-LANG-1 (lang expandObject collision):
 * Foundry-runtime contract that Node-only tests can't catch unless we
 * explicitly model it.
 *
 * Approach: pure static analyzer. No Handlebars npm dep (CI is plain
 * Node + node:test). Walks the template source, tracks Handlebars block
 * depth + HTML element depth, recurses through every branch of every
 * conditional, and reports the MAX number of root HTML elements that
 * could emerge across all branch combinations. Asserts ≤1 for every
 * registered PARTS template.
 *
 * Caveat: `{{#each}}` at the outermost HTML depth would amplify a
 * single-root inner body to N roots over N iterations. The analyzer
 * conservatively flags any top-level `{{#each}}` as a potential
 * multi-root, matching Foundry's runtime behavior.
 *
 * Run: `node --test tools/test-template-roots.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

// ---------------------------------------------------------------------
// Template discovery: grep every script for `template: 'modules/.../X.hbs'`
// bindings, since those are the strings ApplicationV2 actually feeds to
// `_parsePartHTML`. Anything else in templates/ might be an inert
// fragment that nobody renders as a root part.
// ---------------------------------------------------------------------

function discoverPartsTemplates() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        const src = readFileSync(full, 'utf8');
        const re = /template:\s*['"`]modules\/chronicle-sync\/(templates\/[^'"`]+\.hbs)['"`]/g;
        let m;
        while ((m = re.exec(src)) !== null) found.add(m[1]);
      }
    }
  };
  walk(SCRIPTS_DIR);
  return Array.from(found).sort();
}

// ---------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------

/**
 * Strip Handlebars comments. Both `{{!-- ... --}}` and `{{! ... }}` forms.
 */
function stripComments(text) {
  return text
    .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
    .replace(/\{\{![^}]*\}\}/g, '');
}

/**
 * HTML void elements per the HTML spec. Always self-closing.
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Find the matching `{{/name}}` for a `{{#name ...}}` starting at index
 * `start` in `text`. Returns the index of the `{{` of the closer.
 * Throws on unbalanced.
 */
function findMatchingBlockClose(text, name, start) {
  let i = start;
  while (i < text.length) {
    const restart = text.slice(i);
    const nextOpen = /\{\{#\s*(\w+)/.exec(restart);
    const nextClose = new RegExp(`\\{\\{/\\s*${escapeRegex(name)}\\s*\\}\\}`).exec(restart);
    if (!nextClose) throw new Error(`unbalanced {{#${name}}}`);
    if (nextOpen && nextOpen.index < nextClose.index) {
      // Skip past this nested block by recursing on its name.
      const nestedName = nextOpen[1];
      const nestedAbsStart = i + nextOpen.index + nextOpen[0].length;
      const nestedCloseIdx = findMatchingBlockClose(text, nestedName, nestedAbsStart);
      // skip past the {{/nestedName}}
      const nestedCloseEnd = text.indexOf('}}', nestedCloseIdx) + 2;
      i = nestedCloseEnd;
      continue;
    }
    return i + nextClose.index;
  }
  throw new Error(`unbalanced {{#${name}}}`);
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Find positions of `{{else}}` tokens at the SAME Handlebars depth as
 * the body's outer scope. Returns an array of indexes (start of `{{`).
 */
function findElseSplits(body) {
  const splits = [];
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    const nextElse  = /\{\{\s*else\s*\}\}/.exec(rest);
    const nextOpen  = /\{\{#\s*(\w+)/.exec(rest);
    if (!nextElse) break;
    if (nextOpen && nextOpen.index < nextElse.index) {
      // skip past this nested block entirely
      const name = nextOpen[1];
      const blockBodyStart = i + nextOpen.index + nextOpen[0].length;
      const blockCloseIdx = findMatchingBlockClose(body, name, blockBodyStart);
      const closeEnd = body.indexOf('}}', blockCloseIdx) + 2;
      i = closeEnd;
      continue;
    }
    splits.push(i + nextElse.index);
    i = i + nextElse.index + nextElse[0].length;
  }
  return splits;
}

/**
 * Parse a template body into a flat token list at the current
 * Handlebars depth. Recognized token kinds:
 *
 *   - { kind: 'htmlOpen',  tag }
 *   - { kind: 'htmlClose', tag }
 *   - { kind: 'htmlVoid',  tag }
 *   - { kind: 'hbsBlock',  name, branches: [string, ...] }
 *   - { kind: 'hbsExpr' }      (ignored — text emission only)
 *   - { kind: 'text' }         (ignored — whitespace/literal content)
 *
 * Branches are split on `{{else}}` at the body's outermost depth.
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    // Handlebars block?
    const hbsBlockMatch = /^\{\{#\s*(\w+)([^}]*)\}\}/.exec(text.slice(i));
    if (hbsBlockMatch) {
      const name = hbsBlockMatch[1];
      const bodyStart = i + hbsBlockMatch[0].length;
      const closeIdx = findMatchingBlockClose(text, name, bodyStart);
      const body = text.slice(bodyStart, closeIdx);
      const splits = findElseSplits(body);
      const branches = [];
      let cursor = 0;
      for (const s of splits) {
        branches.push(body.slice(cursor, s));
        // skip past the {{else}} token
        const elseMatch = /\{\{\s*else\s*\}\}/.exec(body.slice(s));
        cursor = s + elseMatch[0].length;
      }
      branches.push(body.slice(cursor));
      tokens.push({ kind: 'hbsBlock', name, branches });
      i = text.indexOf('}}', closeIdx) + 2;
      continue;
    }
    // Handlebars expression?
    const hbsExprMatch = /^\{\{[^#/][^}]*\}\}/.exec(text.slice(i));
    if (hbsExprMatch) {
      tokens.push({ kind: 'hbsExpr' });
      i += hbsExprMatch[0].length;
      continue;
    }
    // HTML close tag?
    const closeTagMatch = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(text.slice(i));
    if (closeTagMatch) {
      tokens.push({ kind: 'htmlClose', tag: closeTagMatch[1].toLowerCase() });
      i += closeTagMatch[0].length;
      continue;
    }
    // HTML open tag (may be self-closing or void)?
    const openTagMatch = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/.exec(text.slice(i));
    if (openTagMatch) {
      const tag = openTagMatch[1].toLowerCase();
      const attrs = openTagMatch[2];
      const selfClosed = /\/\s*$/.test(attrs);
      if (selfClosed || VOID_TAGS.has(tag)) {
        tokens.push({ kind: 'htmlVoid', tag });
      } else {
        tokens.push({ kind: 'htmlOpen', tag });
      }
      i += openTagMatch[0].length;
      continue;
    }
    // Anything else (text, whitespace, stray `<` not starting a tag, etc.) — skip char.
    tokens.push({ kind: 'text' });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------
// Root analysis
// ---------------------------------------------------------------------

/**
 * Given a token sequence, compute the MAX number of root HTML elements
 * that could be emitted across any choice of conditional branches.
 *
 * "Root" means an HTML element opened at HTML depth 0. Nested elements
 * don't count.
 *
 * @returns {{ max: number, min: number }}
 */
function rootElementBounds(tokens) {
  let htmlDepth = 0;
  let runningMax = 0;
  let runningMin = 0;
  for (const t of tokens) {
    if (htmlDepth === 0) {
      if (t.kind === 'htmlOpen') {
        runningMax++;
        runningMin++;
        htmlDepth = 1;
      } else if (t.kind === 'htmlVoid') {
        runningMax++;
        runningMin++;
      } else if (t.kind === 'hbsBlock') {
        const sub = blockBounds(t);
        runningMax += sub.max;
        runningMin += sub.min;
      }
      // text / hbsExpr / unexpected htmlClose at depth 0 → ignore
    } else {
      if (t.kind === 'htmlOpen') htmlDepth++;
      else if (t.kind === 'htmlClose') htmlDepth--;
      else if (t.kind === 'hbsBlock') {
        // Inside an HTML element, root count doesn't change — the block
        // contributes children, not roots. Skip.
      }
      // void/text/expr at deeper depth: ignore
    }
  }
  return { max: runningMax, min: runningMin };
}

/**
 * Compute the root bounds contribution of a single Handlebars block.
 *
 * - `{{#if}}{{else}}{{/if}}`     → MAX/MIN over both branches
 * - `{{#unless}}{{else}}{{/unless}}` → ditto (unless = if-not, two branches)
 * - `{{#each}}{{/each}}`         → MAX = inner_max * 2 (conservative cap;
 *                                  N iterations could amplify); MIN = 0
 * - `{{#with}}{{/with}}`         → exactly one branch
 */
function blockBounds(block) {
  const branchBounds = block.branches.map((b) => rootElementBounds(tokenize(b)));
  if (block.name === 'each') {
    // 0 iterations → 0 roots; ≥2 iterations of a single-root body → ≥2 roots.
    // We treat `{{#each}}` at the top level as a single-root violation if
    // its body produces ≥1 root (since N iterations multiply it).
    // For {{else}} clause (empty list case): only the else-body roots count.
    const bodyMax = branchBounds[0]?.max ?? 0;
    const elseMax = branchBounds[1]?.max ?? 0;
    // Worst case at top level: many iterations of body, OR the else branch.
    // Use 2 * bodyMax as the conservative "many iterations" cap.
    const max = Math.max(bodyMax * 2, elseMax);
    return { max, min: 0 };
  }
  // if/unless/with: pick max over branches.
  // (`if` with no `else`: 2nd branch is implicit empty → 0 roots.)
  const maxes = branchBounds.map((b) => b.max);
  const mins  = branchBounds.map((b) => b.min);
  return {
    max: maxes.length ? Math.max(...maxes) : 0,
    // If the block has no `else`, min is 0 (no roots when the condition is false).
    min: branchBounds.length > 1 ? Math.min(...mins) : 0,
  };
}

/**
 * Public entry point: analyze a template source string.
 *
 * @param {string} src
 * @returns {{ max: number, min: number, ok: boolean, issues: string[] }}
 */
export function analyzeTemplate(src) {
  const stripped = stripComments(src);
  const tokens = tokenize(stripped);
  const { max, min } = rootElementBounds(tokens);
  const issues = [];
  if (max !== 1) {
    issues.push(
      `Template can emit up to ${max} root HTML elements; ApplicationV2 requires exactly 1. ` +
      `Wrap the body in a single root element (e.g. <div class="..."></div>) and move the existing children inside.`,
    );
  }
  if (min === 0 && max >= 1) {
    issues.push(
      `Template can emit zero root elements in some branch — Foundry will throw 'must render a single HTML element' if that branch fires.`,
    );
  }
  return { max, min, ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test('analyzer: single <div> at top level → max=1', () => {
  const r = analyzeTemplate('<div>hello</div>');
  assert.equal(r.max, 1);
  assert.equal(r.min, 1);
  assert.ok(r.ok);
});

test('analyzer: two sibling top-level elements → max=2 (FLAG)', () => {
  const r = analyzeTemplate('<header>x</header><footer>y</footer>');
  assert.equal(r.max, 2);
  assert.equal(r.ok, false);
});

test('analyzer: {{#if}}<a/>{{else}}<b/>{{/if}} → max=1 (single root either branch)', () => {
  const r = analyzeTemplate('{{#if x}}<a>1</a>{{else}}<b>2</b>{{/if}}');
  assert.equal(r.max, 1);
});

test('analyzer: {{#if}}<a/>{{else}}<b/><c/>{{/if}} → max=2 (the exact #26 bug)', () => {
  const r = analyzeTemplate('{{#if x}}<a>1</a>{{else}}<b>2</b><c>3</c>{{/if}}');
  assert.equal(r.max, 2);
  assert.equal(r.ok, false);
});

test('analyzer: comments are stripped before walking', () => {
  const r = analyzeTemplate('{{!-- a comment with <fake-tag/> --}}<div>ok</div>');
  assert.equal(r.max, 1);
  assert.ok(r.ok);
});

test('analyzer: nested {{#each}} inside a wrapper → still single root', () => {
  const r = analyzeTemplate('<ul>{{#each items}}<li>{{x}}</li>{{/each}}</ul>');
  assert.equal(r.max, 1);
  assert.ok(r.ok);
});

test('analyzer: void elements count as roots', () => {
  const r = analyzeTemplate('<br>');
  assert.equal(r.max, 1);
  assert.ok(r.ok);
});

test('analyzer: self-closing tag counts as root', () => {
  const r = analyzeTemplate('<input type="text" />');
  assert.equal(r.max, 1);
});

test('analyzer: top-level {{#each}} flagged as potential multi-root', () => {
  // N iterations of a single-root body → N roots at top level.
  const r = analyzeTemplate('{{#each items}}<li>{{name}}</li>{{/each}}');
  assert.ok(r.max >= 2, `expected max ≥ 2, got ${r.max}`);
  assert.equal(r.ok, false);
});

test('analyzer: top-level {{#if}} with no else → min=0 (zero roots possible)', () => {
  const r = analyzeTemplate('{{#if degraded}}<section>X</section>{{/if}}');
  assert.equal(r.max, 1);
  assert.equal(r.min, 0);
  // ok is false because min=0 is also a Foundry crash path.
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------
// Repo-wide guard: every PARTS-registered template must be single-root.
// ---------------------------------------------------------------------

const partsTemplates = discoverPartsTemplates();

test('repo-wide: at least one PARTS template is registered', () => {
  assert.ok(partsTemplates.length > 0, 'no PARTS templates discovered — check the grep regex');
});

for (const tplPath of partsTemplates) {
  const fullPath = resolve(REPO_ROOT, tplPath);
  test(`PARTS template renders single root: ${tplPath}`, () => {
    if (!existsSync(fullPath)) {
      assert.fail(`PARTS-registered template missing on disk: ${tplPath}`);
    }
    const src = readFileSync(fullPath, 'utf8');
    const r = analyzeTemplate(src);
    if (!r.ok) {
      assert.fail(
        `${tplPath} would crash ApplicationV2._parsePartHTML:\n` +
        `  max roots: ${r.max}, min roots: ${r.min}\n` +
        r.issues.map((i) => `  - ${i}`).join('\n'),
      );
    }
    assert.equal(r.max, 1, `${tplPath}: max=${r.max}, expected 1`);
    assert.equal(r.min, 1, `${tplPath}: min=${r.min}, expected 1 (every branch must emit a root)`);
  });
}

// ---------------------------------------------------------------------
// Regression pin for #26 — sync-calendar specifically. If somebody
// removes the wrapper div in the future, this fails before the analyzer
// would, with a clearer message.
// ---------------------------------------------------------------------

test('regression #26: sync-calendar.hbs has a single root wrapper', () => {
  const src = readFileSync(resolve(TEMPLATES_DIR, 'sync-calendar.hbs'), 'utf8');
  const stripped = stripComments(src).trim();
  // First non-whitespace must be a single opening tag, last must close it.
  const firstTagMatch = /^<\s*([a-zA-Z][\w-]*)/.exec(stripped);
  assert.ok(firstTagMatch, 'sync-calendar.hbs does not start with an HTML element');
  const rootTag = firstTagMatch[1].toLowerCase();
  const lastCloseMatch = new RegExp(`</\\s*${rootTag}\\s*>\\s*$`).exec(stripped);
  assert.ok(
    lastCloseMatch,
    `sync-calendar.hbs first tag is <${rootTag}> but does not close at the end of the file. ` +
    `Wrap the entire body in one root element (e.g. <div class="sync-calendar-root">…</div>).`,
  );
});
