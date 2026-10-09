#!/usr/bin/env node
/**
 * A member's Chronicle picture as their Foundry avatar
 * (scripts/_avatar-sync.mjs decisions, scripts/avatar-sync.mjs copy + update).
 *
 * Run: node --test tools/test-avatar-sync.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './_journal-test-env.mjs';
import { avatarMediaId, decideAvatar, absoluteChronicleLink } from '../scripts/_avatar-sync.mjs';
import { _isAllowedImageHost } from '../scripts/_url-validation.mjs';

const A = '0b6a3f0e-8c1d-4f6a-9a51-2f3c4d5e6f70';
const B = '1c7b4f1f-9d2e-4a7b-8b62-3a4d5e6f7081';
const API = 'https://chronicle.example';
const DEF = 'icons/svg/mystery-man.svg';
const link = (id) => `/media/${id}/thumb/300?expires=1&sig=x&campaign=c1`;
const stored = (id) => `worlds/w1/chronicle-avatars/${id}.png`;

test('the picture id comes only from a Chronicle thumbnail path', () => {
  for (const [input, want] of [
    [link(A), A],
    [`/media/${A.toUpperCase()}/thumb/300`, A],
    ['', null],
    [undefined, null],
    [`/media/${A}`, null],
    [`https://evil.example/media/${A}/thumb/300`, null],
    ['/media/../x/thumb/300', null],
  ]) assert.equal(avatarMediaId(input), want, String(input));
});

test('decideAvatar', () => {
  const mineA = { id: A, path: stored(A) };
  for (const [name, p, want] of [
    ['new picture, default avatar', { mediaId: A, current: DEF, applied: null, copyExists: false }, 'apply'],
    ['new picture, empty avatar', { mediaId: A, current: '', applied: null, copyExists: false }, 'apply'],
    ['user set their own before we ever applied', { mediaId: A, current: 'x/own.png', applied: null, copyExists: false }, 'skip'],
    ['already showing it', { mediaId: A, current: stored(A), applied: mineA, copyExists: true }, 'keep'],
    ['showing it but the copy is gone', { mediaId: A, current: stored(A), applied: mineA, copyExists: false }, 'apply'],
    ['picture changed', { mediaId: B, current: stored(A), applied: mineA, copyExists: true }, 'apply'],
    ['user changed it in Foundry after ours', { mediaId: B, current: 'x/own.png', applied: mineA, copyExists: true }, 'skip'],
    ['member removed the picture, ours showing', { mediaId: null, current: stored(A), applied: mineA, copyExists: true }, 'clear'],
    ['member removed the picture, user has their own', { mediaId: null, current: 'x/own.png', applied: mineA, copyExists: true }, 'skip'],
    ['no picture, nothing applied', { mediaId: null, current: DEF, applied: null, copyExists: false }, 'keep'],
    ['no picture, user has their own', { mediaId: null, current: 'x/own.png', applied: null, copyExists: false }, 'skip'],
  ]) assert.equal(decideAvatar({ defaultAvatar: DEF, ...p }), want, name);
});

test('links are made absolute only on the Chronicle host', () => {
  const abs = (l) => absoluteChronicleLink(l, API, _isAllowedImageHost);
  assert.equal(abs('/media/x'), `${API}/media/x`);
  assert.equal(abs(`${API}/media/x`), `${API}/media/x`);
  assert.equal(abs('https://evil.example/media/x'), '');
  assert.equal(abs('media/x'), '');
  assert.equal(abs(''), '');
});

// --- AvatarSync: copy once, update only when it should ----------------------

const { AvatarSync } = await import('../scripts/avatar-sync.mjs');

function fakeWorld({ users, existing = [], isGM = true, bodies = {} }) {
  globalThis.game.settings.get = (_m, k) => (k === 'apiUrl' ? API : '');
  const calls = { fetch: [], upload: [], mkdir: 0 };
  const picker = {
    browse: async () => ({ files: existing }),
    createDirectory: async () => { calls.mkdir++; },
    upload: async (_s, dir, file) => { calls.upload.push(file.name); return { path: `${dir}/${file.name}` }; },
  };
  const fetchFn = async (url, opts) => {
    calls.fetch.push({ url, opts });
    const id = /media\/([0-9a-f-]{36})/.exec(url)[1];
    return bodies[id] ? { ok: true, blob: async () => bodies[id] } : { ok: false };
  };
  const map = new Map(Object.entries(users));
  const sync = new AvatarSync({
    fetchFn, picker: () => picker, worldId: () => 'w1', users: () => map, isGM: () => isGM,
    apiUrl: () => API, defaultAvatar: () => DEF,
  });
  return { sync, calls };
}

/** A Foundry user whose update() applies the diff, flags included. */
function fakeUser(name, avatar, flag = null) {
  const u = {
    name, avatar, flag, updates: [],
    getFlag: () => u.flag,
    update: async (diff) => {
      u.updates.push(diff);
      if ('avatar' in diff) u.avatar = diff.avatar;
      for (const [k, v] of Object.entries(diff)) {
        if (k.endsWith('.avatar')) u.flag = v;
        if (k.endsWith('.-=avatar')) u.flag = null;
      }
    },
  };
  return u;
}

const png = (n = 10) => new Blob([new Uint8Array(n)], { type: 'image/png' });
const keyOf = (m) => m.user_id;
const member = (user_id, avatar_url) => ({ user_id, display_name: user_id, avatar_url });

test('a picture is copied once and set as the avatar', async () => {
  const alice = fakeUser('Alice', DEF);
  const { sync, calls } = fakeWorld({ users: { f1: alice }, bodies: { [A]: png() } });
  const members = [member('c1', link(A))];
  await sync.apply(members, { c1: 'f1' }, keyOf);
  assert.equal(alice.avatar, stored(A));
  assert.deepEqual(calls.upload, [`${A}.png`]);
  assert.equal(calls.fetch[0].opts.redirect, 'error');
  assert.equal(calls.fetch[0].opts.credentials, 'omit');
  assert.match(calls.fetch[0].url, /^https:\/\/chronicle\.example\/media\//);

  await sync.apply(members, { c1: 'f1' }, keyOf);
  assert.equal(calls.fetch.length, 1, 'unchanged picture is not fetched again');
  assert.equal(alice.updates.length, 1);
});

test('a changed picture replaces ours; the user\'s own choice is left alone', async () => {
  const bob = fakeUser('Bob', stored(A), { id: A, path: stored(A) });
  const carol = fakeUser('Carol', 'x/own.png', { id: A, path: stored(A) });
  const { sync } = fakeWorld({
    users: { f1: bob, f2: carol }, existing: [stored(A)], bodies: { [B]: png() },
  });
  await sync.apply([member('c1', link(B)), member('c2', link(B))], { c1: 'f1', c2: 'f2' }, keyOf);
  assert.equal(bob.avatar, stored(B));
  assert.equal(carol.avatar, 'x/own.png');
  assert.equal(carol.updates.length, 0);
});

test('removing the picture in Chronicle puts the placeholder back, only on ours', async () => {
  const dan = fakeUser('Dan', stored(A), { id: A, path: stored(A) });
  const { sync } = fakeWorld({ users: { f1: dan }, existing: [stored(A)] });
  await sync.apply([member('c1', undefined)], { c1: 'f1' }, keyOf);
  assert.equal(dan.avatar, DEF);
  assert.equal(dan.flag, null);
});

test('rejected pictures change nothing', async () => {
  for (const [name, body, url] of [
    ['svg', new Blob(['<svg/>'], { type: 'image/svg+xml' }), link(A)],
    ['too big', png(6 * 1024 * 1024), link(A)],
    ['not found', null, link(A)],
    ['other host', png(), `https://evil.example/media/${A}/thumb/300`],
  ]) {
    const eve = fakeUser('Eve', DEF);
    const { sync, calls } = fakeWorld({ users: { f1: eve }, bodies: body ? { [A]: body } : {} });
    await sync.apply([member('c1', url)], { c1: 'f1' }, keyOf);
    assert.equal(eve.avatar, DEF, name);
    assert.equal(calls.upload.length, 0, name);
    if (name === 'other host') assert.equal(calls.fetch.length, 0, name);
  }
});

test('only the GM, and only matched users', async () => {
  const frank = fakeUser('Frank', DEF);
  const asPlayer = fakeWorld({ users: { f1: frank }, bodies: { [A]: png() }, isGM: false });
  await asPlayer.sync.apply([member('c1', link(A))], { c1: 'f1' }, keyOf);
  assert.equal(frank.updates.length, 0);

  const gm = fakeWorld({ users: { f1: frank }, bodies: { [A]: png() } });
  await gm.sync.apply([member('c9', link(A))], { c1: 'f1' }, keyOf);
  assert.equal(frank.updates.length, 0, 'unmapped member');
  assert.equal(gm.calls.fetch.length, 0);
});
