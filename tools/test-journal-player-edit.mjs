#!/usr/bin/env node
/**
 * A player's journal edit is sent by the GM's client, with text and name
 * only, and never for a page that holds GM-only text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournal, installJournals, notes, settings } from './_journal-test-env.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

const page = (content) => ({ id: 'p1', type: 'text', sort: 1, text: { content }, getFlag: () => undefined });

function make({ remote = '<p>old</p>', getFails = false, visibility = 'custom', grants = [{ subject_type: 'user', subject_id: 'm1', permission: 'edit' }] } = {}) {
  settings.userMappings = JSON.stringify({ m1: 'player' });
  globalThis.game.users = { get: (id) => (id === 'player' ? { id, isGM: false } : null), activeGM: { id: 'gm' }, contents: [] };
  const js = new JournalSync();
  const puts = [];
  js._api = {
    get: async (path) => {
      if (path.endsWith('/permissions')) return { visibility, permissions: grants };
      if (getFails) throw new Error('down');
      return { id: 'e1', entry_html: remote, updated_at: '2026-10-03T04:00:10Z' };
    },
    put: async (p, b) => { puts.push(b); return {}; },
    clearRetry: () => {},
    queueForRetry: () => {},
  };
  js._syncManager = { _modules: [], logActivity: () => {}, recordUserOutcome: () => {} };
  js._hidePushedSecrets = async () => {};
  js._recordPush = async () => {};
  js._pushPermissions = async () => { puts.push('permissions'); };
  js._journalPushDebouncer = { schedule() {}, cancel() {}, flush() {}, flushAll() {} };
  notes.warn.length = 0;
  return { js, puts };
}

async function edit(js, journal, change, userId) {
  await js._handleUpdateJournal(journal, change, {}, userId);
  await js._pushJournalUpdate(journal, 'e1');
}

test('a player\'s text edit of a page with no GM-only text is sent', async () => {
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')] });
  installJournals([j]);
  const { js, puts } = make();
  await edit(js, j, {}, 'player');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].entry, '<p>new</p>');
});

test('a player\'s edit never sends sharing', async () => {
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')], ownership: { default: 0 } });
  installJournals([j]);
  const { js, puts } = make();
  await edit(js, j, { ownership: { default: 0 }, name: 'Renamed' }, 'player');
  assert.equal(puts.length, 1);
  assert.equal('is_private' in puts[0], false);
  assert.equal(puts[0].name, j.name);
});

test('the GM\'s own edit still sends sharing', async () => {
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')], ownership: { default: 0 } });
  installJournals([j]);
  const { js, puts } = make();
  await edit(js, j, { ownership: { default: 0 } }, 'gm');
  assert.equal(puts[0].is_private, true);
  assert.equal(puts[1], 'permissions');
});

const SECRET_CASES = [
  ['the journal holds a secret block', { local: '<p>x</p><section class="secret revealed" id="secret-chrkabc"><p>label</p></section>' }],
  ['Chronicle\'s page holds GM-only text the journal no longer shows', { local: '<p>x</p>', remote: null }],
  ['the page cannot be read', { local: '<p>x</p>', getFails: true }],
];
for (const [label, { local, remote, getFails }] of SECRET_CASES) {
  test(`a player's text is not sent when ${label}`, async () => {
    const { toChronicleSecrets } = await import('../scripts/_gm-secrets.mjs');
    const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page(local)] });
    installJournals([j]);
    const gmOnly = toChronicleSecrets('<p>a</p><section class="secret"><p>hidden</p></section>');
    const { js, puts } = make({ remote: remote === null ? gmOnly : undefined, getFails });
    await edit(js, j, { name: 'Renamed' }, 'player');
    assert.equal(puts.length, 1);
    assert.equal('entry' in puts[0], false);
    assert.equal(notes.warn.length, 1);
    assert.match(notes.warn[0], /PlayerEditNotSent/);
  });
}

const REFUSED = [
  ['has no edit grant for the player', [{ subject_type: 'user', subject_id: 'm1', permission: 'view' }, { subject_type: 'user', subject_id: 'm2', permission: 'edit' }]],
  ['has no grants', []],
  ['is not on custom visibility', undefined, 'default'],
];
for (const [label, grants, visibility] of REFUSED) {
  test(`nothing is sent for a player's edit when the Chronicle page ${label}`, async () => {
    const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')] });
    installJournals([j]);
    const { js, puts } = make({ grants, visibility });
    await edit(js, j, { name: 'Renamed' }, 'player');
    assert.equal(puts.length, 0);
    assert.match(notes.warn[0], /PlayerEditNotAllowed/);
  });
}

test('an edit grant for all players lets a matched player\'s edit through; an unmatched player\'s is refused', async () => {
  const j = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')] });
  installJournals([j]);
  const all = [{ subject_type: 'role', subject_id: 1, permission: 'edit' }];
  const a = make({ grants: all });
  await edit(a.js, j, {}, 'player');
  assert.equal(a.puts.length, 1);
  const b = make({ grants: all });
  settings.userMappings = '{}';
  await edit(b.js, j, {}, 'player');
  assert.equal(b.puts.length, 0);
});

test('a player who rewrites a journal\'s Chronicle link gets it unlinked, and nothing is sent', async () => {
  const { touchesLinkFlags, LINK_ID_FLAGS } = await import('../scripts/_set-aside.mjs');
  // The player who owns the journal points it at another page.
  const j = makeJournal({ flags: { entityId: 'someone-elses-page' }, pages: [page('<p>new</p>')] });
  installJournals([j]);
  const { js, puts } = make();
  // Sending the sync-write option from the player's client changes nothing.
  await js._handleUpdateJournal(j, { flags: { 'chronicle-sync': { entityId: 'someone-elses-page' } } }, { chronicleSync: true }, 'player');
  assert.equal(j.flags.entityId, undefined, 'unlinked');
  assert.equal(j.updates.at(-1).options.chronicleSync, true);
  assert.deepEqual(puts, []);
  assert.equal(notes.warn.length, 1);
  // Every form Foundry may hand the hook counts; other flags and the GM's own change do not.
  assert.equal(touchesLinkFlags({ 'flags.chronicle-sync.entityId': 'x' }, 'chronicle-sync', LINK_ID_FLAGS), true);
  assert.equal(touchesLinkFlags({ flags: { 'chronicle-sync': { '-=entityId': null } } }, 'chronicle-sync', LINK_ID_FLAGS), true);
  assert.equal(touchesLinkFlags({ flags: { '-=chronicle-sync': null } }, 'chronicle-sync', LINK_ID_FLAGS), true);
  assert.equal(touchesLinkFlags({ flags: { 'chronicle-sync': { lastSync: 'x' } } }, 'chronicle-sync', LINK_ID_FLAGS), false);
  assert.equal(touchesLinkFlags({ name: 'x' }, 'chronicle-sync', LINK_ID_FLAGS), false);
  const g = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>new</p>')] });
  installJournals([g]);
  await make().js._handleUpdateJournal(g, { flags: { 'chronicle-sync': { entityId: 'e1' } } }, {}, 'gm');
  assert.equal(g.flags.entityId, 'e1', 'the GM\'s own link change stands');
  // A GM running sync that is not the active GM undoes it too: it would pull
  // the other page through the link.
  const users = globalThis.game.users;
  globalThis.game.users = { ...users, activeGM: { id: 'another-gm' } };
  try {
    const k = makeJournal({ flags: { entityId: 'someone-elses-page' }, pages: [page('<p>new</p>')] });
    installJournals([k]);
    await make().js._handleUpdateJournal(k, { flags: { 'chronicle-sync': { entityId: 'someone-elses-page' } } }, {}, 'player');
    assert.equal(k.flags.entityId, undefined, 'unlinked by a GM that is not the active GM');
  } finally {
    globalThis.game.users = users;
  }
});

test('a journal a player creates with a page or note link arrives unlinked, even with the sync option sent', async () => {
  for (const flags of [{ entityId: 'someone-elses-page' }, { noteId: 'someone-elses-note', isNote: true }]) {
    const j = makeJournal({ flags, pages: [page('<p>new</p>')] });
    installJournals([j]);
    const { js, puts } = make();
    await js._handleCreateJournal(j, { chronicleSync: true }, 'player');
    assert.equal(j.flags.entityId, undefined);
    assert.equal(j.flags.noteId, undefined);
    assert.deepEqual(puts, []);
  }
  // The GM's own linked journal (sync's create) keeps its link.
  const g = makeJournal({ flags: { entityId: 'e1' }, pages: [page('<p>x</p>')] });
  installJournals([g]);
  await make().js._handleCreateJournal(g, { chronicleSync: true }, 'gm');
  assert.equal(g.flags.entityId, 'e1');
});

test('with journals not synced, the link guard still undoes a player\'s link change, and stops once the full hooks are on', async () => {
  const hooks = new Map();
  const realHooks = globalThis.Hooks;
  globalThis.Hooks = {
    on: (n, fn) => hooks.set(n, [...(hooks.get(n) || []), fn]),
    off: (n, fn) => hooks.set(n, (hooks.get(n) || []).filter((f) => f !== fn)),
    once: () => {},
  };
  const was = settings.syncJournals;
  settings.syncJournals = false;
  try {
    const { js } = make();
    await js.init(js._api);
    // Switching journals on mid-session would start pulls through this link.
    const j = makeJournal({ flags: { entityId: 'someone-elses-page' }, pages: [page('<p>x</p>')] });
    installJournals([j]);
    const change = { flags: { 'chronicle-sync': { entityId: 'someone-elses-page' } } };
    for (const fn of hooks.get('updateJournalEntry') || []) await fn(j, change, {}, 'player');
    assert.equal(j.flags.entityId, undefined, 'unlinked with journals off');
    assert.equal(notes.warn.length, 1);
    const k = makeJournal({ flags: { entityId: 'another-page' }, pages: [page('<p>x</p>')] });
    installJournals([k]);
    for (const fn of hooks.get('createJournalEntry') || []) await fn(k, {}, 'player');
    assert.equal(k.flags.entityId, undefined, 'a linked create unlinked with journals off');
    js.destroy();
    assert.equal((hooks.get('updateJournalEntry') || []).length, 0, 'destroy removes the guard');
  } finally {
    settings.syncJournals = was;
    globalThis.Hooks = realHooks;
  }
});

// A Chronicle change applied while a player's link change is still being
// undone, or while it lands during the apply's own awaits, writes nothing.
function applyRig(js, { onPull } = {}) {
  js._isExcluded = () => false;
  js._followsVisibility = () => false;
  js._placeJournal = async () => {};
  js._pullHtml = async (_id, html) => { await onPull?.(); return html; };
  js._journalPushDebouncer.has = () => false;
  js._olderThanRecorded = () => false;
}
const SECRET_PAGE = { id: 'B', name: 'Secret', entry_html: '<p>secret text</p>', updated_at: '2026-10-03T05:00:00Z' };

test('a Chronicle change does not reach a journal whose player-set link is still being undone', async () => {
  const j = makeJournal({ flags: { entityId: 'B' }, pages: [page('<p>mine</p>')] });
  installJournals([j]);
  const { js } = make();
  applyRig(js);
  const realUpdate = j.update;
  let land;
  j.update = (data, options) => new Promise((resolve) => { land = () => resolve(realUpdate(data, options)); });
  const unlink = js._guardUpdate(j, { flags: { 'chronicle-sync': { entityId: 'B' } } }, 'player');
  assert.ok(unlink, 'the guard undoes the change');
  await js._applyEntityUpdated(SECRET_PAGE);
  assert.equal(j.name, 'Journal');
  assert.equal(j.pages[0].text.content, '<p>mine</p>');
  j.update = realUpdate;
  land();
  await unlink;
  assert.equal(j.flags.entityId, undefined);
  assert.equal(js._holdsLink(j, 'B'), false);
});

test('a player\'s link change landing during an apply\'s awaits stops the apply\'s later writes', async () => {
  const j = makeJournal({ flags: { entityId: 'A' }, pages: [page('<p>A text</p>')] });
  installJournals([j]);
  const { js } = make();
  let unlink;
  applyRig(js, {
    onPull: () => {
      // The player re-points the journal while this client fetches the text.
      j.flags.entityId = 'B';
      unlink = js._guardUpdate(j, { flags: { 'chronicle-sync': { entityId: 'B' } } }, 'player');
    },
  });
  await js._applyEntityUpdated({ id: 'A', name: 'Journal', entry_html: '<p>A text, edited</p>', updated_at: '2026-10-03T05:00:00Z' });
  await unlink;
  assert.equal(j.pages[0].text.content, '<p>A text</p>', 'no page written after the link changed');
  assert.equal(j.flags.entityId, undefined);
});
