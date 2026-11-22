#!/usr/bin/env node
/**
 * Hero pictures (scripts/_hero-pictures.mjs): which picture each role takes,
 * and that only a stock or sync-written picture is ever replaced.
 *
 * Run: `node --test tools/test-hero-pictures.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { heroChoice, heroPictureIds, heroPicturePlan, HERO_PICTURES_FLAG } from '../scripts/_hero-pictures.mjs';

const A = '0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f';
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const FLAG = `flags.chronicle-sync.${HERO_PICTURES_FLAG}`;
const PA = `worlds/w/chronicle-media/${A}.png`;
const PT = `worlds/w/chronicle-media/${T}.webp`;
const local = new Map([[A, PA], [T, PT]]);
const STOCK = 'icons/svg/mystery-man.svg';

test('the choice per entity', () => {
  const rows = [
    [{ image_path: A, fields_data: { token_image: T } }, { img: A, token: T }],
    [{ image_path: A }, { img: A, token: A }],
    [{ fields_data: { token_image: T } }, { img: T, token: T }],
    [{ image_path: 'https://evil.example/x.png' }, { img: '', token: '' }],
    [{ image_path: '' }, { img: '', token: '' }],
    [null, { img: '', token: '' }],
  ];
  for (const [entity, want] of rows) assert.deepEqual(heroChoice(entity), want);
  assert.deepEqual(heroPictureIds({ img: A, token: A }), [A]);
  assert.deepEqual(heroPictureIds({ img: '', token: '' }), []);
});

test('a new actor gets both pictures and the record', () => {
  const ch = heroPicturePlan({ choice: { img: A, token: T }, local, applied: null, current: null });
  assert.equal(ch.img, PA);
  assert.equal(ch['prototypeToken.texture.src'], PT);
  assert.deepEqual(ch[FLAG], { img: A, token: T, imgPath: PA, tokenPath: PT });
});

test('stock pictures are replaced', () => {
  const ch = heroPicturePlan({ choice: { img: A, token: A }, local, applied: null, current: { img: STOCK, token: STOCK } });
  assert.equal(ch.img, PA);
  assert.equal(ch['prototypeToken.texture.src'], PA);
});

test('a hand-set picture stays, even when the choice changes later', () => {
  const first = heroPicturePlan({ choice: { img: A, token: A }, local, applied: null, current: { img: 'worlds/w/mine.png', token: STOCK } });
  assert.equal(first.img, undefined);
  assert.equal(first['prototypeToken.texture.src'], PA);
  const later = heroPicturePlan({ choice: { img: T, token: A }, local, applied: first[FLAG], current: { img: 'worlds/w/mine.png', token: PA } });
  assert.equal(later.img, undefined, 'still the GM’s');
  assert.equal(later[FLAG].img, T);
});

test('a picture sync wrote is replaced when Chronicle changes it, a swapped one is not', () => {
  const applied = { img: A, token: A, imgPath: PA, tokenPath: PA };
  const ch = heroPicturePlan({ choice: { img: T, token: T }, local, applied, current: { img: PA, token: 'worlds/w/swapped.png' } });
  assert.equal(ch.img, PT);
  assert.equal(ch['prototypeToken.texture.src'], undefined);
});

test('nothing is written while the choice is unchanged', () => {
  const applied = { img: A, token: T, imgPath: PA, tokenPath: PT };
  assert.deepEqual(heroPicturePlan({ choice: { img: A, token: T }, local, applied, current: { img: STOCK, token: STOCK } }), {});
});

test('an empty choice does nothing, and a failed copy is left for next time', () => {
  assert.deepEqual(heroPicturePlan({ choice: { img: '', token: '' }, local, applied: null, current: { img: STOCK, token: STOCK } }), {});
  const ch = heroPicturePlan({ choice: { img: A, token: T }, local: new Map([[A, PA]]), applied: null, current: null });
  assert.equal(ch['prototypeToken.texture.src'], undefined);
  assert.deepEqual(ch[FLAG], { img: A, imgPath: PA });
});
