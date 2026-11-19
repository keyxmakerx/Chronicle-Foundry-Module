#!/usr/bin/env node
/**
 * Journal made in Foundry -> Chronicle page: the create payload is pinned to
 * Chronicle's create request keys, the text goes in a follow-up PUT, and
 * journals owned by MapSync / CalendarSync, or set aside in the old
 * Chronicle Notes folder, are never pushed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, notes, makeJournal, installJournals } from './_journal-test-env.mjs';
import { ENTITY_CREATE_KEYS, buildEntityCreateBody, pickJournalCreateType } from '../scripts/_journal-create.mjs';

const { JournalSync } = await import('../scripts/journal-sync.mjs');

const TYPES = [
  { id: 7, name: 'Character', preset_category: 'character', enabled: true },
  { id: 8, name: 'Location', enabled: true },
  { id: 9, name: 'Item', enabled: true },
];

test('create body only uses keys Chronicle’s create request accepts', () => {
  const body = buildEntityCreateBody({ name: 'N', entityTypeId: 8, isPrivate: true });
  assert.deepEqual(body, { name: 'N', entity_type_id: 8, is_private: true });
  for (const k of Object.keys(body)) assert.ok(ENTITY_CREATE_KEYS.includes(k), k);
  assert.ok(!('entry' in body) && !('entry_html' in body), 'the create request has no text field');
});

test('pickJournalCreateType: configured id, else first non-character type, tolerant of envelopes', () => {
  assert.equal(pickJournalCreateType(TYPES, 9), 9);
  assert.equal(pickJournalCreateType({ data: TYPES }, 0), 8);
  assert.equal(pickJournalCreateType(TYPES, 999), 8, 'a deleted configured type falls back');
  assert.equal(pickJournalCreateType([{ id: 7, preset_category: 'character' }], 0), 7);
  assert.equal(pickJournalCreateType([], 0), null);
  assert.equal(pickJournalCreateType(null, 0), null);
});

function harness({ types = TYPES } = {}) {
  const js = new JournalSync();
  const calls = [];
  js._api = {
    get: async (path) => { calls.push(['GET', path]); return { data: types }; },
    post: async (path, body) => { calls.push(['POST', path, body]); return { id: 'ent-1', updated_at: 'U1' }; },
    put: async (path, body) => { calls.push(['PUT', path, body]); return { updated_at: 'U2' }; },
  };
  js._syncManager = { ensureMapping: async (m) => { calls.push(['MAP', m.chronicle_id]); }, _modules: [] };
  js._pushPermissions = async () => {};
  return { js, calls };
}

const textPage = (html) => ({ type: 'text', text: { content: html }, getFlag: () => undefined });

test('a Foundry journal POSTs a real entity_type_id, then PUTs its text as `entry`', async () => {
  settings.journalCreateTypeId = 0;
  const { js, calls } = harness();
  const journal = makeJournal({ pages: [textPage('<p>hello</p>')] });
  await js._handleCreateJournal(journal, {}, 'gm');
  const post = calls.find((c) => c[0] === 'POST');
  assert.equal(post[1], '/entities');
  assert.equal(post[2].entity_type_id, 8);
  const put = calls.find((c) => c[0] === 'PUT');
  assert.equal(put[1], '/entities/ent-1');
  assert.match(put[2].entry, /hello/);
  assert.equal(journal.flags.entityId, 'ent-1');
  assert.equal(journal.flags.chronicleUpdatedAt, 'U2');
  assert.ok(journal.updates.every((u) => u.options?.chronicleSync), 'sync writes carry the marker');
});

test('the dashboard’s chosen type wins', async () => {
  settings.journalCreateTypeId = 9;
  const { js, calls } = harness();
  await js._handleCreateJournal(makeJournal({ pages: [textPage('x')] }), {}, 'gm');
  assert.equal(calls.find((c) => c[0] === 'POST')[2].entity_type_id, 9);
  settings.journalCreateTypeId = 0;
});

test('no page types: nothing is posted and the GM is told', async () => {
  notes.warn.length = 0;
  const { js, calls } = harness({ types: [] });
  await js._handleCreateJournal(makeJournal(), {}, 'gm');
  assert.equal(calls.some((c) => c[0] === 'POST'), false);
  assert.equal(notes.warn.length, 0, 'no toast: only the dashboard activity log records it');
});

test('map journals (page flag or Maps folder), sync-made and already-linked journals are skipped', async () => {
  const { js, calls } = harness();
  const mapPage = { type: 'image', getFlag: (_s, k) => (k === 'mapId' ? 'm1' : undefined) };
  await js._handleCreateJournal(makeJournal({ pages: [mapPage] }), {}, 'gm');
  await js._handleCreateJournal(makeJournal({ folder: { getFlag: (_s, k) => k === 'isMapsFolder', folder: null } }), {}, 'gm');
  await js._handleCreateJournal(makeJournal(), { chronicleSync: true }, 'gm');
  await js._handleCreateJournal(makeJournal({ flags: { entityId: 'x' } }), {}, 'gm');
  await js._handleCreateJournal(makeJournal(), {}, 'someone-else');
  // A copy of a journal the GM turned sync off for.
  await js._handleCreateJournal(makeJournal({ flags: { keepLocal: true } }), {}, 'gm');
  assert.deepEqual(calls, [], 'no request of any kind');
});

test('journals in the old Chronicle Notes folder are skipped', async () => {
  const { js, calls } = harness();
  const notesRoot = { getFlag: (_s, k) => k === 'isNotesRoot', folder: null };
  await js._handleCreateJournal(makeJournal({ folder: { getFlag: () => undefined, folder: notesRoot } }), {}, 'gm');
  await js._handleCreateJournal(makeJournal({ flags: { oldNote: true } }), {}, 'gm');
  assert.deepEqual(calls, []);
});

test('the entity.created broadcast that beats our POST response does not make a second journal', async () => {
  const { js } = harness();
  installJournals([]);
  let release;
  js._api.post = () => new Promise((r) => { release = () => r({ id: 'ent-1', updated_at: 'U1' }); });
  const journal = makeJournal({ name: 'Mine', pages: [textPage('x')] });
  const pending = js._handleCreateJournal(journal, {}, 'gm');
  await new Promise((r) => setImmediate(r));
  let created = 0;
  js._createJournalLocked = async () => { created++; };
  await js._onEntityCreated({ id: 'ent-1', name: 'Mine' });
  assert.equal(created, 0);
  release();
  await pending;
});

test('the Chronicle Sync window sends a journal by the same path, and hears why it failed', async () => {
  const { js, calls } = harness();
  const journal = makeJournal({ pages: [textPage('<p>hello</p>')] });
  assert.deepEqual(await js._sendJournalAsPage(journal), { entityId: 'ent-1' });
  assert.deepEqual(calls.filter((c) => c[0] !== 'GET').map((c) => c[0]), ['POST', 'PUT', 'MAP']);
  assert.equal(journal.getFlag('chronicle-sync', 'entityId'), 'ent-1');
  assert.equal(js._inFlightCreates.size, 0);

  // No page types: nothing is made, and the caller is told so.
  const none = harness({ types: [] });
  assert.equal(await none.js._sendJournalAsPage(makeJournal()), null);
  assert.equal(none.calls.some((c) => c[0] === 'POST'), false);

  // Chronicle refuses: the error reaches the caller and the marker is cleared.
  const bad = harness();
  bad.js._api.post = async () => { throw new Error('Chronicle answered 500'); };
  await assert.rejects(bad.js._sendJournalAsPage(makeJournal()), /answered 500/);
  assert.equal(bad.js._inFlightCreates.size, 0);

  // A journal already on its way up is not sent a second time.
  const twice = harness();
  const going = makeJournal({ id: 'j-going' });
  twice.js._inFlightCreates.set('j-going', going.name);
  await assert.rejects(twice.js._sendJournalAsPage(going), /already being sent/);
  assert.deepEqual(twice.calls, []);

  // A journal that is linked, or another area's, is never made a page.
  const guard = harness();
  await assert.rejects(guard.js._sendJournalAsPage(makeJournal({ flags: { entityId: 'x' } })));
  await assert.rejects(guard.js._sendJournalAsPage(makeJournal({ flags: { oldNote: true } })));
  assert.deepEqual(guard.calls, []);
});

test('linking a journal to a page of the same name keeps one text and never makes a second journal', async () => {
  const entity = { id: 'ent-9', name: 'Brass Lantern', type_name: 'Location', type_slug: 'location', updated_at: 'U5' };

  // Chronicle's text is kept: the page is applied to the journal now linked to it.
  let { js, calls } = harness();
  let journal = makeJournal({ name: 'Brass Lantern' });
  installJournals([journal]);
  const applied = [];
  js._applyEntityUpdated = async (e) => { applied.push(e.id); };
  js._pushJournalUpdate = async () => { calls.push(['PUSH']); };
  await js._linkJournalToPage(journal, entity, 'chronicle');
  assert.equal(journal.getFlag('chronicle-sync', 'entityId'), 'ent-9');
  assert.equal(journal.getFlag('chronicle-sync', 'chronicleUpdatedAt'), '', 'no version held, so the page is not taken for a stale copy');
  assert.deepEqual(applied, ['ent-9']);
  assert.deepEqual(calls.map((c) => c[0]), ['MAP']);

  // Foundry's text is kept: it goes up against the version just read.
  ({ js, calls } = harness());
  journal = makeJournal({ name: 'Brass Lantern' });
  installJournals([journal]);
  js._applyEntityUpdated = async () => { calls.push(['APPLY']); };
  js._pushJournalUpdate = async (j, id) => { calls.push(['PUSH', id, j.getFlag('chronicle-sync', 'chronicleUpdatedAt')]); };
  await js._linkJournalToPage(journal, entity, 'foundry');
  assert.deepEqual(calls, [['MAP', 'ent-9'], ['PUSH', 'ent-9', 'U5']]);

  // The page got a journal meanwhile: nothing is linked.
  ({ js, calls } = harness());
  const other = makeJournal({ flags: { entityId: 'ent-9' } });
  journal = makeJournal({ name: 'Brass Lantern' });
  installJournals([other, journal]);
  await assert.rejects(js._linkJournalToPage(journal, entity, 'chronicle'), /already has a journal/);
  assert.equal(journal.getFlag('chronicle-sync', 'entityId'), undefined);
  installJournals([]);
});

test('a journal deleted here and kept in Chronicle gets sync turned off, so the page list does not bring it back', async () => {
  const { js } = harness();
  const logged = [];
  js._syncManager.logActivity = (kind, text) => logged.push([kind, text]);
  settings.syncExclusions = '{"excludedTypes":[3],"excludedEntities":["a"]}';
  await js._syncOffAfterDelete('ent-1', 'Old Mill');
  assert.deepEqual(JSON.parse(settings.syncExclusions), { excludedTypes: [3], excludedEntities: ['a', 'ent-1'] });
  assert.match(logged[0][1], /"Old Mill" was deleted here and kept in Chronicle/);
  await js._syncOffAfterDelete('ent-1', 'Old Mill');
  assert.equal(JSON.parse(settings.syncExclusions).excludedEntities.length, 2, 'not added twice');
  settings.syncExclusions = '{"excludedTypes":[],"excludedEntities":[]}';
});
