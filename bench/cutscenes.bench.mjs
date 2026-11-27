#!/usr/bin/env node
/**
 * Preview in Foundry, both sides real: the Director presses it in
 * Chronicle's cut scene workshop on an unsaved scene, Chronicle hands it to
 * the module's socket, and the GM's own screen plays it. Nothing goes on
 * the Foundry module socket, so no player's client can hear of it, even
 * when the Director's account is matched to a player user.
 *
 * The engine itself needs a browser, so a stand-in records what it was
 * asked to play; everything between the button and that call is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, settle, waitFor } from './world.mjs';
import { scenario } from './scenario.mjs';
import { CHRONICLE_URL } from './chronicle.mjs';

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
