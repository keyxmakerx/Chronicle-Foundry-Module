#!/usr/bin/env node
/**
 * Token art on hover: which picture a token shows, to whom, and where the
 * preview sits beside the cursor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_TOKEN } from '../scripts/_creature-pictures.mjs';
import { SECRET_DISPOSITION, hoverArtFor, previewPlace, tokenArt } from '../scripts/_hover-art.mjs';

const ART = 'worlds/w/chronicle/abc.webp';
const TOKEN = 'worlds/w/chronicle/def.webp';
const base = { actorImg: ART, tokenSrc: TOKEN, isGM: false, worldOn: true, clientOn: true };

test('a real portrait that differs from the token is the art', () => {
  assert.equal(tokenArt({ actorImg: ART, tokenSrc: TOKEN }), ART);
});

test('nothing to show when the portrait is the token, stock or generic', () => {
  for (const actorImg of [TOKEN, '', undefined, 'icons/svg/mystery-man.svg', 'systems/draw-steel/assets/x.webp', GENERIC_TOKEN]) {
    assert.equal(tokenArt({ actorImg, tokenSrc: TOKEN }), '', String(actorImg));
  }
});

test('a player sees the art of a visible token', () => {
  assert.equal(hoverArtFor(base), ART);
});

test('each person, the GM world switch and the token switch can turn it off', () => {
  assert.equal(hoverArtFor({ ...base, clientOn: false }), '');
  assert.equal(hoverArtFor({ ...base, worldOn: false }), '');
  assert.equal(hoverArtFor({ ...base, flag: false }), '');
  assert.equal(hoverArtFor({ ...base, flag: undefined }), ART);
});

test('hidden and Secret tokens keep their art from players, not from the GM', () => {
  assert.equal(hoverArtFor({ ...base, hidden: true }), '');
  assert.equal(hoverArtFor({ ...base, disposition: SECRET_DISPOSITION }), '');
  assert.equal(hoverArtFor({ ...base, isGM: true, hidden: true }), ART);
  assert.equal(hoverArtFor({ ...base, isGM: true, disposition: SECRET_DISPOSITION }), ART);
});

test('the GM switch for a token also holds for the GM', () => {
  assert.equal(hoverArtFor({ ...base, isGM: true, flag: false }), '');
});

const view = { width: 1000, height: 800 };
const box = { width: 200, height: 260 };

test('the preview sits below and right of the cursor', () => {
  assert.deepEqual(previewPlace({ x: 100, y: 100 }, box, view, 18), { left: 118, top: 118 });
});

test('near the right and bottom edges it flips to the other side', () => {
  assert.deepEqual(previewPlace({ x: 900, y: 700 }, box, view, 18), { left: 682, top: 422 });
});

test('it never leaves the window', () => {
  const p = previewPlace({ x: 5, y: 5 }, { width: 1200, height: 900 }, view, 18);
  assert.deepEqual(p, { left: 0, top: 0 });
});
