#!/usr/bin/env node
/**
 * A hero's portrait and token chosen in Foundry go to Chronicle; stock
 * pictures, outside addresses and files sync itself wrote never do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorldFile, picturesToPush, sendablePicture, pictureName, sentFlag, changesPictures } from '../scripts/_hero-picture-push.mjs';

test('only files in this Foundry install are read', () => {
  for (const p of ['worlds/w/heroes/tyne.webp', 'images/Generic%20NPCs/Misc%20Humanoid.png', 'modules/x/a.png']) assert.ok(isWorldFile(p), p);
  for (const p of ['', 'https://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,AA', 'worlds/../../etc/a.png', 'javascript:alert(1)']) assert.ok(!isWorldFile(p), p);
});

test('which pictures are sent', () => {
  const cases = [
    ['a chosen portrait, same token', { img: 'worlds/w/tyne.png', token: 'worlds/w/tyne.png' }, [['img', 'worlds/w/tyne.png'], ['token', 'worlds/w/tyne.png']]],
    ['a portrait and its own token', { img: 'worlds/w/tyne.png', token: 'worlds/w/tyne-token.png' }, [['img', 'worlds/w/tyne.png'], ['token', 'worlds/w/tyne-token.png']]],
    ['the stock pictures', { img: 'icons/svg/mystery-man.svg', token: 'systems/draw-steel/assets/hero.webp' }, []],
    ['a stock portrait with a chosen token', { img: 'icons/svg/mystery-man.svg', token: 'worlds/w/t.png' }, [['token', 'worlds/w/t.png']]],
    ['files sync wrote from Chronicle', { img: 'worlds/w/chronicle-pictures/a.png', token: 'worlds/w/chronicle-pictures/b.png', applied: { imgPath: 'worlds/w/chronicle-pictures/a.png', tokenPath: 'worlds/w/chronicle-pictures/b.png' } }, []],
    ['a picture already sent', { img: 'worlds/w/tyne.png', token: 'worlds/w/tyne.png', applied: { img: 'm1', imgPath: 'worlds/w/tyne.png', token: 'm1', tokenPath: 'worlds/w/tyne.png' } }, []],
    ['a new portrait after one was sent', { img: 'worlds/w/tyne2.png', token: 'worlds/w/t.png', applied: { img: 'm1', imgPath: 'worlds/w/tyne.png', token: 'm2', tokenPath: 'worlds/w/t.png' } }, [['img', 'worlds/w/tyne2.png']]],
    ['another site\'s picture', { img: 'https://cdn.example.com/tyne.png' }, []],
  ];
  for (const [name, input, want] of cases) {
    assert.deepEqual(picturesToPush(input).map((p) => [p.role, p.path]), want, name);
  }
});

test('only a raster picture within the size limit is sent', () => {
  assert.ok(sendablePicture({ type: 'image/webp', size: 10 }, 100));
  assert.ok(sendablePicture({ type: 'image/png; charset=binary', size: 10 }, 100));
  assert.ok(!sendablePicture({ type: 'image/svg+xml', size: 10 }, 100), 'an SVG can carry script');
  assert.ok(!sendablePicture({ type: 'text/html', size: 10 }, 100));
  assert.ok(!sendablePicture({ type: 'image/png', size: 101 }, 100));
  assert.ok(!sendablePicture({ type: 'image/png', size: 0 }, 100));
  assert.ok(!sendablePicture(null, 100));
});

test('the upload name and the flag', () => {
  assert.equal(pictureName('worlds/w/heroes/tyne.webp?v=2'), 'tyne.webp');
  assert.deepEqual(sentFlag({ token: 't1', tokenPath: 'a.png' }, 'img', 'm1', 'b.png'),
    { 'flags.chronicle-sync.heroPictures': { token: 't1', tokenPath: 'a.png', img: 'm1', imgPath: 'b.png' } });
});

test('a portrait or token change is a picture change; anything else is not', () => {
  assert.ok(changesPictures({ img: 'worlds/w/a.png' }));
  assert.ok(changesPictures({ prototypeToken: { texture: { src: 'worlds/w/a.png' } } }));
  assert.ok(!changesPictures({ prototypeToken: { hidden: true } }));
  assert.ok(!changesPictures({ system: { hero: { victories: 2 } } }));
  assert.ok(!changesPictures(undefined));
});
