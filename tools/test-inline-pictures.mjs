#!/usr/bin/env node
/**
 * Pictures inside Chronicle page text (scripts/_inline-pictures.mjs,
 * scripts/picture-store.mjs): shared pictures point at a local copy in
 * Foundry, GM-only ones go inside a secret block and are never copied, and a
 * push always sends the plain `/media/<uuid>` path back with GM-only intact.
 *
 * Run: node --test tools/test-inline-pictures.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './_journal-test-env.mjs';
import {
  sharedPictureIds, toFoundryPictures, toChroniclePictures, chronicleSrcFor,
  mediaIdFromChronicleSrc, extensionForMime,
} from '../scripts/_inline-pictures.mjs';

const A = '0b6a3f0e-8c1d-4f6a-9a51-2f3c4d5e6f70';
const B = '1c7b4f1f-9d2e-4a7b-8b62-3a4d5e6f7081';
const API = 'https://chronicle.example';
const LOCAL = (id) => `worlds/w1/chronicle-media/${id}.png`;

const shared = (id, cls = 'ce-img ce-img--w40 ce-img--right') =>
  `<figure class="${cls}"><img src="/media/${id}" alt="Mira"><figcaption>Mira Kell</figcaption></figure>`;
const gm = (id) =>
  `<figure class="ce-img ce-img--w30 ce-img--left ce-img--gm"><img src="/media/${id}" alt="x"><figcaption>The traitor</figcaption></figure>`;

test('only pictures outside GM-only figures are copied', () => {
  const html = `<p>a</p>${shared(A)}${gm(B)}<p>b</p>`;
  assert.deepEqual(sharedPictureIds(html), [A]);
  assert.deepEqual(sharedPictureIds(`${shared(A)}${shared(A)}`), [A], 'each id once');
  assert.deepEqual(sharedPictureIds(`<img src="/media/${A}">`), [A], 'a bare picture counts');
  assert.deepEqual(sharedPictureIds(`<img src="/media/../etc">`), [], 'only UUIDs');
  assert.deepEqual(sharedPictureIds(`<img src="https://evil.example/media/${A}">`), [], 'only the plain path');
});

test('pull: a shared picture points at its local copy', () => {
  const out = toFoundryPictures(`<p>a</p>${shared(A)}`, (id) => (id === A ? LOCAL(A) : ''));
  assert.ok(out.includes(`src="${LOCAL(A)}"`), out);
  assert.ok(out.includes('class="ce-img ce-img--w40 ce-img--right"'));
  assert.ok(out.includes('<figcaption>Mira Kell</figcaption>'));
  assert.ok(!out.includes('section'), 'no secret block for a shared picture');
});

test('pull: a picture with no copy yet keeps its Chronicle path', () => {
  const out = toFoundryPictures(shared(A), () => undefined);
  assert.equal(out, shared(A));
});

test('pull: a GM-only picture goes in a secret block and is never swapped', () => {
  const out = toFoundryPictures(`<p>a</p>${gm(B)}<p>b</p>`, () => 'worlds/w1/chronicle-media/should-not-appear.png');
  assert.match(out, /^<p>a<\/p><section class="secret chronicle-gm-picture" id="secret-chr[0-9a-f]{16}\d+"><figure class="ce-img [^"]*ce-img--gm"><img src="\/media\/[^"]+"/);
  assert.ok(out.includes(`src="/media/${B}"`));
  assert.ok(!out.includes('should-not-appear'));
  assert.ok(out.endsWith('</figure></section><p>b</p>'));
  assert.equal(toFoundryPictures(gm(B), () => ''), toFoundryPictures(gm(B), () => ''), 'same block id every pull');
});

test('push: a local copy goes back as the plain Chronicle path', () => {
  const pulled = toFoundryPictures(shared(A), () => LOCAL(A));
  assert.equal(toChroniclePictures(pulled, API), shared(A));
});

test('push: round trip of a GM-only picture is lossless', () => {
  const html = `<p>a</p>${gm(B)}<p>b</p>${shared(A)}`;
  const pulled = toFoundryPictures(html, () => LOCAL(A));
  assert.equal(toChroniclePictures(pulled, API), html);
});

test('push: a picture inside any secret block goes back GM only', () => {
  // Foundry's editor may drop the class, or the GM may put a shared
  // picture into a secret block: either way players must not get it.
  const lost = `<section class="secret" id="secret-x"><figure class="ce-img ce-img--w30"><img src="${LOCAL(B)}"></figure></section>`;
  assert.equal(toChroniclePictures(lost, API), `<figure class="ce-img ce-img--w30 ce-img--gm"><img src="/media/${B}"></figure>`);

  const withText = `<section class="secret revealed" id="secret-y"><p>note</p><figure class="ce-img"><img src="/media/${B}"></figure></section>`;
  const out = toChroniclePictures(withText, API);
  assert.ok(out.includes('ce-img ce-img--gm'), out);
  assert.ok(out.startsWith('<section'), 'a block holding more than the picture stays');
});

test('push: a bare or unclassed picture inside a secret block goes back GM only', () => {
  const inP = `<section class="secret" id="s1"><p><img src="${LOCAL(B)}"></p></section>`;
  assert.equal(toChroniclePictures(inP, API), `<figure class="ce-img ce-img--gm"><img src="/media/${B}"></figure>`);
  const bareWithText = `<section class="secret" id="s2"><p>t</p><img src="/media/${B}"></section>`;
  assert.equal(toChroniclePictures(bareWithText, API), `<section class="secret" id="s2"><p>t</p><figure class="ce-img ce-img--gm"><img src="/media/${B}"></figure></section>`);
  const noClass = `<section class="secret" id="s3"><figure><img src="/media/${B}"><figcaption>x</figcaption></figure></section>`;
  assert.equal(toChroniclePictures(noClass, API), `<figure class="ce-img ce-img--gm"><img src="/media/${B}"><figcaption>x</figcaption></figure>`);
  const foundryOnly = '<section class="secret" id="s4"><p><img src="worlds/w1/maps/x.webp"></p></section>';
  assert.equal(toChroniclePictures(foundryOnly, API), foundryOnly, "Foundry's own pictures are not touched");
});

test('pull: a secret block already in the page is left alone, never nested', () => {
  const kept = `<section class="secret" id="s1"><p>t</p>${gm(B)}${shared(A)}</section>`;
  assert.equal(toFoundryPictures(kept, () => LOCAL(A)), kept);
  assert.deepEqual(sharedPictureIds(kept), [], 'nothing inside a secret block is copied');
});

test('pull: the same GM-only picture twice gets two block ids', () => {
  const ids = [...toFoundryPictures(gm(B) + gm(B), () => '').matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2);
});

test('push: a full or signed Chronicle link goes back as the plain path', () => {
  const signed = `<img src="${API}/media/${A}?expires=1&amp;sig=abc">`;
  assert.equal(toChroniclePictures(signed, API), `<img src="/media/${A}">`);
  assert.equal(toChroniclePictures(`<img src="/media/${A}?expires=1&sig=x">`, API), `<img src="/media/${A}">`);
  const other = `<img src="https://evil.example/media/${A}">`;
  assert.equal(toChroniclePictures(other, API), other, 'another host is left as is');
  const foundryOwn = '<img src="worlds/w1/maps/tavern.webp">';
  assert.equal(toChroniclePictures(foundryOwn, API), foundryOwn, "Foundry's own pictures are left alone");
});

test('src helpers', () => {
  assert.equal(mediaIdFromChronicleSrc(`/media/${A.toUpperCase()}`), A);
  assert.equal(mediaIdFromChronicleSrc(`/media/${A}/thumb/300`), null);
  assert.equal(chronicleSrcFor(`/worlds/w1/chronicle-media/${A}.jpg`, API), `/media/${A}`);
  assert.equal(chronicleSrcFor('', API), null);
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('image/svg+xml'), null, 'never copy SVG');
  assert.equal(extensionForMime('text/html'), null);
});

// --- PictureStore: the copies in the world's files -------------------------

const { PictureStore } = await import('../scripts/picture-store.mjs');

function fakeWorld({ existing = [], meta = {}, bodies = {} } = {}) {
  globalThis.game.settings.get = (_m, k) => (k === 'apiUrl' ? API : '');
  const calls = { get: [], fetch: [], upload: [], mkdir: 0 };
  const picker = {
    browse: async () => {
      if (existing === null) throw new Error('ENOENT');
      return { files: existing };
    },
    createDirectory: async () => { calls.mkdir++; },
    upload: async (_src, dir, file) => {
      calls.upload.push(file.name);
      return { path: `${dir}/${file.name}` };
    },
  };
  const api = {
    get: async (path) => {
      calls.get.push(path);
      const id = path.split('/').pop();
      return meta[id] ?? null;
    },
  };
  const fetchFn = async (url, opts) => {
    calls.fetch.push({ url, opts });
    const id = /media\/([0-9a-f-]{36})/.exec(url)[1];
    const b = bodies[id];
    return b ? { ok: true, blob: async () => b } : { ok: false };
  };
  const store = new PictureStore({ api, worldId: () => 'w1', fetchFn, picker: () => picker });
  return { store, calls };
}

const png = (n = 10) => new Blob([new Uint8Array(n)], { type: 'image/png' });

test('store: copies a picture once and reuses the copy', async () => {
  const { store, calls } = fakeWorld({
    existing: null,
    meta: { [A]: { mime_type: 'image/png', file_size: 10, url: `/media/${A}?expires=9&sig=s` } },
    bodies: { [A]: png() },
  });
  const first = await store.ensure([A]);
  assert.equal(first.get(A), `worlds/w1/chronicle-media/${A}.png`);
  assert.equal(calls.fetch[0].url, `${API}/media/${A}?expires=9&sig=s`);
  assert.equal(calls.fetch[0].opts.credentials, 'omit');
  assert.equal(calls.mkdir, 1);
  await store.ensure([A]);
  assert.equal(calls.upload.length, 1, 'second pull reuses the copy');
});

test('store: an existing copy in the folder is found without fetching', async () => {
  const { store, calls } = fakeWorld({ existing: [`worlds/w1/chronicle-media/${A}.webp`] });
  const got = await store.ensure([A]);
  assert.equal(got.get(A), `worlds/w1/chronicle-media/${A}.webp`);
  assert.equal(calls.get.length, 0);
});

test('store: refuses what is not a plain picture, too big, or off-host', async () => {
  const big = 26 * 1024 * 1024;
  const { store, calls } = fakeWorld({
    existing: [],
    meta: {
      [A]: { mime_type: 'image/svg+xml', file_size: 10, url: `/media/${A}` },
      [B]: { mime_type: 'image/png', file_size: big, url: `/media/${B}` },
    },
  });
  assert.equal((await store.ensure([A, B, 'not-a-uuid'])).size, 0);
  assert.equal(calls.fetch.length, 0);

  const off = fakeWorld({
    existing: [],
    meta: { [A]: { mime_type: 'image/png', file_size: 10, url: `https://evil.example/media/${A}` } },
    bodies: { [A]: png() },
  });
  assert.equal((await off.store.ensure([A])).size, 0);
  assert.equal(off.calls.fetch.length, 0, 'never fetches another host');

  const lying = fakeWorld({
    existing: [],
    meta: { [A]: { mime_type: 'image/png', file_size: 10, url: `/media/${A}` } },
    bodies: { [A]: new Blob(['<html>'], { type: 'text/html' }) },
  });
  assert.equal((await lying.store.ensure([A])).size, 0, 'the served type must match');
  assert.equal(lying.calls.upload.length, 0);
});

test('store: a failed copy never throws and is retried next time', async () => {
  const w = fakeWorld({ existing: [], meta: { [A]: { mime_type: 'image/png', file_size: 10, url: `/media/${A}` } } });
  assert.equal((await w.store.ensure([A])).size, 0);
  w.calls.fetch.length = 0;
  await w.store.ensure([A]);
  assert.equal(w.calls.fetch.length, 1, 'retried');
});

test('store: signed links for the GM screen are reused for a while', async () => {
  const w = fakeWorld({ meta: { [B]: { mime_type: 'image/png', url: `/media/${B}?expires=9&sig=s` } } });
  assert.equal(await w.store.signedLink(B), `${API}/media/${B}?expires=9&sig=s`);
  await w.store.signedLink(B);
  assert.equal(w.calls.get.length, 1);
  assert.equal(await w.store.signedLink('../x'), '');
});

test('with the GM-only text pass: pull then push gives Chronicle back exactly what it sent', async () => {
  const { toFoundrySecrets, toChronicleSecrets } = await import('../scripts/_gm-secrets.mjs');
  const html = `<p>Mira <span data-secret="true">is the spy</span> runs docks.</p>${shared(A)}${gm(B)}<p>end</p>`;
  const pulled = toFoundryPictures(toFoundrySecrets(html), (id) => LOCAL(id));
  assert.ok(pulled.includes(`src="${LOCAL(A)}"`));
  assert.ok(!pulled.includes(LOCAL(B)), 'the GM-only picture is not swapped for a copy');
  assert.equal(sharedPictureIds(toFoundrySecrets(html)).join(), A);
  assert.equal(toChronicleSecrets(toChroniclePictures(pulled, API)), html);
});
