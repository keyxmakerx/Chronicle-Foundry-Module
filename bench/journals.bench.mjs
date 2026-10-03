#!/usr/bin/env node
/**
 * Journal sync, both sides real: the module's code in a fake Foundry world
 * against a running Chronicle. Every scenario ends with the same checks:
 * no duplicate pages or journals, no failed requests, no hook errors, no
 * error pop-ups. Run with bench/run.sh (or CHRONICLE_URL pointing at a
 * Chronicle you started yourself).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHRONICLE_URL } from './chronicle.mjs';
import { openWorld, closeWorld, settle, recordRequests, waitFor } from './world.mjs';
import { FLAG, linked, byEntity, writes, pageText, chroniclePage, scenario } from './scenario.mjs';

test('a journal made in Foundry becomes exactly one page, with its text', () => scenario('fvtt-create', async ({ seed, world }) => {
  await openWorld(world);
  const j = await JournalEntry.create({ name: 'The Gilded Eel', pages: [{ name: 'The Gilded Eel', type: 'text', text: { content: '<p>A tavern by the docks.</p>' } }] });
  await settle();
  const entities = await seed.chronicle.allEntities();
  assert.equal(entities.length, 1);
  assert.equal(j.getFlag(FLAG, 'entityId'), entities[0].id);
  const full = await seed.chronicle.get(`/entities/${entities[0].id}`);
  assert.match(full.entry_html || '', /A tavern by the docks/);
}));

test('a page made in Chronicle while Foundry is open becomes one journal, with no push back', () => scenario('chr-create-live', async ({ seed, world }) => {
  await openWorld(world);
  const reqs = await recordRequests(async () => {
    await chroniclePage(seed, 'Harbor Master');
    await waitFor(() => linked(world).length === 1, 15000, 'journal to appear');
    await settle();
  });
  const j = linked(world)[0];
  assert.equal(j.name, 'Harbor Master');
  assert.match(pageText(j), /Harbor Master text/);
  assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'module wrote nothing back to Chronicle');
}));

test('renaming a journal in Foundry renames the page once, with no echo loop', () => scenario('fvtt-rename', async ({ seed, world }) => {
  await openWorld(world);
  const j = await JournalEntry.create({ name: 'Old Name', pages: [{ name: 'Old Name', type: 'text', text: { content: '<p>x</p>' } }] });
  await settle();
  const reqs = await recordRequests(async () => {
    await j.update({ name: 'New Name' });
    await settle();
  });
  const id = j.getFlag(FLAG, 'entityId');
  assert.equal((await seed.chronicle.get(`/entities/${id}`)).name, 'New Name');
  const puts = writes(reqs).filter((r) => r.url === `/entities/${id}`);
  assert.equal(puts.length, 1, `one PUT, got ${puts.length}`);
}));

test('a Chronicle edit reaches the open journal and is not pushed back', () => scenario('chr-edit-live', async ({ seed, world }) => {
  const e = await chroniclePage(seed, 'Lighthouse');
  await openWorld(world);
  await JournalSync_resync(world);
  const j = byEntity(world, e.id);
  assert.ok(j, 'journal exists');
  const reqs = await recordRequests(async () => {
    await seed.chronicle.put(`/entities/${e.id}`, { name: 'Lighthouse (ruined)', entry: '<p>Burned down.</p>' });
    await waitFor(() => j.name === 'Lighthouse (ruined)', 15000, 'rename to arrive');
    await settle();
  });
  assert.match(pageText(j), /Burned down/);
  assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'no echo');
}));

test('changes made while Foundry was closed arrive once on open, and a second open changes nothing', () => scenario('offline', async ({ seed, world }) => {
  const kept = await chroniclePage(seed, 'Kept Page');
  const edited = await chroniclePage(seed, 'Edited Page');
  const removed = await chroniclePage(seed, 'Removed Page');
  await openWorld(world);
  await JournalSync_resync(world);
  assert.equal(linked(world).length, 3);
  await closeWorld(world);

  const added = await chroniclePage(seed, 'Added While Away');
  await seed.chronicle.put(`/entities/${edited.id}`, { entry: '<p>Edited while away.</p>' });
  await seed.chronicle.del(`/entities/${removed.id}`);

  await openWorld(world);
  assert.ok(byEntity(world, added.id), 'new page arrived');
  assert.match(pageText(byEntity(world, edited.id)), /Edited while away/);
  assert.ok(byEntity(world, kept.id), 'untouched page kept');
  const setAside = world.game.journal.find((j) => j.name === 'Removed Page');
  assert.ok(setAside && !setAside.getFlag(FLAG, 'entityId'), 'removed page set aside, not deleted');
  assert.equal(world.game.journal.filter((j) => j.name === 'Added While Away').length, 1);
  await closeWorld(world);

  const before = world.log.writes.length;
  const reqs = await recordRequests(async () => {
    await openWorld(world);
  });
  assert.deepEqual(world.log.writes.slice(before).map((w) => `${w.op} ${w.type} ${JSON.stringify(w.change || {})}`), [], 'second open wrote nothing in Foundry');
  assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'second open wrote nothing in Chronicle');
}));

test('a reopen reads only what changed (change feed), and its own pushes do not come back', () => scenario('feed-catchup', async ({ seed, world }) => {
  const pages = [];
  for (const n of ['North', 'South', 'East', 'West']) pages.push(await chroniclePage(seed, `${n} Gate`));
  const [north, south, east, west] = pages;
  await openWorld(world);
  await JournalSync_resync(world);
  // A Foundry edit pushed before closing: Chronicle's feed records it, and
  // the next open must recognise it as the module's own.
  await byEntity(world, west.id).update({ name: 'West Gate (ruined)' });
  await settle();
  await closeWorld(world);

  await seed.chronicle.put(`/entities/${north.id}`, { name: 'North Gate (rebuilt)' });
  await seed.chronicle.del(`/entities/${south.id}`);
  const added = await chroniclePage(seed, 'Harbour Gate');

  const before = world.log.writes.length;
  const reqs = await recordRequests(async () => { await openWorld(world); });
  const gets = reqs.filter((r) => r.method === 'GET').map((r) => r.url);
  assert.ok(gets.some((u) => u.startsWith('/sync/changes')), 'read the change feed');
  assert.deepEqual(gets.filter((u) => u.startsWith('/entities?')), [], 'did not walk every page');
  assert.ok(!gets.includes(`/entities/${east.id}`), 'did not refetch an untouched page');
  assert.equal(byEntity(world, north.id)?.name, 'North Gate (rebuilt)');
  assert.ok(byEntity(world, added.id), 'new page arrived');
  const ruined = world.game.journal.find((j) => j.name === 'South Gate');
  assert.ok(ruined && !ruined.getFlag(FLAG, 'entityId'), 'removed page set aside, not deleted');
  assert.equal(byEntity(world, west.id)?.name, 'West Gate (ruined)');
  const westId = byEntity(world, west.id).id;
  const westWrites = world.log.writes.slice(before).filter((w) => w.id === westId || w.parent === westId);
  assert.deepEqual(westWrites.map((w) => `${w.op} ${w.type} ${JSON.stringify(w.change)}`), [], 'own push not re-applied');
  assert.deepEqual(writes(reqs).filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'reopen wrote nothing in Chronicle');
  await closeWorld(world);

  // Nothing changed since: a third open reads the feed and fetches no page.
  const again = await recordRequests(async () => { await openWorld(world); });
  assert.deepEqual(again.filter((r) => r.url.startsWith('/entities')).map((r) => `${r.method} ${r.url}`), [], 'third open touched no page');
}));

test('a journal deleted in Foundry (page kept in Chronicle) does not come back on reopen', () => scenario('fvtt-delete-keep', async ({ seed, world }) => {
  const e = await chroniclePage(seed, 'Forgotten Shrine');
  await openWorld(world);
  await JournalSync_resync(world);
  world.answerConfirm = false; // "Also delete it in Chronicle?" → No.
  await byEntity(world, e.id).delete();
  await settle();
  await closeWorld(world);
  await openWorld(world);
  assert.equal(world.game.journal.filter((j) => j.name === 'Forgotten Shrine').length, 0);
  assert.ok(await seed.chronicle.get(`/entities/${e.id}`), 'Chronicle page kept');
}));

test('a burst of edits ends with the last one on both sides and no duplicate', () => scenario('burst', async ({ seed, world }) => {
  await openWorld(world);
  const j = await JournalEntry.create({ name: 'Draft 0', pages: [{ name: 'Body', type: 'text', text: { content: '<p>0</p>' } }] });
  for (let i = 1; i <= 8; i++) await j.update({ name: `Draft ${i}` });
  await settle();
  const entities = await seed.chronicle.allEntities();
  assert.equal(entities.length, 1);
  assert.equal(entities[0].name, 'Draft 8');
  assert.equal(j.name, 'Draft 8');
}));

test('editing a journal before its first push finishes still makes one page', () => scenario('create-race', async ({ seed, world }) => {
  await openWorld(world);
  const j = await JournalEntry.create({ name: 'Racing', pages: [{ name: 'Racing', type: 'text', text: { content: '<p>a</p>' } }] });
  await j.update({ name: 'Racing Renamed' });
  await settle();
  const entities = await seed.chronicle.allEntities();
  assert.equal(entities.length, 1, `pages: ${entities.map((e) => e.name).join(', ')}`);
  assert.equal(entities[0].name, 'Racing Renamed');
}));

test('editing page text in Foundry reaches Chronicle', () => scenario('fvtt-page-edit', async ({ seed, world }) => {
  await openWorld(world);
  const j = await JournalEntry.create({ name: 'Notes', pages: [{ name: 'Notes', type: 'text', text: { content: '<p>first</p>' } }] });
  await settle();
  await j.pages.contents[0].update({ 'text.content': '<p>second</p>' });
  await settle();
  const full = await seed.chronicle.get(`/entities/${j.getFlag(FLAG, 'entityId')}`);
  assert.match(full.entry_html || '', /second/);
}));

test('changes made while the connection was down arrive when it comes back', () => scenario('ws-drop', async ({ seed, world }) => {
  const e = await chroniclePage(seed, 'Watchtower');
  await openWorld(world);
  await JournalSync_resync(world);
  const api = world.syncManager.api;
  const connect = api._doConnect.bind(api);
  let hold = true;
  api._doConnect = () => (hold ? setTimeout(() => api._doConnect(), 100) : connect());
  api._ws.close();
  await waitFor(() => api._ws === null || api._ws.readyState !== 1, 5000, 'socket to drop');
  await seed.chronicle.put(`/entities/${e.id}`, { name: 'Watchtower (abandoned)' });
  const added = await chroniclePage(seed, 'Made During Outage');
  hold = false;
  await waitFor(() => byEntity(world, e.id)?.name === 'Watchtower (abandoned)', 30000, 'rename after reconnect');
  await waitFor(() => byEntity(world, added.id), 30000, 'new page after reconnect');
  await settle();
  assert.equal(world.game.journal.filter((j) => j.name === 'Made During Outage').length, 1);
}));

test('the same page edited on both sides at once ends the same on both sides', () => scenario('both-sides', async ({ seed, world }) => {
  const e = await chroniclePage(seed, 'Crossroads');
  await openWorld(world);
  await JournalSync_resync(world);
  const j = byEntity(world, e.id);
  await Promise.all([
    j.update({ name: 'Crossroads (Foundry)' }),
    seed.chronicle.put(`/entities/${e.id}`, { name: 'Crossroads (Chronicle)' }),
  ]);
  await settle();
  // Which side wins is the conflict setting's call; the bench only demands
  // that they agree (checked for every scenario) and nothing is duplicated.
  assert.equal(world.game.journal.filter((x) => x.name.startsWith('Crossroads')).length, 1);
}));

// Two tiny, different PNGs: Chronicle gives identical bytes one media id.
const PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4IScHRAwQCgAfJgQRoo8irwAAAABJRU5ErkJggg==',
].map((b) => Buffer.from(b, 'base64'));

async function uploadPicture(seed, name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), name);
  const res = await fetch(`${CHRONICLE_URL}/api/v1/campaigns/${seed.campaignId}/media`, {
    method: 'POST', headers: { authorization: `Bearer ${seed.moduleKey}` }, body: form,
  });
  assert.equal(res.status, 201, `upload ${name}: ${await res.clone().text()}`);
  return (await res.json()).id;
}

test('pictures inside page text show in Foundry, GM-only ones stay secret, and an edit sends both back unchanged', (t) => scenario('pictures', async ({ seed, world }) => {
  const shared = await uploadPicture(seed, 'mira.png', PNGS[0]);
  const secret = await uploadPicture(seed, 'traitor.png', PNGS[1]);
  assert.notEqual(shared, secret);
  const html = `<p>Mira runs the docks.</p>`
    + `<figure class="ce-img ce-img--w40 ce-img--right"><img src="/media/${shared}" alt="Mira"><figcaption>Mira Kell</figcaption></figure>`
    + `<figure class="ce-img ce-img--w30 ce-img--left ce-img--gm"><img src="/media/${secret}" alt="x"><figcaption>The traitor</figcaption></figure>`
    + `<p>She owes the guild.</p>`;
  const e = await chroniclePage(seed, 'Mira Kell', html);
  const stored = (await seed.chronicle.get(`/entities/${e.id}`)).entry_html || '';
  if (!stored.includes('ce-img--gm')) {
    t.skip('this Chronicle does not keep pictures inside page text yet (Chronicle#997)');
    return;
  }

  await openWorld(world);
  await JournalSync_resync(world);
  const j = byEntity(world, e.id);
  const text = pageText(j);
  const local = `worlds/bench-world/chronicle-media/${shared}.png`;
  assert.ok(text.includes(`src="${local}"`), `shared picture points at its copy: ${text}`);
  assert.ok(world.files.has(local), 'the copy is in the world files');
  assert.match(text, new RegExp(`<section class="secret[^"]*"[^>]*><figure class="[^"]*ce-img--gm[^"]*"><img src="/media/${secret}"`));
  assert.ok(![...world.files.keys()].some((p) => p.includes(secret)), 'a GM-only picture is never copied');

  // A second pull reuses the copy.
  await JournalSync_resync(world);
  assert.equal([...world.files.keys()].filter((p) => p.includes(shared)).length, 1);

  // An edit in Foundry sends the plain Chronicle paths back, GM-only intact.
  const page = j.pages.contents.find((p) => p.type === 'text');
  await page.update({ 'text.content': page.text.content.replace('She owes the guild.', 'She owes the guild 40 gold.') });
  await settle();
  const after = (await seed.chronicle.get(`/entities/${e.id}`)).entry_html || '';
  assert.match(after, /40 gold/);
  assert.ok(after.includes(`src="/media/${shared}"`), `shared path restored: ${after}`);
  assert.match(after, new RegExp(`<figure class="[^"]*ce-img--gm[^"]*"><img src="/media/${secret}"`));
  assert.ok(!after.includes('chronicle-media') && !after.includes('<section'), `no Foundry-side markup leaks back: ${after}`);
}));

/** The dashboard's Resync, used where a scenario needs every page linked up front. */
async function JournalSync_resync(world) {
  const js = world.syncManager._modules.find((m) => m.constructor.name === 'JournalSync');
  await js.resyncAll({ verbose: false });
  await settle();
}
