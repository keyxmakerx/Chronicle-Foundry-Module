#!/usr/bin/env node
/**
 * Tests for the visibility → Foundry ownership mapping (FM-SYNC-HARDENING).
 *
 * Covers:
 *   §1 — the shared `_ownership` helper honors the operator's `dmOnlyHidden`
 *        + `defaultOwnership` dashboard settings, and JournalSync._buildOwnership
 *        / NoteSync._buildNoteOwnership consume it (previously the settings were
 *        dead config — registered + dashboard-written but never read).
 *   §3 — JournalSync._buildOwnership fails CLOSED (NONE) when the custom-
 *        visibility permissions API errors. Security-relevant: a transient
 *        error must NEVER widen a GM-restricted entity to player-visible.
 *   §4 — per-user Chronicle grants map to specific Foundry users via the
 *        user-mapping table; unmapped users are dropped (under-share, no leak).
 *
 * Plus static-source regression pins so a future refactor can't silently
 * reintroduce the fail-open behavior or unwire the settings.
 *
 * Run: `node --test tools/test-build-ownership.mjs`
 *
 * No mocking framework — Node's built-in `node:test` + a configurable
 * `game.settings.get` stub.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --- Foundry global stubs (must exist before importing the modules) ---

globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
const L = globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS;

// Configurable settings store — tests mutate `settings` then call the code.
const settings = { dmOnlyHidden: true, defaultOwnership: L.OBSERVER };

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
  },
};
globalThis.game = globalThis.game || {
  settings: {
    get: (_mod, key) => settings[key],
    set: () => {},
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.ui = globalThis.ui || { notifications: { warn: () => {}, error: () => {}, info: () => {} } };

const { JournalSync } = await import('../scripts/journal-sync.mjs');
const { NoteSync } = await import('../scripts/note-sync.mjs');
const { defaultLevelForVisibility, configuredDefaultOwnership } =
  await import('../scripts/_ownership.mjs');

/** Reset settings to the registered defaults before each behavioral test. */
function resetSettings() {
  settings.dmOnlyHidden = true;
  settings.defaultOwnership = L.OBSERVER;
}

// ---------------------------------------------------------------------
// §1 — shared helper honors the settings
// ---------------------------------------------------------------------

test('helper: default behavior (dmOnlyHidden on, defaultOwnership OBSERVER)', () => {
  resetSettings();
  // Private/DM-only → hidden; public → observer. Matches the pre-wire hardcode.
  assert.equal(defaultLevelForVisibility(true), L.NONE);
  assert.equal(defaultLevelForVisibility(false), L.OBSERVER);
});

test('helper: dmOnlyHidden OFF surfaces DM-only content at the default level', () => {
  resetSettings();
  settings.dmOnlyHidden = false;
  assert.equal(defaultLevelForVisibility(true), L.OBSERVER);
  assert.equal(defaultLevelForVisibility(false), L.OBSERVER);
});

test('helper: defaultOwnership=OWNER raises the player-visible level', () => {
  resetSettings();
  settings.defaultOwnership = L.OWNER;
  assert.equal(defaultLevelForVisibility(false), L.OWNER);
  // dmOnlyHidden still hides private content regardless of default level.
  assert.equal(defaultLevelForVisibility(true), L.NONE);
});

test('helper: defaultOwnership=NONE (explicit) is honored for public docs', () => {
  resetSettings();
  settings.defaultOwnership = L.NONE;
  assert.equal(defaultLevelForVisibility(false), L.NONE);
});

test('helper: configuredDefaultOwnership clamps garbage to OBSERVER', () => {
  resetSettings();
  for (const bad of [undefined, null, NaN, -1, 4, 99, 'x', 1.5]) {
    settings.defaultOwnership = bad;
    assert.equal(configuredDefaultOwnership(), L.OBSERVER, `bad=${String(bad)}`);
  }
  // Valid values pass through (including the explicit NONE).
  for (const ok of [0, 1, 2, 3]) {
    settings.defaultOwnership = ok;
    assert.equal(configuredDefaultOwnership(), ok);
  }
});

// ---------------------------------------------------------------------
// §1 — JournalSync._buildOwnership (default visibility) reads the settings
// ---------------------------------------------------------------------

/** Build a JournalSync with an injected api + syncManager. */
function makeJournalSync({ apiGet, getFoundryUserId } = {}) {
  const js = new JournalSync();
  js._api = { get: apiGet || (async () => null) };
  js._syncManager = { getFoundryUserId: getFoundryUserId || (() => null) };
  return js;
}

test('_buildOwnership: default visibility + private → NONE (dmOnlyHidden on)', async () => {
  resetSettings();
  const js = makeJournalSync();
  assert.deepEqual(await js._buildOwnership({ is_private: true }), { default: L.NONE });
  assert.deepEqual(await js._buildOwnership({ visibility: 'default', is_private: true }), { default: L.NONE });
});

test('_buildOwnership: default visibility + public → defaultOwnership', async () => {
  resetSettings();
  const js = makeJournalSync();
  assert.deepEqual(await js._buildOwnership({ is_private: false }), { default: L.OBSERVER });
  settings.defaultOwnership = L.OWNER;
  assert.deepEqual(await js._buildOwnership({ is_private: false }), { default: L.OWNER });
});

test('_buildOwnership: dmOnlyHidden OFF surfaces private entity at default level', async () => {
  resetSettings();
  settings.dmOnlyHidden = false;
  const js = makeJournalSync();
  assert.deepEqual(await js._buildOwnership({ is_private: true }), { default: L.OBSERVER });
});

// ---------------------------------------------------------------------
// Custom visibility — role grants
// ---------------------------------------------------------------------

test('_buildOwnership: custom + player "view" grant → OBSERVER default', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'role', subject_id: '1', permission: 'view' }] }),
  });
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.OBSERVER });
});

test('_buildOwnership: custom + player "edit" grant → OWNER default', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'role', subject_id: '1', permission: 'edit' }] }),
  });
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.OWNER });
});

test('_buildOwnership: custom + no player grant → default stays NONE', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'role', subject_id: '2', permission: 'view' }] }),
  });
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.NONE });
});

// ---------------------------------------------------------------------
// §3 — fail CLOSED on the custom-visibility error / empty paths
// ---------------------------------------------------------------------

test('§3 _buildOwnership: custom + permissions API THROWS → NONE (fail closed)', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => { throw new Error('500 boom'); },
  });
  // The crux: even an is_private=false entity must NOT fall open to OBSERVER.
  assert.deepEqual(
    await js._buildOwnership({ id: 'e1', visibility: 'custom', is_private: false }),
    { default: L.NONE },
  );
  assert.deepEqual(
    await js._buildOwnership({ id: 'e1', visibility: 'custom', is_private: true }),
    { default: L.NONE },
  );
});

test('§3 _buildOwnership: custom + empty permissions payload → NONE (fail closed)', async () => {
  resetSettings();
  const jsNull = makeJournalSync({ apiGet: async () => null });
  assert.deepEqual(await jsNull._buildOwnership({ id: 'e1', visibility: 'custom', is_private: false }), { default: L.NONE });
  const jsNoField = makeJournalSync({ apiGet: async () => ({}) });
  assert.deepEqual(await jsNoField._buildOwnership({ id: 'e1', visibility: 'custom', is_private: false }), { default: L.NONE });
});

// ---------------------------------------------------------------------
// §4 — per-user grants map to Foundry users; unmapped users dropped
// ---------------------------------------------------------------------

test('§4 _buildOwnership: known per-user grant maps to the Foundry user', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'user', subject_id: 'chronicle-u1', permission: 'edit' }] }),
    getFoundryUserId: (cid) => (cid === 'chronicle-u1' ? 'foundry-u9' : null),
  });
  const ownership = await js._buildOwnership({ id: 'e1', visibility: 'custom' });
  assert.equal(ownership.default, L.NONE, 'default stays GM-only');
  assert.equal(ownership['foundry-u9'], L.OWNER, 'per-user grant applied');
});

test('§4 _buildOwnership: unmapped per-user grant is dropped (no leak, under-share)', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'user', subject_id: 'stranger', permission: 'view' }] }),
    getFoundryUserId: () => null, // no mapping known
  });
  const ownership = await js._buildOwnership({ id: 'e1', visibility: 'custom' });
  // No per-user key added; default unchanged. The doc under-shares rather
  // than leaking to the wrong player.
  assert.deepEqual(ownership, { default: L.NONE });
});

test('§4 _buildOwnership: mixed role + user grants combine', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [
      { subject_type: 'role', subject_id: '1', permission: 'view' },
      { subject_type: 'user', subject_id: 'cu', permission: 'edit' },
    ] }),
    getFoundryUserId: (cid) => (cid === 'cu' ? 'fu' : null),
  });
  const ownership = await js._buildOwnership({ id: 'e1', visibility: 'custom' });
  assert.equal(ownership.default, L.OBSERVER);
  assert.equal(ownership['fu'], L.OWNER);
});

// ---------------------------------------------------------------------
// Audit §5 — consume `public` subject + `tag_grants`
// ---------------------------------------------------------------------

test('§5 _buildOwnership: custom + public "view" grant → OBSERVER default', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'public', subject_id: 'public', permission: 'view' }] }),
  });
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.OBSERVER });
});

test('§5 _buildOwnership: custom + public "edit" grant → OWNER default', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'public', subject_id: 'public', permission: 'edit' }] }),
  });
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.OWNER });
});

test('§5 _buildOwnership: public never LOWERS an existing higher role grant', async () => {
  resetSettings();
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [
      { subject_type: 'role', subject_id: '1', permission: 'edit' }, // OWNER
      { subject_type: 'public', subject_id: 'public', permission: 'view' }, // OBSERVER
    ] }),
  });
  // Fail-closed-toward-intent: the broader of the two wins, never a downgrade.
  assert.deepEqual(await js._buildOwnership({ id: 'e1', visibility: 'custom' }), { default: L.OWNER });
});

test('§5 _buildOwnership: tag_grants present → activity warning, default unchanged', async () => {
  resetSettings();
  const logged = [];
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [], tag_grants: [{ tag_id: 't1', permission: 'view' }] }),
  });
  js._syncManager.logActivity = (type, msg) => logged.push({ type, msg });
  const ownership = await js._buildOwnership({ id: 'e1', name: 'Secret', visibility: 'custom' });
  // Fail-closed: tag grants can't be expanded to Foundry users, so the default
  // stays NONE — but the operator is warned the tag-scoped access isn't honored.
  assert.deepEqual(ownership, { default: L.NONE });
  assert.ok(logged.some((l) => l.type === 'warning' && /tag-based/.test(l.msg)));
});

// ---------------------------------------------------------------------
// Audit §3 — surface dropped grants + fail-closed errors
// ---------------------------------------------------------------------

test('§3 _buildOwnership: dropped per-user grant logs a warning', async () => {
  resetSettings();
  const logged = [];
  const js = makeJournalSync({
    apiGet: async () => ({ permissions: [{ subject_type: 'user', subject_id: 'stranger', permission: 'view' }] }),
    getFoundryUserId: () => null,
  });
  js._syncManager.logActivity = (type, msg) => logged.push({ type, msg });
  const ownership = await js._buildOwnership({ id: 'e1', name: 'Plot', visibility: 'custom' });
  assert.deepEqual(ownership, { default: L.NONE }, 'still under-shares (no leak)');
  assert.ok(logged.some((l) => l.type === 'warning' && /per-user grant/.test(l.msg)), 'dropped grant warned');
});

test('§3 _buildOwnership: permissions API error logs a warning (still fails closed)', async () => {
  resetSettings();
  const logged = [];
  const js = makeJournalSync({ apiGet: async () => { throw new Error('boom'); } });
  js._syncManager.logActivity = (type, msg) => logged.push({ type, msg });
  const ownership = await js._buildOwnership({ id: 'e1', name: 'X', visibility: 'custom', is_private: false });
  assert.deepEqual(ownership, { default: L.NONE });
  assert.ok(logged.some((l) => l.type === 'warning' && /GM-only/.test(l.msg)));
});

// ---------------------------------------------------------------------
// Audit §1A — DM-only-hidden counting
// ---------------------------------------------------------------------

test('§1A _buildOwnership: private+default+dmOnlyHidden increments the hidden counter', async () => {
  resetSettings();
  let count = 0;
  const js = makeJournalSync();
  js._syncManager.noteDmOnlyHidden = () => { count++; };
  await js._buildOwnership({ is_private: true });
  await js._buildOwnership({ visibility: 'default', is_private: true });
  assert.equal(count, 2, 'each hidden private entity counted');
  // Public entity does NOT count.
  await js._buildOwnership({ is_private: false });
  assert.equal(count, 2);
});

test('§1A _buildOwnership: dmOnlyHidden OFF does NOT count (entity is visible)', async () => {
  resetSettings();
  settings.dmOnlyHidden = false;
  let count = 0;
  const js = makeJournalSync();
  js._syncManager.noteDmOnlyHidden = () => { count++; };
  await js._buildOwnership({ is_private: true });
  assert.equal(count, 0, 'not hidden → not counted');
});

// ---------------------------------------------------------------------
// §1 — NoteSync._buildNoteOwnership consumes the same helper
// ---------------------------------------------------------------------

test('_buildNoteOwnership: shared note → defaultOwnership; unshared → NONE', () => {
  resetSettings();
  const ns = new NoteSync();
  assert.deepEqual(ns._buildNoteOwnership({ is_shared: true }), { default: L.OBSERVER });
  assert.deepEqual(ns._buildNoteOwnership({ is_shared: false }), { default: L.NONE });
});

test('_buildNoteOwnership: dmOnlyHidden OFF surfaces unshared note at default level', () => {
  resetSettings();
  settings.dmOnlyHidden = false;
  const ns = new NoteSync();
  assert.deepEqual(ns._buildNoteOwnership({ is_shared: false }), { default: L.OBSERVER });
});

// ---------------------------------------------------------------------
// Static-source regression pins
// ---------------------------------------------------------------------

test('pin: journal-sync custom-visibility catch fails closed (no is_private fallback)', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  const m = src.match(/async _buildOwnership\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(m, '_buildOwnership body could not be located');
  const body = m[1];
  // The catch block must NOT reintroduce the fail-open ternary that returned
  // OBSERVER for non-private entities on a permissions error.
  assert.ok(
    !/catch[\s\S]*?entity\.is_private\s*\?/.test(body),
    'custom-visibility catch must not branch on is_private — that is the FM-SYNC-HARDENING §3 fail-open regression',
  );
  // And it must reference the shared helper for the default-visibility path.
  assert.ok(
    /defaultLevelForVisibility\(/.test(body),
    '_buildOwnership must use defaultLevelForVisibility (FM-SYNC-HARDENING §1)',
  );
});

test('pin: note-sync _buildNoteOwnership uses the shared helper', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/note-sync.mjs'), 'utf8');
  const m = src.match(/_buildNoteOwnership\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(m, '_buildNoteOwnership body could not be located');
  assert.ok(
    /defaultLevelForVisibility\(/.test(m[1]),
    '_buildNoteOwnership must use defaultLevelForVisibility (FM-SYNC-HARDENING §1)',
  );
});

test('pin: defaultOwnership setting default is OBSERVER (2), not the dead 0', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/settings.mjs'), 'utf8');
  const m = src.match(/'defaultOwnership',\s*\{([\s\S]*?)\}\);/);
  assert.ok(m, 'defaultOwnership registration could not be located');
  assert.ok(/default:\s*2\b/.test(m[1]),
    'defaultOwnership default must be OBSERVER (2) so wiring the setting is non-breaking');
});
