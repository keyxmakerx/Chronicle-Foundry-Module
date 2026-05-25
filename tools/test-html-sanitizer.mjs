#!/usr/bin/env node
/**
 * Regression pin for FM-SEC-CHUNK-3 (M-3 journal HTML pre-sanitization,
 * defense-in-depth on top of Chronicle's server-side sanitization).
 *
 * Two-layer test:
 *
 *   1. Behavioral tests for `_sanitizeIncomingHTML` — the wrapper around
 *      Foundry's `TextEditor.cleanHTML` that journal-sync.mjs and
 *      note-sync.mjs call before storing Chronicle-supplied HTML in
 *      Foundry JournalEntry pages.
 *
 *   2. Static-source integration: pin that both consumer files import
 *      the helper AND that every known ingestion site references it.
 *      A future refactor that adds a new ingestion path without wiring
 *      the sanitizer trips the static-source pin.
 *
 * Per FM-SECURITY-AUDIT §2 M-3, §4 Chunk 3, §0.5 D1=(c).
 * Cross-reference C-SECURITY-AUDIT §1.3 (Chronicle already sanitizes
 * EntryHTML on write via bluemonday UGCPolicy at 8 plugins).
 *
 * Run: `node --test tools/test-html-sanitizer.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------
// Stub TextEditor + game.settings on globalThis. The helper probes the
// v13 namespace (`foundry.applications.ux.TextEditor`) first, then the
// v12 global (`globalThis.TextEditor`). Tests install / uninstall these
// per-case via the helpers below.
// ---------------------------------------------------------------------

function installV13CleanHTML(impl) {
  globalThis.foundry = { applications: { ux: { TextEditor: { cleanHTML: impl } } } };
}
function installV12CleanHTML(impl) {
  globalThis.TextEditor = { cleanHTML: impl };
}
function clearCleanHTML() {
  delete globalThis.foundry;
  delete globalThis.TextEditor;
}
function setSkipSetting(value) {
  globalThis.game = { settings: { get: () => value } };
}
function clearSkipSetting() {
  delete globalThis.game;
}

const { _sanitizeIncomingHTML } = await import('../scripts/_html-sanitizer.mjs');

// ---------------------------------------------------------------------
// Happy path — delegates to TextEditor.cleanHTML
// ---------------------------------------------------------------------

test('_sanitizeIncomingHTML: delegates to v13 TextEditor.cleanHTML', () => {
  clearCleanHTML();
  installV13CleanHTML((s) => s.replace(/<script[\s\S]*?<\/script>/gi, ''));
  const out = _sanitizeIncomingHTML('<p>safe</p><script>alert(1)</script>');
  assert.equal(out, '<p>safe</p>');
});

test('_sanitizeIncomingHTML: falls back to v12 global TextEditor.cleanHTML', () => {
  clearCleanHTML();
  installV12CleanHTML((s) => s.replace(/onerror="[^"]*"/gi, ''));
  const out = _sanitizeIncomingHTML('<img src=x onerror="bad()">');
  assert.equal(out, '<img src=x >');
});

test('_sanitizeIncomingHTML: prefers v13 over v12 when both present', () => {
  clearCleanHTML();
  installV13CleanHTML(() => 'v13');
  installV12CleanHTML(() => 'v12');
  assert.equal(_sanitizeIncomingHTML('input'), 'v13');
});

// ---------------------------------------------------------------------
// Operator-config escape
// ---------------------------------------------------------------------

test('_sanitizeIncomingHTML: skipIncomingSanitization=true bypasses cleanHTML', () => {
  clearCleanHTML();
  installV13CleanHTML(() => 'WAS_SANITIZED');
  setSkipSetting(true);
  const raw = '<p>raw</p><script>evil</script>';
  assert.equal(_sanitizeIncomingHTML(raw), raw, 'should return input unchanged');
  clearSkipSetting();
});

test('_sanitizeIncomingHTML: skipIncomingSanitization=false runs cleanHTML', () => {
  clearCleanHTML();
  installV13CleanHTML(() => 'SANITIZED');
  setSkipSetting(false);
  assert.equal(_sanitizeIncomingHTML('anything'), 'SANITIZED');
  clearSkipSetting();
});

// ---------------------------------------------------------------------
// Fail-open behavior — cleanHTML missing / throwing
// ---------------------------------------------------------------------

test('_sanitizeIncomingHTML: cleanHTML missing → returns raw + warn (fail-open)', () => {
  clearCleanHTML();
  clearSkipSetting();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const out = _sanitizeIncomingHTML('<p>raw</p>');
    assert.equal(out, '<p>raw</p>');
    assert.ok(
      warnings.some((w) => w.includes('TextEditor.cleanHTML not found')),
      'should warn when sanitizer unavailable',
    );
  } finally {
    console.warn = origWarn;
  }
});

test('_sanitizeIncomingHTML: cleanHTML throws → returns raw + warn (fail-open)', () => {
  clearCleanHTML();
  installV13CleanHTML(() => { throw new Error('boom'); });
  clearSkipSetting();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const out = _sanitizeIncomingHTML('<p>raw</p>');
    assert.equal(out, '<p>raw</p>');
    assert.ok(
      warnings.some((w) => w.includes('cleanHTML threw')),
      'should warn when sanitizer throws',
    );
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------
// Non-string input — coerce empty
// ---------------------------------------------------------------------

test('_sanitizeIncomingHTML: null input → empty string', () => {
  clearCleanHTML();
  installV13CleanHTML((s) => s);
  assert.equal(_sanitizeIncomingHTML(null), '');
});

test('_sanitizeIncomingHTML: undefined input → empty string', () => {
  clearCleanHTML();
  installV13CleanHTML((s) => s);
  assert.equal(_sanitizeIncomingHTML(undefined), '');
});

test('_sanitizeIncomingHTML: empty string → empty string (no cleanHTML call)', () => {
  clearCleanHTML();
  let called = false;
  installV13CleanHTML(() => { called = true; return ''; });
  assert.equal(_sanitizeIncomingHTML(''), '');
  assert.equal(called, false, 'should short-circuit before invoking cleanHTML');
});

test('_sanitizeIncomingHTML: non-string number input → empty string', () => {
  clearCleanHTML();
  installV13CleanHTML((s) => s);
  assert.equal(_sanitizeIncomingHTML(42), '');
});

// ---------------------------------------------------------------------
// Realistic malicious-input shapes (verifies the wrapper delegates;
// the actual sanitization rules live in Foundry's cleanHTML which is
// not exercised here — Foundry's renderer is exercised at runtime).
// ---------------------------------------------------------------------

test('_sanitizeIncomingHTML: <script> tag delegated to cleanHTML', () => {
  clearCleanHTML();
  let received = null;
  installV13CleanHTML((s) => { received = s; return s.replace(/<script[\s\S]*?<\/script>/gi, ''); });
  _sanitizeIncomingHTML('<p>ok</p><script>alert(1)</script>');
  assert.equal(received, '<p>ok</p><script>alert(1)</script>', 'cleanHTML must see the raw input');
});

test('_sanitizeIncomingHTML: javascript: URL delegated to cleanHTML', () => {
  clearCleanHTML();
  let received = null;
  installV13CleanHTML((s) => { received = s; return s; });
  _sanitizeIncomingHTML('<a href="javascript:alert(1)">x</a>');
  assert.equal(received, '<a href="javascript:alert(1)">x</a>');
});

test('_sanitizeIncomingHTML: <iframe> delegated to cleanHTML', () => {
  clearCleanHTML();
  let received = null;
  installV13CleanHTML((s) => { received = s; return s; });
  _sanitizeIncomingHTML('<iframe src="https://attacker.example/"></iframe>');
  assert.equal(received, '<iframe src="https://attacker.example/"></iframe>');
});

// ---------------------------------------------------------------------
// Static-source integration — pin every ingestion site
// ---------------------------------------------------------------------

test('scripts/journal-sync.mjs imports from ./_html-sanitizer.mjs', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][/]_html-sanitizer\.mjs['"]/.test(source),
    'journal-sync.mjs must import from ./_html-sanitizer.mjs',
  );
});

test('scripts/note-sync.mjs imports from ./_html-sanitizer.mjs', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/note-sync.mjs'), 'utf8');
  assert.ok(
    /from\s+['"][.][/]_html-sanitizer\.mjs['"]/.test(source),
    'note-sync.mjs must import from ./_html-sanitizer.mjs',
  );
});

test('scripts/journal-sync.mjs: every entity.entry_html / player_notes_html ingestion goes through _sanitizeIncomingHTML', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');

  // Every raw `entity.entry_html` reference outside the helper must be
  // immediately wrapped by `_sanitizeIncomingHTML(...)`. We check by
  // scanning each occurrence in context.
  const lines = source.split('\n');
  const ingressLines = lines
    .map((line, i) => ({ line, num: i + 1 }))
    .filter(({ line }) =>
      /entity\.(entry_html|player_notes_html)\b/.test(line) ||
      /\bnote\.entry_html\b/.test(line),
    );

  for (const { line, num } of ingressLines) {
    // Allow lines that are JSDoc / comments / property-assignment targets
    // (e.g., the schema reference in a comment). The check is: if the
    // line uses entity.entry_html or entity.player_notes_html as a VALUE
    // that flows to a Foundry document field, it must pass through the
    // sanitizer.
    const isComment = /^\s*\*|^\s*\/\//.test(line);
    const isPropertyKeyContext = /\bentry_html\s*:|\bplayer_notes_html\s*:/.test(line);
    const isTruthinessCheck = /\bif\s*\(\s*entity\.(entry_html|player_notes_html)\s*\)/.test(line);

    if (isComment || isPropertyKeyContext || isTruthinessCheck) continue;

    assert.ok(
      /_sanitizeIncomingHTML\(/.test(line),
      `journal-sync.mjs:${num}: \`${line.trim()}\` references Chronicle HTML but is not wrapped by _sanitizeIncomingHTML — likely a new ingestion site that bypasses the sanitizer`,
    );
  }
});

test('scripts/note-sync.mjs: every note.entry_html read into a Foundry text page goes through _sanitizeIncomingHTML', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/note-sync.mjs'), 'utf8');
  const lines = source.split('\n');
  const ingressLines = lines
    .map((line, i) => ({ line, num: i + 1 }))
    .filter(({ line }) =>
      /\bnote\.entry_html\b/.test(line),
    );

  for (const { line, num } of ingressLines) {
    const isComment = /^\s*\*|^\s*\/\//.test(line);
    // Lines that ASSIGN to entry_html (outbound payload to Chronicle)
    // are not ingestion sites — those are payload-build lines.
    const isOutboundPayload = /entry_html\s*:/.test(line);
    if (isComment || isOutboundPayload) continue;

    assert.ok(
      /_sanitizeIncomingHTML\(/.test(line),
      `note-sync.mjs:${num}: \`${line.trim()}\` reads note.entry_html for storage but is not wrapped by _sanitizeIncomingHTML`,
    );
  }
});

test('scripts/settings.mjs: skipIncomingSanitization setting is registered', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts/settings.mjs'), 'utf8');
  assert.ok(
    /game\.settings\.register\([^)]*['"]skipIncomingSanitization['"]/.test(source),
    'settings.mjs must register skipIncomingSanitization so the operator-config escape works at runtime',
  );
  // Confirm the default keeps sanitization ON.
  const block = source.match(/skipIncomingSanitization[\s\S]*?\}\);/);
  assert.ok(block, 'expected to find skipIncomingSanitization settings block');
  assert.ok(
    /default:\s*false/.test(block[0]),
    'default must be false (sanitization ON) — flipping the default would silently disable defense-in-depth across all worlds',
  );
});

test('lang/en.json: SkipIncomingSanitization Name + Hint defined', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'lang/en.json'), 'utf8');
  const lang = JSON.parse(source);
  const node = lang?.CHRONICLE?.Settings?.SkipIncomingSanitization;
  assert.ok(node, 'lang/en.json must define CHRONICLE.Settings.SkipIncomingSanitization');
  assert.equal(typeof node.Name, 'string', 'Name must be a string');
  assert.equal(typeof node.Hint, 'string', 'Hint must be a string');
  assert.ok(node.Name.length > 0 && node.Hint.length > 0, 'Name and Hint must be non-empty');
});
