/**
 * The blank pictures used to overwrite a stored copy that must stop showing
 * anything: each is a real picture in the format its file name says, so
 * Foundry accepts the upload under that name.
 *
 * Run: node --test tools/test-blank-picture.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import './_journal-test-env.mjs';

const { blankPicture } = await import('../scripts/_blank-picture.mjs');
const { PictureStore } = await import('../scripts/picture-store.mjs');

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  webp: [0x52, 0x49, 0x46, 0x46],
  avif: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],
};

test('every copied format has a blank with its own signature and type', () => {
  for (const [ext, magic] of Object.entries(MAGIC)) {
    const blank = blankPicture(ext);
    assert.ok(blank, ext);
    assert.deepEqual([...blank.bytes.slice(0, magic.length)], magic, ext);
    assert.match(blank.mime, /^image\//);
    assert.ok(blank.bytes.length < 600, `${ext} stays tiny`);
  }
  assert.equal(blankPicture('JPG').mime, 'image/jpeg');
  assert.equal(blankPicture('svg'), null);
  assert.equal(blankPicture(''), null);
});

const ID = '0b5e8c1a-1111-4222-8333-944455556666';

function store(uploads) {
  return new PictureStore({
    api: {},
    worldId: () => 'w1',
    picker: () => ({
      upload: async (_s, dir, file) => {
        uploads.push({ dir, name: file.name, type: file.type });
        return { path: `${dir}/${file.name}` };
      },
    }),
  });
}

test('retire overwrites only a copy in its own folder', async () => {
  const uploads = [];
  const s = store(uploads);
  assert.equal(await s.retire(`worlds/w1/chronicle-media/${ID}.webp?x=1`), ID);
  assert.deepEqual(uploads, [{ dir: 'worlds/w1/chronicle-media', name: `${ID}.webp`, type: 'image/webp' }]);
  for (const bad of [
    `worlds/w2/chronicle-media/${ID}.png`,
    `worlds/w1/chronicle-media/../x/${ID}.png`,
    `worlds/w1/chronicle-media/${ID}.svg`,
    'worlds/w1/chronicle-media/not-an-id.png',
    'chronicle-sync/maps/map-1-abc.jpg',
    '',
  ]) {
    assert.equal(await s.retire(bad), null, bad);
  }
  assert.equal(uploads.length, 1);
});
