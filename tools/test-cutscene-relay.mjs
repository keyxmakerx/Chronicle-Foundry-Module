#!/usr/bin/env node
/**
 * Cut scenes in Foundry: which Foundry users a showing reaches, who may have
 * its scene, the watch-again list's filtering and merging, and the relay as
 * the GM's client runs it, with real encryption: a scene goes only to a
 * matched viewer's client, sealed to its key, and the list is read for the
 * asker's own member whatever the request says. With the engine vendored,
 * also checks it is Chronicle's file unchanged (CHRONICLE_DIR) and that it
 * offers the API the module calls. A Director's preview plays on one GM's
 * screen and never touches the module socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CUTSCENE_MSG,
  cleanScene,
  cleanShowing,
  cleanShowingList,
  cutscenesVerdict,
  isCutsceneMessage,
  lateJoinShowings,
  listErrorFrom,
  mayFetch,
  mergeShowings,
  nextExpiryDelay,
  parseFoundryPreview,
  parseFoundryShowing,
  previewPlayer,
  showingIdOf,
  showingsPath,
  showingsWithin,
  untilLabel,
  viewerTargets,
} from '../scripts/_cutscene-relay.mjs';
import { decryptReply, generateRequestKeys } from '../scripts/_stash-crypto.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const NOW = Date.parse('2026-03-01T20:00:00Z');
const HOUR = 60 * 60 * 1000;
const scene = {
  id: 'sc1', name: 'The Eye Opens',
  background: { kind: 'fall-asleep', seconds: 7, params: {} },
  overlays: [{ kind: 'eye', at: 7.5, seconds: 3.5, params: { color: '#3dff7a' } }],
  text: [{ say: 'Something has noticed you.', at: 11, seconds: 5, style: 'whisper' }],
  ending: { kind: 'tap' },
};

test('a cutscene.foundry payload is read with its viewers; a malformed one is refused', () => {
  const s = parseFoundryShowing({
    showingId: 'sh-1', viewers: ['m1', 'm2', 'm1', 7, null], scene, rewatchUntil: '2026-03-02T08:00:00Z',
  }, NOW);
  assert.equal(s.showingId, 'sh-1');
  assert.deepEqual(s.viewers, ['m1', 'm2', '7']);
  assert.equal(s.name, 'The Eye Opens');
  assert.equal(s.shownAt, NOW);
  assert.equal(s.rewatchUntil, Date.parse('2026-03-02T08:00:00Z'));
  assert.equal(parseFoundryShowing({ showingId: 'x', scene, rewatchUntil: 'soon' }, NOW), null);
  assert.equal(parseFoundryShowing({ showingId: 'x', scene: 'nope', rewatchUntil: NOW + HOUR }, NOW), null);
  assert.equal(parseFoundryShowing({ showingId: '../x', scene, rewatchUntil: NOW + HOUR }, NOW), null);
  assert.equal(showingIdOf(42), '42');
  assert.equal(showingIdOf('a b'), null);
});

test('a scene keeps only its own keys, with harmless defaults for missing layers', () => {
  const s = cleanScene({ name: 'x', extra: '<script>', overlays: [1, { kind: 'eye' }] });
  assert.deepEqual(Object.keys(s).sort(), ['background', 'ending', 'name', 'overlays', 'text']);
  assert.deepEqual(s.overlays, [{ kind: 'eye' }]);
  assert.deepEqual(s.background, { kind: 'none' });
  assert.deepEqual(s.ending, { kind: 'tap' });
  assert.equal(cleanScene([]), null);
});

test('viewers reach the Foundry users matched to them who are playing now', () => {
  const mappings = { m1: 'u1', m2: 'u2', m3: 'u3', m4: 'gone' };
  const users = [{ id: 'u1', active: true }, { id: 'u2', active: false }, { id: 'u3', active: true }];
  assert.deepEqual(viewerTargets(['m1', 'm2', 'm4', 'm5', 'm1'], mappings, users), {
    deliver: ['u1'], away: ['m2'], unmapped: ['m4', 'm5'],
  });
  // m3 is matched and here, but the Director did not pick them.
  assert.ok(!viewerTargets(['m1'], mappings, users).deliver.includes('u3'));
  assert.deepEqual(viewerTargets(['m1'], null, null), { deliver: [], away: [], unmapped: ['m1'] });
});

test('a scene goes only to a viewer, only while live and inside its window', () => {
  const showing = { showingId: 's', viewers: ['m1'], rewatchUntil: NOW + HOUR, stopped: false };
  const mappings = { m1: 'u1', m2: 'u2' };
  assert.deepEqual(mayFetch(showing, 'u1', mappings, NOW), { ok: true, member: 'm1' });
  assert.equal(mayFetch(showing, 'u2', mappings, NOW).reason, 'not_viewer');
  assert.equal(mayFetch(showing, 'stranger', mappings, NOW).reason, 'not_viewer');
  assert.equal(mayFetch(null, 'u1', mappings, NOW).reason, 'unknown');
  assert.equal(mayFetch({ ...showing, stopped: true }, 'u1', mappings, NOW).reason, 'stopped');
  assert.equal(mayFetch(showing, 'u1', mappings, NOW + 2 * HOUR).reason, 'expired');
});

test('a player who opens Foundry within two minutes still gets a live showing, once', () => {
  const mappings = { m1: 'u1' };
  const base = { viewers: ['m1'], rewatchUntil: NOW + HOUR, stopped: false, delivered: new Set() };
  const list = [
    { ...base, showingId: 'b', shownAt: NOW - 60 * 1000 },
    { ...base, showingId: 'a', shownAt: NOW - 90 * 1000 },
    { ...base, showingId: 'old', shownAt: NOW - 3 * 60 * 1000 },
    { ...base, showingId: 'stopped', shownAt: NOW - 1000, stopped: true },
    { ...base, showingId: 'had', shownAt: NOW - 1000, delivered: new Set(['u1']) },
    { ...base, showingId: 'other', shownAt: NOW - 1000, viewers: ['m2'] },
  ];
  assert.deepEqual(lateJoinShowings(list, 'u1', mappings, NOW), ['a', 'b']);
  assert.deepEqual(lateJoinShowings(list, 'nobody', mappings, NOW), []);
});

test('the watch-again list: unwrapped, expired rows gone, newest first, Chronicle wins a duplicate', () => {
  const row = (id, shownAt, until, name = id) => ({ showingId: id, name, shownAt, rewatchUntil: until, scene });
  const chronicle = cleanShowingList({ data: [row('a', NOW - 2 * HOUR, NOW + HOUR), row('gone', NOW - 5 * HOUR, NOW - 1), { bad: 1 }], total: 3 }, NOW);
  assert.equal(chronicle.length, 2);
  assert.deepEqual(cleanShowingList([row('a', NOW, NOW + 1)], NOW).map((s) => s.showingId), ['a']);
  assert.deepEqual(cleanShowingList(null, NOW), []);
  const merged = mergeShowings(chronicle, [row('a', NOW - 2 * HOUR, NOW + HOUR, 'stale name'), row('b', NOW - HOUR, NOW + HOUR)], NOW);
  assert.deepEqual(merged.map((s) => s.showingId), ['b', 'a']);
  assert.equal(merged[1].name, 'a');
  assert.deepEqual(showingsWithin([row('x', NOW, NOW)], NOW), []);
});

test('the list redraws when the next row expires, and not when nothing will', () => {
  const list = [{ rewatchUntil: NOW + 5000 }, { rewatchUntil: NOW + 1000 }, { rewatchUntil: NOW - 1 }];
  assert.equal(nextExpiryDelay(list, NOW), 1250);
  assert.equal(nextExpiryDelay([], NOW), null);
  assert.equal(nextExpiryDelay([{ rewatchUntil: NOW + 100 * HOUR }], NOW), 6 * HOUR);
});

test('"until" reads as a time today, a weekday this week, else a date', () => {
  const opts = { locale: 'en-US', timeZone: 'UTC' };
  // ICU versions differ on which space goes before AM/PM.
  const label = (ms) => untilLabel(ms, NOW, opts).replace(/\s/g, ' ');
  assert.equal(label(Date.parse('2026-03-01T22:30:00Z')), '10:30 PM');
  assert.equal(label(Date.parse('2026-03-03T08:00:00Z')), 'Tue 8:00 AM');
  assert.equal(label(Date.parse('2026-03-20T08:00:00Z')), 'Mar 20 8:00 AM');
});

test('the add-on verdict, and failures worded for the Satchel', () => {
  assert.equal(cutscenesVerdict({ body: { data: [{ slug: 'cutscenes', enabled: true }] } }), true);
  assert.equal(cutscenesVerdict({ body: [{ slug: 'cutscenes', enabled: false }] }), false);
  assert.equal(cutscenesVerdict({ body: [{ slug: 'maps', enabled: true }] }), false);
  assert.equal(cutscenesVerdict({ error: new Error('down') }), null);
  assert.equal(cutscenesVerdict({ body: 'odd' }), null);
  assert.equal(listErrorFrom({ status: 403 }).code, 'off');
  assert.equal(listErrorFrom({ status: 404 }).code, 'missing');
  assert.equal(listErrorFrom({ status: 500 }).code, 'unreachable');
  assert.equal(showingsPath('m 1&x'), '/cutscenes/showings?user=m%201%26x');
  assert.ok(isCutsceneMessage({ type: CUTSCENE_MSG.KNOCK }));
  assert.ok(!isCutsceneMessage({ type: 'stash:request' }));
});

// --- The relay as the GM's client runs it ----------------------------------

const emits = [];
const settings = { userMappings: JSON.stringify({ m1: 'u1', m2: 'u2' }), cutscenesAvailable: false };
const users = [
  { id: 'gm', isGM: true, active: true },
  { id: 'u1', isGM: false, active: true },
  { id: 'u2', isGM: false, active: false },
];
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b }, sheets: { ActorSheetV2: class {} }, ux: { TextEditor: {} } },
  utils: { mergeObject: (a, b) => ({ ...a, ...b }) },
};
globalThis.Hooks = globalThis.Hooks || { on: () => 1, off: () => {}, once: () => {}, callAll: () => {} };
globalThis.ui = globalThis.ui || { notifications: { info() {}, warn() {}, error() {} } };
globalThis.game = {
  user: users[0],
  users: Object.assign(users, { activeGM: users[0], get: (id) => users.find((u) => u.id === id), contents: users }),
  settings: {
    get: (_m, k) => settings[k],
    set: async (_m, k, v) => { settings[k] = v; },
    register() {}, registerMenu() {},
  },
  i18n: { localize: (k) => k, format: (k) => k, lang: 'en' },
  socket: { emit: (...args) => emits.push(args), on() {} },
};

const { CutsceneRelay } = await import('../scripts/cutscenes.mjs');

function showPayload(id = 'sh-1') {
  return { showingId: id, viewers: ['m1', 'm2'], scene, rewatchUntil: new Date(Date.now() + HOUR).toISOString() };
}

test('the active GM knocks only on matched viewers who are here, with the id alone', () => {
  emits.length = 0;
  const relay = new CutsceneRelay();
  relay.onMessage({ type: 'cutscene.foundry', payload: showPayload() });
  const knocks = emits.filter(([, m]) => m.type === CUTSCENE_MSG.KNOCK);
  assert.equal(knocks.length, 1);
  const [, msg, opts] = knocks[0];
  assert.deepEqual(msg, { type: CUTSCENE_MSG.KNOCK, showingId: 'sh-1', toUserId: 'u1' });
  assert.deepEqual(opts, { recipients: ['u1'] });
  assert.equal(JSON.stringify(emits).includes('Something has noticed you'), false, 'no scene in the clear');
});

test('a viewer gets the scene sealed to its key; anyone else gets no scene', async () => {
  emits.length = 0;
  const relay = new CutsceneRelay();
  relay.onMessage({ type: 'cutscene.foundry', payload: showPayload('sh-2') });
  const keys = await generateRequestKeys();
  await relay.handleFetch({ type: CUTSCENE_MSG.FETCH, requestId: 'req12345', showingId: 'sh-2', publicKey: keys.publicJwk }, 'u1');
  const play = emits.find(([, m]) => m.type === CUTSCENE_MSG.PLAY);
  assert.deepEqual(play[2], { recipients: ['u1'] });
  assert.equal(play[1].toUserId, 'u1');
  const body = await decryptReply(keys.privateKey, play[1].envelope);
  assert.equal(body.ok, true);
  assert.equal(body.showing.scene.text[0].say, 'Something has noticed you.');
  assert.equal(body.showing.viewers, undefined, 'who else saw it never reaches a player');

  emits.length = 0;
  const other = await generateRequestKeys();
  // A payload naming someone else changes nothing: the sender is the socket's.
  await relay.handleFetch({ type: CUTSCENE_MSG.FETCH, requestId: 'req67890', showingId: 'sh-2', publicKey: other.publicJwk, userId: 'u1' }, 'u9');
  const refused = await decryptReply(other.privateKey, emits[0][1].envelope);
  assert.deepEqual(refused, { ok: false, error: { code: 'not_viewer' } });

  // After the Director stops it, a late fetch starts nothing.
  emits.length = 0;
  relay.onMessage({ type: 'cutscene.foundry_stop', payload: { showingId: 'sh-2' } });
  assert.deepEqual(emits[0][1], { type: CUTSCENE_MSG.STOP, showingId: 'sh-2' });
  assert.deepEqual(emits[0][2], { recipients: ['u1'] });
  emits.length = 0;
  await relay.handleFetch({ type: CUTSCENE_MSG.FETCH, requestId: 'req13579', showingId: 'sh-2', publicKey: keys.publicJwk }, 'u1');
  assert.equal((await decryptReply(keys.privateKey, emits[0][1].envelope)).error.code, 'stopped');
});

test('the watch-again list is read for the asker\'s own member, and a failure falls back to what was handed out', async () => {
  emits.length = 0;
  const calls = [];
  const relay = new CutsceneRelay();
  relay._api = {
    get: async (path) => {
      calls.push(path);
      return { data: [{ showingId: 'sh-9', name: 'Dawn', shownAt: new Date().toISOString(), rewatchUntil: new Date(Date.now() + HOUR).toISOString(), scene }], total: 1 };
    },
  };
  const keys = await generateRequestKeys();
  await relay.handleList({ type: CUTSCENE_MSG.LIST, requestId: 'reqlist01', publicKey: keys.publicJwk, user: 'm2' }, 'u1');
  assert.deepEqual(calls, ['/cutscenes/showings?user=m1']);
  const body = await decryptReply(keys.privateKey, emits[0][1].envelope);
  assert.equal(body.ok, true);
  assert.equal(body.data[0].name, 'Dawn');
  assert.deepEqual(emits[0][2], { recipients: ['u1'] });

  // A Foundry user matched to no member gets no list at all.
  assert.deepEqual(await relay.listFor('stranger'), { ok: false, error: { code: 'no_mapping' } });

  relay.onMessage({ type: 'cutscene.foundry', payload: showPayload('sh-10') });
  relay._api = { get: async () => { throw Object.assign(new Error('down'), { status: 502 }); } };
  const failed = await relay.listFor('u1');
  assert.equal(failed.error.code, 'unreachable');
  assert.deepEqual(failed.data.map((s) => s.showingId), ['sh-10']);
});

test('a client that is not the active GM hands nothing out', async () => {
  emits.length = 0;
  const relay = new CutsceneRelay();
  game.users.activeGM = { id: 'someone-else' };
  try {
    relay.onMessage({ type: 'cutscene.foundry', payload: showPayload('sh-3') });
    const keys = await generateRequestKeys();
    await relay.handleList({ type: CUTSCENE_MSG.LIST, requestId: 'reqlist02', publicKey: keys.publicJwk }, 'u1');
    assert.equal(emits.length, 0);
  } finally {
    game.users.activeGM = users[0];
  }
});

// --- Preview in Foundry -----------------------------------------------------

test('a preview payload is read with its Director; a malformed one is refused', () => {
  assert.deepEqual(parseFoundryPreview({ previewId: 'pv-1', director: 'm9', scene }),
    { previewId: 'pv-1', director: 'm9', scene: cleanScene(scene) });
  assert.equal(parseFoundryPreview({ previewId: 'pv-1', director: 7, scene }).director, '7');
  assert.equal(parseFoundryPreview({ previewId: 'pv-1', scene }).director, '', 'no Director still plays on the active GM');
  assert.equal(parseFoundryPreview({ previewId: 'bad id!', scene }), null);
  assert.equal(parseFoundryPreview({ previewId: 'pv-1', scene: 'nope' }), null);
  assert.equal(parseFoundryPreview(null), null);
});

test('a preview plays on the Director\'s own GM screen, else the active GM\'s, never a player\'s', () => {
  const people = [
    { id: 'gm1', isGM: true, active: true },
    { id: 'gm2', isGM: true, active: true },
    { id: 'gm3', isGM: true, active: false },
    { id: 'p1', isGM: false, active: true },
  ];
  const map = { dirA: 'gm2', dirB: 'gm3', dirC: 'p1' };
  assert.equal(previewPlayer('dirA', map, people, 'gm1'), 'gm2', 'their own GM user, playing now');
  assert.equal(previewPlayer('dirB', map, people, 'gm1'), 'gm1', 'their GM user is away: the active GM');
  assert.equal(previewPlayer('dirC', map, people, 'gm1'), 'gm1', 'matched to a player user: still a GM screen');
  assert.equal(previewPlayer('nobody', map, people, 'gm1'), 'gm1', 'not matched: the active GM');
  assert.equal(previewPlayer('', map, people, 'gm1'), 'gm1');
  assert.equal(previewPlayer('dirC', map, people, 'p1'), null, 'a player is never the screen, whatever says active');
  assert.equal(previewPlayer('nobody', map, people, null), null, 'no GM here: nowhere');
});

test('the relay plays a preview on the chosen GM\'s screen alone and says nothing on the socket', async () => {
  const plays = [];
  const savedDoc = globalThis.document;
  globalThis.document = {
    body: { tag: 'body' },
    createElement: () => ({}),
    head: { appendChild: (el) => { queueMicrotask(() => el.onload?.()); } },
  };
  globalThis.ChronicleCutscene = {
    play: (host, sc, opts) => { plays.push({ host, sc, opts }); return { stop() {} }; },
  };
  const savedMap = settings.userMappings;
  try {
    emits.length = 0;
    const relay = new CutsceneRelay();
    const payload = { previewId: 'pv-2', director: 'dir', scene };
    // Not matched: the active GM (this client) plays it.
    assert.equal(await relay.onMessage({ type: 'cutscene.foundry_preview', payload }), true);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].sc.text[0].say, 'Something has noticed you.');
    assert.equal(plays[0].opts.label, 'CHRONICLE.Cutscenes.PreviewLabel');

    // Matched to another GM who is here: this screen stays quiet.
    users.push({ id: 'gm-b', isGM: true, active: true });
    settings.userMappings = JSON.stringify({ m1: 'u1', m2: 'u2', dir: 'gm-b' });
    assert.equal(relay.onMessage({ type: 'cutscene.foundry_preview', payload }), undefined);
    assert.equal(plays.length, 1);

    // Even a client that is not the active GM plays a preview that is its own.
    settings.userMappings = JSON.stringify({ m1: 'u1', m2: 'u2', dir: 'gm' });
    game.users.activeGM = users.find((u) => u.id === 'gm-b');
    assert.equal(await relay.onMessage({ type: 'cutscene.foundry_preview', payload }), true);
    assert.equal(plays.length, 2);

    assert.equal(emits.length, 0, 'a preview never goes on the module socket');
    assert.equal(relay._showings.size, 0, 'nor into the showings players can fetch');
  } finally {
    game.users.activeGM = users[0];
    users.splice(users.findIndex((u) => u.id === 'gm-b'), 1);
    settings.userMappings = savedMap;
    globalThis.document = savedDoc;
    delete globalThis.ChronicleCutscene;
  }
});

test('a player\'s client never plays a preview, even one naming it', () => {
  const relay = new CutsceneRelay();
  const me = game.user;
  game.user = users[1];
  try {
    assert.equal(relay.onMessage({ type: 'cutscene.foundry_preview', payload: { previewId: 'pv-3', director: 'm1', scene } }), undefined);
  } finally {
    game.user = me;
  }
});

test('wiring: socket rules, the allowlist, the Satchel tab, and nothing saved in a document', () => {
  const src = read('scripts/cutscenes.mjs');
  // Answers count only from a GM and only for this user.
  assert.match(src, /const fromGM = game\.users\.get\(senderId\)\?\.isGM === true;/);
  assert.match(src, /if \(fromGM && forMe\) settleSealed\(data\);/);
  assert.match(src, /if \(fromGM && forMe && id\) onKnock\(id\);/);
  // The limiter runs before anything else in each GM answer.
  for (const fn of ['async handleFetch(', 'async handleList(']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n  }\n', src.indexOf(fn)));
    assert.match(body, /if \(!isActiveGM\(\) \|\| !askLimit\(senderId\)\) return;/, fn);
  }
  // A preview is played here, never emitted to other clients.
  const preview = src.slice(src.indexOf('  _preview(payload) {'), src.indexOf('\n  }\n', src.indexOf('  _preview(payload) {')));
  assert.doesNotMatch(preview, /socket|knock\(|remember\(|_showings/);
  // Scenes stay in memory: no document, flag or chat message is written.
  for (const f of ['scripts/cutscenes.mjs', 'scripts/cutscene-tab.mjs']) {
    assert.doesNotMatch(read(f), /\.setFlag\(|\.createDocuments\(|\.updateDocuments\(|\b(?:Actor|Item|JournalEntry|Scene|Folder|ChatMessage|Macro)\.create\(|\.update\(\{|game\.settings\.set\(/, f);
  }
  assert.match(read('scripts/api-client.mjs'), /'cutscene\.',/);
  assert.match(read('scripts/module.mjs'), /syncManager\.registerModule\(new CutsceneRelay\(\)\);/);
  assert.match(read('scripts/module.mjs'), /registerCutscenes\(\);/);
  // Every string the cut scene files use is in en.json.
  const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Cutscenes;
  for (const f of ['scripts/cutscenes.mjs', 'scripts/cutscene-tab.mjs']) {
    for (const [, key] of read(f).matchAll(/\bt\('([A-Za-z]+)'/g)) assert.equal(typeof lang[key], 'string', `${f}: ${key}`);
  }
  for (const key of Object.values({ a: 'NoticeNoGM', b: 'NoticeUnreachable', c: 'NoticeOff', d: 'NoticeNoLink' })) {
    assert.equal(typeof lang[key], 'string', key);
  }
});

const VENDORED = new URL('../vendor/chronicle/cutscene_engine.js', import.meta.url);
const vendored = existsSync(VENDORED);

test('the vendored engine offers play(host, scene, options) returning stop()', { skip: !vendored && 'engine not vendored yet' }, async () => {
  const mod = await import(VENDORED.href);
  const engine = mod.default ?? mod;
  const api = engine.ChronicleCutscene ?? engine;
  assert.equal(typeof api.play, 'function');
  for (const kind of ['fall-asleep', 'eye']) {
    assert.ok(readFileSync(VENDORED, 'utf8').includes(`'${kind}'`), kind);
  }
});

const chronicle = process.env.CHRONICLE_DIR && join(process.env.CHRONICLE_DIR, 'static', 'js', 'cutscene_engine.js');
test('the vendored engine matches Chronicle\'s (needs CHRONICLE_DIR)', { skip: !(chronicle && existsSync(chronicle) && vendored) && 'CHRONICLE_DIR not set, or engine not vendored' }, () => {
  assert.ok(readFileSync(chronicle).equals(readFileSync(VENDORED)),
    'vendor/chronicle/cutscene_engine.js differs from Chronicle\'s; copy it again from static/js/');
});
