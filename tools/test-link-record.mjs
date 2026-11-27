#!/usr/bin/env node
/**
 * The GM-only link record (scripts/_link-record.mjs, scripts/link-record.mjs):
 * only a GM's own writes are recorded, the record holds hashes and nothing a
 * player could read a journal or page from, and on the GM's connect a link
 * neither the record nor a Chronicle mapping confirms is undone, with a
 * warning. The first connect with the record in place takes the links as
 * they are.
 *
 * Run: node --test tools/test-link-record.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkOf, linkHash, readRecord, recordValue, unconfirmedLinks,
} from '../scripts/_link-record.mjs';

const SCOPE = 'chronicle-sync';

function doc(id, flags = {}, name = id) {
  return { id, uuid: `X.${id}`, name, flags: { ...flags }, getFlag(scope, k) { return scope === SCOPE ? this.flags[k] : undefined; } };
}

test('a link is the link flags a document carries, and only those', () => {
  assert.deepEqual(linkOf(doc('j', { entityId: 'e1', noteId: 'n1', lastSync: 'x' }), SCOPE, 'journals'), { entityId: 'e1', noteId: 'n1' });
  assert.deepEqual(linkOf(doc('a', { entityId: 'e1', noteId: 'n1' }), SCOPE, 'actors'), { entityId: 'e1' });
  assert.equal(linkOf(doc('j', { lastSync: 'x' }), SCOPE, 'journals'), null);
  assert.equal(linkOf(doc('j', { entityId: '' }), SCOPE, 'journals'), null);
});

test('a hash names one document\'s one link, and says nothing readable', async () => {
  const h = await linkHash('journals', 'j1', { entityId: 'e1' });
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await linkHash('journals', 'j1', { entityId: 'e1' }));
  assert.notEqual(h, await linkHash('journals', 'j2', { entityId: 'e1' }));
  assert.notEqual(h, await linkHash('journals', 'j1', { entityId: 'e2' }));
  assert.notEqual(h, await linkHash('actors', 'j1', { entityId: 'e1' }));
  assert.notEqual(h, await linkHash('journals', 'j1', { entityId: 'e1', noteId: 'n1' }));
  assert.ok(!h.includes('e1') && !h.includes('j1'));
});

test('the record reads only well-formed hashes; no record is null', () => {
  const good = 'a'.repeat(64);
  assert.equal(readRecord(null), null);
  assert.equal(readRecord({ v: 1 }), null);
  assert.deepEqual([...readRecord({ v: 1, links: [good, 'nope', 5] })], [good]);
  assert.deepEqual(recordValue(['b'.repeat(64), good, good]), { v: 1, links: [good, 'b'.repeat(64)] });
});

test('a link is confirmed by the record, or a page link by a Chronicle mapping; else it is not', async () => {
  const mk = async (kind, id, link) => ({ kind, id, link, hash: await linkHash(kind, id, link) });
  const recordedOne = await mk('journals', 'j1', { entityId: 'e1' });
  const mappedOne = await mk('journals', 'j2', { entityId: 'e2' });
  const note = await mk('journals', 'j3', { entityId: 'e3', noteId: 'n3' });
  const forged = await mk('actors', 'a1', { entityId: 'someone-else' });
  const out = unconfirmedLinks(
    [recordedOne, mappedOne, note, forged, { kind: 'journals', id: 'j4', link: null }],
    new Set([recordedOne.hash]),
    new Set(['j2:e2', 'j3:e3', 'a1:the-real-one']),
  );
  assert.deepEqual(out.map((d) => d.id), ['j3', 'a1']);
  // With no mappings readable, only the record confirms.
  assert.deepEqual(unconfirmedLinks([recordedOne, mappedOne], new Set([recordedOne.hash]), null).map((d) => d.id), ['j2']);
});

// --- The Foundry side -------------------------------------------------------

function world({ journals = [], actors = [], record = null, me = 'gm', isGM = true, activeGM = 'gm' } = {}) {
  const hooks = new Map();
  const settings = new Map([['chronicle-sync.linkRecord', record]]);
  const warns = [];
  globalThis.Hooks = {
    on(name, fn) { hooks.set(name, [...(hooks.get(name) || []), fn]); },
    off(name, fn) { hooks.set(name, (hooks.get(name) || []).filter((f) => f !== fn)); },
    call(name, ...args) { for (const fn of hooks.get(name) || []) fn(...args); },
  };
  globalThis.game = {
    user: { id: me, isGM },
    users: { activeGM: activeGM ? { id: activeGM } : null },
    settings: {
      get: (m, k) => settings.get(`${m}.${k}`),
      set: async (m, k, v) => { settings.set(`${m}.${k}`, v); return v; },
    },
    journal: { contents: journals },
    actors: { contents: actors },
    i18n: { format: (key, data) => `${key} ${JSON.stringify(data)}` },
  };
  globalThis.ui = { notifications: { warn: (msg) => warns.push(msg) } };
  return { hooks, settings, warns, record: () => settings.get('chronicle-sync.linkRecord') };
}

const { default: LinkRecord } = await import('../scripts/link-record.mjs');

function unlinker() {
  const undone = [];
  const fn = async (kind, d) => {
    undone.push(`${kind}:${d.id}`);
    for (const k of ['entityId', 'noteId', 'isNote']) delete d.flags[k];
  };
  return { undone, fn };
}

const noMappings = { get: async () => ({ data: [], total: 0 }) };

test('the first connect takes the links as they are, and undoes nothing', async () => {
  const j = doc('journal-one', { entityId: 'page-one' });
  const a = doc('actor-zed', { entityId: 'page-nine' });
  const w = world({ journals: [j], actors: [a] });
  const { undone, fn } = unlinker();
  const lr = new LinkRecord();
  assert.deepEqual(await lr.checkOnConnect(noMappings, fn), []);
  assert.deepEqual(undone, []);
  const saved = readRecord(w.record());
  assert.equal(saved.size, 2);
  assert.ok(saved.has(await linkHash('journals', 'journal-one', { entityId: 'page-one' })));
  // Nothing in the saved value names a journal, an actor or a page.
  assert.doesNotMatch(JSON.stringify(w.record()), /journal|actor|page|one|zed|nine/);
});

test('a link a player made while no GM was online is undone on connect; the GM\'s stand', async () => {
  const gmMade = doc('j1', { entityId: 'e1' });
  const mine = doc('a1', { entityId: 'my-character' }, 'Hero <b>x</b>');
  const w = world({ journals: [gmMade], actors: [mine] });
  await new LinkRecord().checkOnConnect(noMappings, async () => {});
  // The GM leaves; the player who owns the actor points it at another page.
  mine.flags.entityId = 'someone-elses-character';
  const { undone, fn } = unlinker();
  const out = await new LinkRecord().checkOnConnect(noMappings, fn);
  assert.deepEqual(out.map((d) => d.id), ['a1']);
  assert.deepEqual(undone, ['actors:a1']);
  assert.equal(gmMade.flags.entityId, 'e1');
  assert.equal(w.warns.length, 1);
  assert.match(w.warns[0], /LinksUndoneOnConnect/);
  assert.match(w.warns[0], /&lt;b&gt;/, 'the name is escaped');
  // The record now holds only the links that stand, so a second connect undoes nothing.
  const again = unlinker();
  assert.deepEqual(await new LinkRecord().checkOnConnect(noMappings, again.fn), []);
  assert.equal(readRecord(w.record()).size, 1);
});

test('a link only a Chronicle mapping confirms stands, and joins the record', async () => {
  const j = doc('j1', { entityId: 'e1' });
  const w = world({ journals: [j], record: recordValue([]) });
  const pages = [
    { data: [{ external_system: 'foundry', chronicle_type: 'entity', external_id: 'jx', chronicle_id: 'ex' }], total: 2 },
    { data: [{ external_system: 'foundry', chronicle_type: 'entity', external_id: 'j1', chronicle_id: 'e1' }], total: 2 },
  ];
  const asked = [];
  const api = { get: async (path) => { asked.push(path); return pages[asked.length - 1]; } };
  const { undone, fn } = unlinker();
  assert.deepEqual(await new LinkRecord().checkOnConnect(api, fn), []);
  assert.deepEqual(undone, []);
  // Walked by total, though each page held fewer rows than asked.
  assert.deepEqual(asked, ['/sync/mappings?limit=1000&offset=0', '/sync/mappings?limit=1000&offset=1']);
  assert.ok(readRecord(w.record()).has(await linkHash('journals', 'j1', { entityId: 'e1' })));
});

test('a GM\'s own link writes are recorded; a player\'s never are', async () => {
  const w = world({ record: recordValue([]) });
  const lr = new LinkRecord();
  lr.start();
  const made = doc('j1', { entityId: 'e1' });
  Hooks.call('createJournalEntry', made, {}, 'gm');
  const forged = doc('j2', { entityId: 'e2' });
  Hooks.call('createJournalEntry', forged, {}, 'player');
  // The GM relinks an actor: the old link leaves the record, the new one joins.
  const a = doc('a1', { entityId: 'old' });
  Hooks.call('createActor', a, {}, 'gm');
  Hooks.call('preUpdateActor', a, { flags: { [SCOPE]: { entityId: 'new' } } }, {}, 'gm');
  a.flags.entityId = 'new';
  Hooks.call('updateActor', a, { flags: { [SCOPE]: { entityId: 'new' } } }, {}, 'gm');
  // Without the preUpdate hook the new link still joins.
  const b = doc('a2', { entityId: 'b-new' });
  Hooks.call('updateActor', b, { 'flags.chronicle-sync.entityId': 'b-new' }, {}, 'gm');
  await lr.save();
  const saved = readRecord(w.record());
  assert.ok(saved.has(await linkHash('journals', 'j1', { entityId: 'e1' })));
  assert.ok(!saved.has(await linkHash('journals', 'j2', { entityId: 'e2' })));
  assert.ok(!saved.has(await linkHash('actors', 'a1', { entityId: 'old' })));
  assert.ok(saved.has(await linkHash('actors', 'a1', { entityId: 'new' })));
  assert.ok(saved.has(await linkHash('actors', 'a2', { entityId: 'b-new' })));
  // A delete drops it.
  Hooks.call('deleteJournalEntry', made, {}, 'gm');
  await lr.save();
  assert.ok(!readRecord(w.record()).has(await linkHash('journals', 'j1', { entityId: 'e1' })));
  lr.stop();
  assert.equal([...w.hooks.values()].flat().length, 0, 'stop removes every hook');
});

test('links noted before the first connect wait for it rather than start a partial record', async () => {
  const j = doc('j1', { entityId: 'e1' });
  const old = doc('j0', { entityId: 'e0' });
  const w = world({ journals: [old, j] });
  const lr = new LinkRecord();
  lr.start();
  Hooks.call('createJournalEntry', j, {}, 'gm');
  await lr.save();
  assert.equal(w.record(), null, 'no partial record that would leave older links unconfirmed');
  const { undone, fn } = unlinker();
  await lr.checkOnConnect(noMappings, fn);
  assert.deepEqual(undone, []);
  assert.equal(readRecord(w.record()).size, 2);
  lr.stop();
});

test('only the active GM checks, and a player\'s client never does', async () => {
  const forged = doc('a1', { entityId: 'x' });
  for (const opts of [{ me: 'gm2', activeGM: 'gm' }, { me: 'p', isGM: false }]) {
    const w = world({ actors: [forged], record: recordValue([]), ...opts });
    const { undone, fn } = unlinker();
    assert.deepEqual(await new LinkRecord().checkOnConnect(noMappings, fn), []);
    assert.deepEqual(undone, []);
    assert.deepEqual(w.record(), recordValue([]));
  }
});

test('the check runs before each connect\'s catch-up, and the setting is world-scoped and hidden', async () => {
  const { readFileSync } = await import('node:fs');
  const sm = readFileSync(new URL('../scripts/sync-manager.mjs', import.meta.url), 'utf8');
  assert.match(sm, /async _runInitialSync\(\) \{\n    await this\._checkLinks\(\);/);
  const settings = readFileSync(new URL('../scripts/settings.mjs', import.meta.url), 'utf8');
  assert.match(settings, /register\(MODULE_ID, 'linkRecord', \{\n    scope: 'world',\n    config: false,/);
});
