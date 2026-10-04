#!/usr/bin/env node
/**
 * Pins what a release's source zip carries. Chronicle installs the module
 * from GitHub's source archive and refuses it if any file has an extension
 * on its package scan's blocklist, so .gitattributes keeps dev-only folders
 * out and this checks the archive git would build from the tracked tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors dangerousExtensions in Chronicle's internal/plugins/packages/validation.go.
const BLOCKED = new Set([
  '.exe', '.bat', '.cmd', '.com', '.sh', '.bash', '.zsh', '.fish',
  '.dll', '.so', '.dylib', '.msi', '.deb', '.rpm',
  '.ps1', '.psm1', '.psd1', '.jar', '.class', '.py', '.rb', '.pl',
]);

// --worktree-attributes reads the checked-out .gitattributes, so the test
// sees an uncommitted change to it too.
const files = execFileSync(
  'sh',
  ['-c', 'git archive --worktree-attributes --format=tar HEAD | tar -t'],
  { cwd: ROOT, encoding: 'utf8' },
).split('\n').filter((f) => f && !f.endsWith('/'));

test('archive has no file Chronicle would refuse', () => {
  const bad = files.filter((f) => BLOCKED.has(extname(f).toLowerCase()));
  assert.deepEqual(bad, []);
});

test('archive leaves out dev-only folders', () => {
  const dev = files.filter((f) => /^(bench|tools|\.github)\//.test(f));
  assert.deepEqual(dev, []);
});

test('archive keeps what Foundry and Chronicle load', () => {
  for (const f of ['module.json', 'chronicle-package.json', 'scripts/module.mjs', 'lang/en.json']) {
    assert.ok(files.includes(f), `${f} missing from the release archive`);
  }
});
