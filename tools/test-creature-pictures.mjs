#!/usr/bin/env node
/**
 * Creature pictures (scripts/_creature-pictures.mjs): which picture each role
 * takes, and that a picture is written only when Chronicle's choice changes.
 *
 * Run: `node --test tools/test-creature-pictures.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  mediaId, pictureChoice, pictureIds, picturePlan, isStockPicture, GENERIC_TOKEN, PICTURES_FLAG,
} from '../scripts/_creature-pictures.mjs';

const A = '0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f';
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const FLAG = `flags.chronicle-sync.${PICTURES_FLAG}`;
const local = new Map([[A, 'worlds/w/chronicle-media/' + A + '.png'], [T, 'worlds/w/chronicle-media/' + T + '.webp']]);

test('only a media id is read, old dated paths included', () => {
  assert.equal(mediaId(A.toUpperCase()), A);
  assert.equal(mediaId('2026/03/' + A + '.jpg'), A);
  for (const bad of ['', null, 'https://evil.example/x.png', '../' + A + '/x', 'javascript:alert(1)']) assert.equal(mediaId(bad), '');
});

test('the portrait prefers the art and the token the token, each falling back', () => {
  assert.deepEqual(pictureChoice({ image_path: A, fields_data: { token_image: T } }), { img: A, token: T });
  assert.deepEqual(pictureChoice({ image_path: A, fields_data: {} }), { img: A, token: A });
  assert.deepEqual(pictureChoice({ fields_data: { token_image: T } }), { img: T, token: T });
  assert.deepEqual(pictureChoice({ fields_data: {} }), { img: 'generic', token: 'generic' });
  assert.deepEqual(pictureIds({ img: A, token: A }), [A]);
  assert.deepEqual(pictureIds({ img: 'generic', token: 'generic' }), []);
});

test('a new actor gets both pictures and the record of them', () => {
  const ch = picturePlan({ choice: { img: A, token: T }, local, applied: null, current: null });
  assert.equal(ch.img, local.get(A));
  assert.equal(ch['prototypeToken.texture.src'], local.get(T));
  assert.deepEqual(ch[FLAG], { img: A, token: T });
  const none = picturePlan({ choice: { img: 'generic', token: 'generic' }, local: new Map(), applied: null, current: null });
  assert.equal(none.img, GENERIC_TOKEN);
  assert.equal(none['prototypeToken.texture.src'], GENERIC_TOKEN);
});

test('nothing is written while Chronicle’s choice is unchanged, so a GM’s swap stays', () => {
  assert.deepEqual(picturePlan({ choice: { img: A, token: T }, local, applied: { img: A, token: T }, current: { img: 'x.png', token: 'mine.png' } }), {});
});

test('a changed token replaces only the token', () => {
  const ch = picturePlan({ choice: { img: A, token: T }, local, applied: { img: A, token: A }, current: { img: 'a', token: 'b' } });
  assert.deepEqual(Object.keys(ch).sort(), [FLAG, 'prototypeToken.texture.src'].sort());
  assert.deepEqual(ch[FLAG], { img: A, token: T });
});

test('a picture that could not be copied is left as it is and retried later', () => {
  const ch = picturePlan({ choice: { img: A, token: T }, local: new Map([[A, local.get(A)]]), applied: null, current: null });
  assert.equal(ch['prototypeToken.texture.src'], undefined);
  assert.deepEqual(ch[FLAG], { img: A });
});

test('an actor from before keeps a picture its GM chose, and takes the next change', () => {
  const kept = picturePlan({ choice: { img: A, token: A }, local, applied: null, current: { img: 'tokens/goblin.webp', token: 'icons/svg/mystery-man.svg' } });
  assert.equal(kept.img, undefined, 'the GM’s portrait stays');
  assert.equal(kept['prototypeToken.texture.src'], local.get(A), 'the stock token is replaced');
  assert.deepEqual(kept[FLAG], { img: A, token: A });
  const later = picturePlan({ choice: { img: T, token: A }, local, applied: kept[FLAG], current: { img: 'tokens/goblin.webp', token: local.get(A) } });
  assert.equal(later.img, local.get(T));
});

test('stock pictures are the empty, mystery-man and system defaults', () => {
  for (const p of ['', null, 'icons/svg/mystery-man.svg', 'systems/draw-steel/assets/npc.webp']) assert.ok(isStockPicture(p), String(p));
  assert.ok(!isStockPicture('worlds/w/goblin.png'));
});

test('the generic token ships with the module', () => {
  const file = new URL('../' + GENERIC_TOKEN.replace('modules/chronicle-sync/', ''), import.meta.url);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.equal(JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8')).id, 'chronicle-sync');
});
