#!/usr/bin/env node
/**
 * Preview in Foundry, both sides real: the Director presses it in
 * Chronicle's cut scene workshop on an unsaved scene, Chronicle hands it to
 * the module's socket, and the GM's own screen plays it. Nothing goes on
 * the Foundry module socket, so no player's client can hear of it, even
 * when the Director's account is matched to a player user.
 *
 * A moment, end to end: a scene that asks something is shown to a player in
 * Foundry and a player in Chronicle; each answers, the Director adds one to a
 * page and turns the other down, and Continue brings the added line to the
 * Foundry player's screen. The player's client is played by hand on the
 * module socket (the knock, the sealed fetch, the sealed answer).
 *
 * The engine itself needs a browser, so a stand-in records what it was
 * asked to play; everything between the button and that call is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, settle, waitFor } from './world.mjs';
import { scenario } from './scenario.mjs';
import { CHRONICLE_URL } from './chronicle.mjs';
import { CUTSCENE_MSG } from '../scripts/_cutscene-relay.mjs';
import { decryptReply, encryptReply, generateRequestKeys } from '../scripts/_stash-crypto.mjs';

const MODULES = { modules: ['cutscenes'] };
const PLAYER = 'benchPlayer00001';

/** Record engine plays and module-socket emits for one scenario. */
function watch(world) {
  const plays = [];
  const emits = [];
  // The engine loads once per run, so each scenario points it at its own list.
  const engine = {
    play: (host, scene, opts) => { plays.push({ host, scene, opts }); return { stop() {} }; },
  };
  globalThis.ChronicleCutscene = engine;
  globalThis.document = {
    body: { tag: 'body' },
    createElement: () => ({}),
    head: {
      appendChild: (el) => {
        globalThis.ChronicleCutscene = engine;
        queueMicrotask(() => el.onload?.());
      },
    },
  };
  world.game.socket.emit = (...args) => emits.push(args);
  return { plays, emits };
}

/** The workshop's Preview in Foundry: the editor's form, posted as is. */
async function pressPreview(seed, form) {
  // As the workshop's script sends it: a form, asking for JSON back.
  const res = await fetch(`${CHRONICLE_URL}/campaigns/${seed.campaignId}/cutscenes/preview/foundry`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: seed.web.cookie(),
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': seed.web.csrf(),
    },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function ownMember(seed) {
  const members = await seed.chronicle.get('/members');
  const me = (Array.isArray(members) ? members : members.data).find((m) => m.display_name === seed.displayName);
  return String(me.user_id ?? me.id);
}

const UNSAVED = {
  name: 'Never saved', bg_kind: 'black', bg_seconds: '2',
  tx_say: 'Only the Director sees this.', tx_at: '0', tx_seconds: '3', tx_style: 'title',
  end_kind: 'auto',
};

test('Preview in Foundry plays an unsaved scene on the GM\'s screen and nowhere else', () => scenario('fvtt-cutscene-preview', async ({ seed, world }) => {
  await seed.enableAddon('cutscenes');
  const { plays, emits } = watch(world);
  await openWorld(world, MODULES);

  const sent = await pressPreview(seed, UNSAVED);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body, { sent: true });
  await waitFor(() => plays.length === 1, 10000, 'the preview played');
  await settle();
  assert.equal(plays[0].scene.name, 'Never saved');
  assert.equal(plays[0].scene.text[0].say, 'Only the Director sees this.');
  assert.equal(plays[0].scene.ending.kind, 'auto');
  assert.equal(emits.length, 0, 'nothing went on the module socket');
  assert.equal(world.cutscenes._showings.size, 0, 'nothing a player could fetch');
  const list = await seed.web.get(`/campaigns/${seed.campaignId}/cutscenes`);
  assert.doesNotMatch(await list.text(), /Never saved/, 'the scene was not saved');
}));

test('a Director matched to a player user still gets the preview on the GM\'s screen, never the player\'s', () => scenario('fvtt-cutscene-preview-mapped', async ({ seed, world }) => {
  await seed.enableAddon('cutscenes');
  const { plays, emits } = watch(world);
  await openWorld(world, MODULES);
  // A player who is playing now, as the Director's matched Foundry user.
  await world.asPlayer(async () => {});
  world.game.users.get(PLAYER).active = true;
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [await ownMember(seed)]: PLAYER }));

  const sent = await pressPreview(seed, { ...UNSAVED, name: 'Mapped preview' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitFor(() => plays.length === 1, 10000, 'the preview played');
  await settle();
  assert.equal(plays[0].scene.name, 'Mapped preview');
  assert.equal(emits.length, 0, 'no knock or scene went to the player\'s client');
}));

test('a scene a save would refuse is refused for Foundry too, in the server\'s words', () => scenario('fvtt-cutscene-preview-refused', async ({ seed, world }) => {
  await seed.enableAddon('cutscenes');
  const { plays } = watch(world);
  await openWorld(world, MODULES);
  const sent = await pressPreview(seed, { name: 'Bad', ov_kind: 'dragon' });
  assert.equal(sent.status, 400);
  assert.match(String(sent.body.message), /dragon/);
  await settle();
  assert.equal(plays.length, 0);
}));

/** The module-socket messages sent to one Foundry user, of one type. */
const sentTo = (emits, type, userId) => emits.filter(([, m]) => m?.type === type && m.toUserId === userId).map(([, m]) => m);

/** Play the player's client: ask the GM's client and open its sealed reply. */
async function askAsPlayer(world, emits, type, replyType, handler, extra) {
  const keys = await generateRequestKeys();
  const requestId = `req${Math.random().toString(36).slice(2, 12)}`;
  await handler.call(world.cutscenes, { type, requestId, publicKey: keys.publicJwk, ...extra }, PLAYER);
  await waitFor(() => emits.some(([, m]) => m?.type === replyType && m.requestId === requestId), 10000, `${replyType} came`);
  const [, msg] = emits.find(([, m]) => m?.type === replyType && m.requestId === requestId);
  return decryptReply(keys.privateKey, msg.envelope);
}

test('a moment end to end: a Foundry player and a Chronicle player answer, the Director adds one and turns one down, and the line reaches Foundry', () => scenario('fvtt-cutscene-moment', async ({ seed, world }) => {
  await seed.enableAddon('cutscenes');
  const ana = await seed.addPlayer('Ana');
  const bo = await seed.addPlayer('Bo');
  const { plays, emits } = watch(world);
  await openWorld(world, MODULES);
  await world.asPlayer(async () => {});
  world.game.users.get(PLAYER).active = true;
  await world.game.settings.set('chronicle-sync', 'userMappings', JSON.stringify({ [ana.userId]: PLAYER }));

  const types = await seed.chronicle.entityTypes();
  const page = await seed.chronicle.post('/entities', { name: 'The Drowned Bell', entity_type_id: types[0].id, is_private: true });
  const C = `/campaigns/${seed.campaignId}`;
  let res = await seed.web.post(`${C}/cutscenes`, { name: 'Saltreach' });
  const sid = (res.headers.get('location') || '').match(/cutscenes\/([0-9a-f-]{36})/)?.[1];
  assert.ok(sid, `scene created: ${res.status}`);
  res = await seed.web.post(`${C}/cutscenes/${sid}`, {
    name: 'Saltreach', bg_kind: 'black', tx_say: 'The harbour is quiet.', tx_at: '0', tx_seconds: '3', tx_style: 'title',
    mo_at: '1', mo_ask: 'What do the fishermen whisper?', mo_ways: 'write director', mo_to: '', mo_note: 'NOTE-SECRET they lie', end_kind: 'tap',
  });
  assert.ok(res.status < 400, `scene saved: ${res.status}`);
  res = await seed.web.post(`${C}/cutscenes/${sid}/show`, [['to', ana.userId], ['to', bo.userId]]);
  assert.equal(res.status, 200, 'shown');

  // The GM's client knocks on Ana's Foundry user; her client fetches the scene, sealed.
  await waitFor(() => sentTo(emits, CUTSCENE_MSG.KNOCK, PLAYER).length === 1, 10000, 'knocked');
  const shid = sentTo(emits, CUTSCENE_MSG.KNOCK, PLAYER)[0].showingId;
  const got = await askAsPlayer(world, emits, CUTSCENE_MSG.FETCH, CUTSCENE_MSG.PLAY, world.cutscenes.handleFetch, { showingId: shid });
  assert.equal(got.ok, true);
  assert.equal(got.showing.scene.moments[0].ask, 'What do the fishermen whisper?');
  assert.equal(JSON.stringify(got).includes('NOTE-SECRET'), false, 'the Director\'s note never reaches a player');
  assert.ok(got.answerKey, 'the GM\'s answer key comes with the scene');

  // Ana answers in Foundry, sealed to the GM's key.
  const envelope = await encryptReply(got.answerKey, { showingId: shid, moment: 0, way: 'write', text: 'That it rang the night Vell drowned.' });
  const answered = await askAsPlayer(world, emits, CUTSCENE_MSG.ANSWER, CUTSCENE_MSG.ANSWER_REPLY, world.cutscenes.handleAnswer, { envelope });
  assert.deepEqual(answered, { ok: true });

  // Bo answers in Chronicle; Ana's Foundry screen hears that Bo is adding to the story.
  res = await bo.web.post(`${C}/cutscenes/showings/${shid}/moments/0/answer`, { way: 'write', text: 'BO-DECLINED the bell is a lie' });
  assert.equal(res.status, 200, `Bo answered: ${res.status}`);
  await waitFor(() => sentTo(emits, CUTSCENE_MSG.STATUS, PLAYER).some((m) => m.member === bo.userId), 10000, 'status to Ana');
  assert.equal(sentTo(emits, CUTSCENE_MSG.STATUS, PLAYER).find((m) => m.member === bo.userId).name, bo.displayName);

  // The Director's panel holds both; Ana's goes on the page, Bo's is turned down.
  res = await seed.web.get(`${C}/cutscenes/${sid}/live`, { 'HX-Request': 'true' });
  const panel = await res.text();
  assert.doesNotMatch(panel, /class="csw-err"/);
  const rows = [...panel.matchAll(/csw-mo-by">([^<]+)<[\s\S]*?\/answers\/([0-9a-f-]{36})/g)].map((m) => ({ by: m[1], id: m[2] }));
  const anaRow = rows.find((r) => r.by.startsWith(ana.displayName));
  const boRow = rows.find((r) => r.by.startsWith(bo.displayName));
  assert.ok(anaRow && boRow, `both answers on the panel: ${JSON.stringify(rows)}`);
  res = await seed.web.post(`${C}/cutscenes/showings/${shid}/answers/${anaRow.id}`, { action: 'add', page: 'The Drowned Bell' });
  assert.equal(res.status, 200, `added: ${res.status} ${await res.text()}`);
  res = await seed.web.post(`${C}/cutscenes/showings/${shid}/answers/${boRow.id}`, { action: 'decline' });
  assert.equal(res.status, 200, 'turned down');

  // Continue: Ana's client is knocked and fetches only the added line, sealed.
  res = await seed.web.post(`${C}/cutscenes/showings/${shid}/moments/0/go`, {});
  assert.equal(res.status, 200, 'continued');
  await waitFor(() => sentTo(emits, CUTSCENE_MSG.GO, PLAYER).length === 1, 10000, 'go knock');
  const lines = await askAsPlayer(world, emits, CUTSCENE_MSG.LINES, CUTSCENE_MSG.LINES_REPLY, world.cutscenes.handleLines, { showingId: shid, moment: 0 });
  assert.deepEqual(lines, { ok: true, lines: [{ line: 'That it rang the night Vell drowned.', from: ana.displayName }] });

  // The page holds the line, marked as Ana's; nothing secret went on the socket in the clear.
  const stored = await seed.chronicle.get(`/entities/${page.id}`);
  assert.match(String(stored.entry_html ?? stored.entryHtml ?? ''), /That it rang the night Vell drowned\.[\s\S]*from /);
  const clear = JSON.stringify(emits.map(([, m]) => ({ ...m, envelope: undefined })));
  for (const secret of ['NOTE-SECRET', 'BO-DECLINED', 'rang the night']) assert.equal(clear.includes(secret), false, `${secret} in the clear`);
  await settle();
  assert.equal(plays.length, 0, 'the GM is not a viewer, so nothing played on the GM\'s screen');
}));
