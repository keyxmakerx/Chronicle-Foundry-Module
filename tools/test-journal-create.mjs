#!/usr/bin/env node
/**
 * Journal made in Foundry -> Chronicle page: the create payload is pinned to
 * Chronicle's create request keys, the text goes in a follow-up PUT, and
 * journals owned by MapSync / NoteSync / CalendarSync are never pushed.
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
  assert.deepEqual(calls, [], 'no request of any kind');
});

test('Chronicle Notes journals are skipped', async () => {
  const { js, calls } = harness();
  js._syncManager._modules = [{ constructor: { name: 'NoteSync' }, _isNoteJournal: () => true }];
  await js._handleCreateJournal(makeJournal(), {}, 'gm');
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
