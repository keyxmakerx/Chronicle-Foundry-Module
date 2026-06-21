#!/usr/bin/env node
/**
 * Tests for per-player permission sync (audit 2026-06-21-permission-sync-audit).
 *
 * Covers the operator must-haves:
 *   §2 (push) — JournalSync._buildPermissionGrants reverse-maps Foundry per-user
 *               ownership to Chronicle `subject_type:'user'` grants; fails CLOSED
 *               (drops + reports) for users it can't reverse-map; only flips
 *               `visibility:'custom'` when real user grants exist.
 *   §2/§3.1 — SyncManager.memberKey resolves the member id key; the unmatched-
 *               member warning lists every member that didn't auto-match (the
 *               operator's required signal).
 *   §2 (UI)  — buildMemberRows view-model: matched/UNMATCHED badge, dropdown
 *               options, stale-mapping → UNMATCHED.
 *
 * Pure-function tested — no Foundry runtime. Node's built-in `node:test`.
 *
 * Run: `node --test tools/test-permission-sync.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Foundry global stubs (must exist before importing the modules) ---

globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
const L = globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS;

const settings = { userMappings: '{}' };
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: {
    get: (_mod, key) => settings[key],
    set: (_mod, key, val) => { settings[key] = val; },
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: { get: () => null, find: () => null, contents: [] },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.ui = globalThis.ui || { notifications: { warn: () => {}, error: () => {}, info: () => {} } };

const { JournalSync } = await import('../scripts/journal-sync.mjs');
const { memberKey } = await import('../scripts/sync-manager.mjs');
const { buildMemberRows } = await import('../scripts/_member-mapping.mjs');

// =====================================================================
// §2 — _buildPermissionGrants (Foundry → Chronicle per-user push)
// =====================================================================

/** A JournalSync whose syncManager reverse-maps via the given table. */
function makeJS(reverse = {}) {
  const js = new JournalSync();
  js._syncManager = { getChronicleUserId: (fid) => reverse[fid] ?? null };
  return js;
}

test('push: public entity emits the broad Player-role view grant', () => {
  const js = makeJS();
  const { permissions, hasUserGrants } = js._buildPermissionGrants({ default: L.OBSERVER }, false, () => null);
  assert.deepEqual(permissions, [{ subject_type: 'role', subject_id: '1', permission: 'view' }]);
  assert.equal(hasUserGrants, false);
});

test('push: private entity emits NO role grant', () => {
  const js = makeJS();
  const { permissions } = js._buildPermissionGrants({ default: L.NONE }, true, () => null);
  assert.deepEqual(permissions, []);
});

test('push: per-user OWNER → user "edit" grant; OBSERVER → "view"', () => {
  const js = makeJS();
  const reverse = (fid) => ({ 'fu-owner': 'cu-1', 'fu-obs': 'cu-2' }[fid] ?? null);
  const ownership = { default: L.NONE, 'fu-owner': L.OWNER, 'fu-obs': L.OBSERVER };
  const { permissions, unmapped, hasUserGrants } = js._buildPermissionGrants(ownership, true, reverse);
  assert.equal(hasUserGrants, true);
  assert.deepEqual(unmapped, []);
  assert.ok(permissions.some((p) => p.subject_type === 'user' && p.subject_id === 'cu-1' && p.permission === 'edit'));
  assert.ok(permissions.some((p) => p.subject_type === 'user' && p.subject_id === 'cu-2' && p.permission === 'view'));
});

test('push: a Foundry user we cannot reverse-map is DROPPED + reported (fail closed)', () => {
  const js = makeJS();
  const reverse = (fid) => (fid === 'known' ? 'cu-known' : null);
  const ownership = { default: L.NONE, known: L.OWNER, stranger: L.OWNER };
  const { permissions, unmapped, hasUserGrants } = js._buildPermissionGrants(ownership, true, reverse);
  // The unknown user is NOT pushed — never over-share.
  assert.ok(!permissions.some((p) => p.subject_id === undefined || p.subject_id === null));
  assert.equal(permissions.filter((p) => p.subject_type === 'user').length, 1);
  assert.deepEqual(unmapped, ['stranger']);
  assert.equal(hasUserGrants, true);
});

test('push: NONE-level per-user entries are ignored (no access → no grant)', () => {
  const js = makeJS();
  const ownership = { default: L.NONE, fu: L.NONE };
  const { permissions, unmapped, hasUserGrants } = js._buildPermissionGrants(ownership, true, () => 'cu');
  assert.deepEqual(permissions, []);
  assert.deepEqual(unmapped, []);
  assert.equal(hasUserGrants, false);
});

test('push: visibility stays "default" when there are no real user grants', () => {
  // hasUserGrants=false even though there's a role grant → the caller sends
  // visibility:'default', not 'custom'. Verified via the flag the caller reads.
  const js = makeJS();
  const { hasUserGrants } = js._buildPermissionGrants({ default: L.OBSERVER }, false, () => null);
  assert.equal(hasUserGrants, false);
});

test('push: _buildPermissionGrants uses the injected reverse-map (real getChronicleUserId path)', () => {
  const js = makeJS({ 'fu-1': 'cu-9' });
  // Drive through the production default arg by calling with the manager's fn.
  const reverse = (fid) => js._syncManager.getChronicleUserId(fid);
  const { permissions } = js._buildPermissionGrants({ default: L.NONE, 'fu-1': L.OWNER }, true, reverse);
  assert.ok(permissions.some((p) => p.subject_type === 'user' && p.subject_id === 'cu-9'));
});

// =====================================================================
// §2/§3.1 — memberKey + unmatched-member reporting
// =====================================================================

test('memberKey: prefers user_id, falls back to id, null when absent', () => {
  assert.equal(memberKey({ user_id: 'a', id: 'b' }), 'a');
  assert.equal(memberKey({ id: 'b' }), 'b');
  assert.equal(memberKey({ user_id: 42 }), '42');
  assert.equal(memberKey({}), null);
  assert.equal(memberKey(null), null);
  assert.equal(memberKey({ user_id: '' }), null);
});

test('§3.1 _reportUnmatchedMembers: warns + logs listing each unmatched member', async () => {
  const { SyncManager } = await import('../scripts/sync-manager.mjs');
  const sm = new SyncManager();
  const logged = [];
  const notes = [];
  sm.logActivity = (type, msg) => logged.push({ type, msg });
  globalThis.ui.notifications.warn = (m) => notes.push(m);

  sm._reportUnmatchedMembers([
    { display_name: 'Alice', user_id: 'a' },
    { display_name: 'Bob', user_id: 'b' },
  ]);

  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, 'warning');
  assert.ok(/Alice/.test(logged[0].msg) && /Bob/.test(logged[0].msg), 'both names listed');
  assert.ok(/Members tab/.test(logged[0].msg), 'points operator at the fix');
  assert.equal(notes.length, 1);
  assert.ok(/Alice/.test(notes[0]) && /Bob/.test(notes[0]));
});

test('§3.1 _reportUnmatchedMembers: no-op when everything matched', async () => {
  const { SyncManager } = await import('../scripts/sync-manager.mjs');
  const sm = new SyncManager();
  let calls = 0;
  sm.logActivity = () => { calls++; };
  sm._reportUnmatchedMembers([]);
  sm._reportUnmatchedMembers(null);
  assert.equal(calls, 0);
});

test('§1A DM-only counter: noteDmOnlyHidden increments; getter reflects it', async () => {
  const { SyncManager } = await import('../scripts/sync-manager.mjs');
  const sm = new SyncManager();
  assert.equal(sm.getDmOnlyHiddenCount(), 0);
  sm.noteDmOnlyHidden();
  sm.noteDmOnlyHidden();
  assert.equal(sm.getDmOnlyHiddenCount(), 2);
});

// =====================================================================
// §2 (UI) — buildMemberRows view-model
// =====================================================================

const fUsers = [
  { id: 'fu-1', name: 'Alice' },
  { id: 'fu-2', name: 'Bob' },
];

test('rows: mapped member → matched badge + selected option', () => {
  const { rows, matchedCount, unmatchedCount } = buildMemberRows({
    members: [{ user_id: 'cu-1', display_name: 'Alice', role: 'player' }],
    mappings: { 'cu-1': 'fu-1' },
    foundryUsers: fUsers,
    keyOf: memberKey,
  });
  assert.equal(matchedCount, 1);
  assert.equal(unmatchedCount, 0);
  assert.equal(rows[0].matched, true);
  assert.equal(rows[0].foundryUserName, 'Alice');
  const selected = rows[0].options.find((o) => o.selected);
  assert.equal(selected.id, 'fu-1');
});

test('rows: unmapped member → UNMATCHED + "Unmapped" option selected', () => {
  const { rows, unmatchedCount } = buildMemberRows({
    members: [{ user_id: 'cu-2', display_name: 'Bob' }],
    mappings: {},
    foundryUsers: fUsers,
    keyOf: memberKey,
  });
  assert.equal(unmatchedCount, 1);
  assert.equal(rows[0].matched, false);
  assert.equal(rows[0].foundryUserId, null);
  assert.equal(rows[0].options[0].selected, true, 'the empty/unmapped option is selected');
  assert.equal(rows[0].options[0].id, '');
});

test('rows: STALE mapping (points at a deleted user) surfaces as UNMATCHED', () => {
  const { rows, unmatchedCount } = buildMemberRows({
    members: [{ user_id: 'cu-3', display_name: 'Carol' }],
    mappings: { 'cu-3': 'fu-deleted' }, // not in foundryUsers
    foundryUsers: fUsers,
    keyOf: memberKey,
  });
  assert.equal(unmatchedCount, 1);
  assert.equal(rows[0].matched, false, 'a dead link must not be trusted as matched');
});

test('rows: members without a resolvable key are skipped', () => {
  const { rows } = buildMemberRows({
    members: [{ display_name: 'Ghost' }, { user_id: 'cu-1', display_name: 'Alice' }],
    mappings: {},
    foundryUsers: fUsers,
    keyOf: memberKey,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Alice');
});

test('rows: every row offers all Foundry users plus the unmap option', () => {
  const { rows } = buildMemberRows({
    members: [{ user_id: 'cu-1', display_name: 'Alice' }],
    mappings: {},
    foundryUsers: fUsers,
    keyOf: memberKey,
  });
  // 2 users + 1 "unmapped" sentinel.
  assert.equal(rows[0].options.length, 3);
  assert.ok(rows[0].options.some((o) => o.id === 'fu-1'));
  assert.ok(rows[0].options.some((o) => o.id === 'fu-2'));
});
