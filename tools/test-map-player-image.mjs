/**
 * The player copy of a shadowed map picture: the page every player reads
 * must point only at the stored copy, never at the original, including when
 * fetching or storing the copy fails, on the signed-URL refresh, and on
 * map events that don't carry `player_image_url`.
 *
 * Run: node --test tools/test-map-player-image.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { apiUrl: 'http://localhost:8080', campaignId: 'camp-1' };

globalThis.foundry = globalThis.foundry || {
  applications: {
    api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b },
  },
};
globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = globalThis.ui || { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game = globalThis.game || {
  settings: {
    get: (_mod, key) => settings[key],
    set: (_mod, key, val) => { settings[key] = val; },
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  user: { id: 'gm1', isGM: true },
  journal: { contents: [] },
};

const uploads = [];
let uploadFails = false;
globalThis.FilePicker = {
  browse: async () => ({ files: [] }),
  createDirectory: async () => { throw new Error('EEXIST'); },
  upload: async (source, dir, file) => {
    if (uploadFails) throw new Error('disk full');
    uploads.push({ source, dir, name: file.name });
    return { status: 'success', path: `${dir}/${file.name}` };
  },
};

const {
  parsePlayerImageUrl, playerImageFileName, shadowSignature,
} = await import('../scripts/_map-player-image.mjs');
const { MapSync } = await import('../scripts/map-sync.mjs');
const { FLAG_SCOPE } = await import('../scripts/constants.mjs');

const ORIGINAL = 'http://localhost:8080/media/orig.png?sig=abc';
const PLAYER_URL = '/api/v1/campaigns/camp-1/maps/map-1/player-image?v=0123abcd0123abcd';
const STORED = 'chronicle-sync/maps/map-1-0123abcd0123abcd.jpg';

function makePage({ src = ORIGINAL, meta = {} } = {}) {
  const flags = { [FLAG_SCOPE]: { mapId: 'map-1', chronicleMapMeta: meta } };
  const page = {
    id: 'page-1', name: 'Test Map', src,
    parent: { id: 'entry-1', name: 'Test Map', update: async () => {} },
    updates: [],
    getFlag: (scope, key) => flags[scope]?.[key],
    async update(data) {
      page.updates.push(data);
      for (const [k, v] of Object.entries(data)) {
        const prefix = `flags.${FLAG_SCOPE}.`;
        if (k.startsWith(prefix)) flags[FLAG_SCOPE][k.slice(prefix.length)] = v;
        else if (k !== 'flags.core.sheetClass') page[k] = v;
      }
    },
  };
  return page;
}

function makeSync(page, { blobFails = false, row = null } = {}) {
  const ms = new MapSync();
  ms._ensureMapsFolder = async () => ({ id: 'folder-1' });
  ms.findPageByMapId = () => page;
  ms.blobCalls = [];
  ms._api = {
    getBlob: async (path) => {
      ms.blobCalls.push(path);
      if (blobFails) throw new Error('500');
      return new Blob(['jpeg'], { type: 'image/jpeg' });
    },
    get: async (path) => {
      if (path === '/maps/map-1' && row) return row;
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return ms;
}

const SHADOWED_ROW = {
  id: 'map-1', name: 'Test Map', image_url: ORIGINAL, image_id: 'med-1', player_image_url: PLAYER_URL,
};

/** No string anywhere in what players can read may carry the original. */
function assertNoOriginal(page) {
  const seen = JSON.stringify({ src: page.src, meta: page.getFlag(FLAG_SCOPE, 'chronicleMapMeta') });
  assert.ok(!seen.includes('orig.png'), `players' copy leaks the original: ${seen}`);
  assert.ok(!seen.includes('med-1'), `players' copy leaks the media id: ${seen}`);
}

test('parsePlayerImageUrl: accepts only this campaign and map', () => {
  assert.deepEqual(parsePlayerImageUrl(PLAYER_URL, 'camp-1', 'map-1'),
    { path: '/maps/map-1/player-image?v=0123abcd0123abcd', version: '0123abcd0123abcd' });
  assert.equal(parsePlayerImageUrl(PLAYER_URL, 'camp-2', 'map-1'), null);
  assert.equal(parsePlayerImageUrl(PLAYER_URL, 'camp-1', 'map-2'), null);
  assert.equal(parsePlayerImageUrl('/api/v1/campaigns/camp-1/maps/map-1/player-image?v=a&x=1', 'camp-1', 'map-1'), null);
  assert.equal(parsePlayerImageUrl('https://evil/api/v1/campaigns/camp-1/maps/map-1/player-image?v=a', 'camp-1', 'map-1'), null);
  assert.equal(parsePlayerImageUrl(undefined, 'camp-1', 'map-1'), null);
});

test('playerImageFileName refuses anything that is not a plain name', () => {
  assert.equal(playerImageFileName('map-1', 'abc'), 'map-1-abc.jpg');
  assert.equal(playerImageFileName('../x', 'abc'), null);
  assert.equal(playerImageFileName('map-1', 'a/b'), null);
});

test('shadowSignature ignores order and changes with any corner', () => {
  const a = { minX: 1, minY: 2, maxX: 3, maxY: 4 };
  const b = { minX: 5, minY: 6, maxX: 7, maxY: 8 };
  assert.equal(shadowSignature([a, b]), shadowSignature([b, a]));
  assert.notEqual(shadowSignature([a]), shadowSignature([{ ...a, maxY: 5 }]));
  assert.equal(shadowSignature([]), '');
});

test('shadowed map: page points at the stored copy; GM viewer still gets the original', async () => {
  uploads.length = 0;
  const page = makePage();
  const ms = makeSync(page);
  await ms._materializeMap(SHADOWED_ROW);
  assert.equal(page.src, STORED);
  assert.equal(page.getFlag(FLAG_SCOPE, 'chronicleMapMeta').image_url, STORED);
  assert.equal(page.getFlag(FLAG_SCOPE, 'chronicleMapMeta').player_image, true);
  assertNoOriginal(page);
  assert.deepEqual(ms.blobCalls, ['/maps/map-1/player-image?v=0123abcd0123abcd']);
  assert.equal(uploads.length, 1);
  assert.equal(ms.getMapData(page).meta.image_url, ORIGINAL);
});

test('shadowed map: an already-stored version is not fetched again', async () => {
  const page = makePage({ src: STORED });
  const ms = makeSync(page);
  await ms._materializeMap(SHADOWED_ROW);
  assert.equal(page.src, STORED);
  assert.deepEqual(ms.blobCalls, []);
});

test('shadowed map: fetch failure never falls back to the original', async () => {
  const page = makePage();
  const ms = makeSync(page, { blobFails: true });
  await ms._materializeMap(SHADOWED_ROW);
  assert.equal(page.src, '');
  assertNoOriginal(page);
});

test('shadowed map: store failure shows no picture, not an older copy that may miss a new shadow', async () => {
  uploadFails = true;
  try {
    const page = makePage({ src: 'chronicle-sync/maps/map-1-oldversion.jpg' });
    const ms = makeSync(page);
    await ms._materializeMap(SHADOWED_ROW);
    assert.equal(page.src, '');
    assertNoOriginal(page);
  } finally {
    uploadFails = false;
  }
});

test('shadowed map: an address for another map is refused, not fetched', async () => {
  const page = makePage();
  const ms = makeSync(page);
  await ms._materializeMap({ ...SHADOWED_ROW, player_image_url: '/api/v1/campaigns/camp-1/maps/map-9/player-image?v=a' });
  assert.deepEqual(ms.blobCalls, []);
  assertNoOriginal(page);
});

test('no player_image_url (no shadow, or an older server): the original is used as before', async () => {
  const page = makePage({ src: STORED, meta: { player_image: true } });
  const ms = makeSync(page);
  await ms._materializeMap({ id: 'map-1', name: 'Test Map', image_url: ORIGINAL });
  assert.equal(page.src, ORIGINAL);
  assert.equal(page.getFlag(FLAG_SCOPE, 'chronicleMapMeta').player_image, false);
});

test('_refreshMapImage never writes the original onto a shadowed page', async () => {
  const page = makePage();
  const ms = makeSync(page);
  await ms._materializeMap(SHADOWED_ROW);
  ms._resolveMediaUrl = async () => 'http://localhost:8080/media/orig.png?sig=fresh';
  page.updates.length = 0;
  await ms._refreshMapImage('map-1');
  assert.deepEqual(page.updates, []);
  assert.equal(ms.getMapData(page).meta.image_url, 'http://localhost:8080/media/orig.png?sig=fresh');
});

test('_refreshMapImage also skips a shadowed page after a reload (no GM memory)', async () => {
  const page = makePage({ src: STORED, meta: { image_id: null, player_image: true, image_url: STORED } });
  const ms = makeSync(page);
  ms._resolveMediaUrl = async () => { throw new Error('must not resolve'); };
  await ms._refreshMapImage('map-1');
  assert.deepEqual(page.updates, []);
});

test('map.updated without the field re-reads the row before touching the page', async () => {
  const page = makePage();
  const ms = makeSync(page, { row: SHADOWED_ROW });
  await ms._onMapUpdated({ id: 'map-1', name: 'Test Map', image_url: ORIGINAL });
  assert.equal(page.src, STORED);
  assertNoOriginal(page);
});

test('map.updated whose re-read fails leaves the page alone', async () => {
  const page = makePage({ src: STORED, meta: { player_image: true, image_url: STORED } });
  const ms = makeSync(page);
  await ms._onMapUpdated({ id: 'map-1', name: 'Test Map', image_url: ORIGINAL });
  assert.deepEqual(page.updates, []);
});

test('map.created whose re-read fails creates nothing (the next full sync does)', async () => {
  const ms = makeSync(null);
  let created = 0;
  globalThis.JournalEntry = { create: async () => { created++; return null; } };
  await ms._onMapCreated({ id: 'map-1', name: 'Test Map', image_url: ORIGINAL });
  assert.equal(created, 0);
});

test('a new shadow takes the original off the page before the slow fetch', async () => {
  const page = makePage({ meta: { image_url: ORIGINAL, image_id: 'med-1' } });
  const ms = makeSync(page);
  ms._shadowSigs.set('map-1', '');
  let srcDuringFetch = null;
  ms._refreshMapRow = async () => { srcDuringFetch = page.src; assertNoOriginal(page); };
  await ms._noteShadows('map-1', [{ drawing_type: 'shadow', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] }]);
  assert.equal(srcDuringFetch, '');
  assert.equal(ms.getMapData(page).meta.image_url, ORIGINAL, 'the GM still sees the original');
});

test('a failed re-read after a shadow edit is retried on the next poll, page stays blank', async () => {
  const page = makePage({ meta: { image_url: ORIGINAL, image_id: 'med-1' } });
  const ms = makeSync(page);
  ms._shadowSigs.set('map-1', '');
  let reads = 0;
  ms._refreshMapRow = async () => { reads++; throw new Error('503'); };
  const shadow = { drawing_type: 'shadow', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };
  await ms._noteShadows('map-1', [shadow]);
  await ms._noteShadows('map-1', [shadow]);
  assert.equal(reads, 2);
  assertNoOriginal(page);
});

test('known shadows but a row without the field: no picture for players', async () => {
  const page = makePage();
  const ms = makeSync(page);
  ms._shadowSigs.set('map-1', '1,1,5,5');
  await ms._materializeMap({ id: 'map-1', name: 'Test Map', image_url: ORIGINAL, image_id: 'med-1' });
  assert.equal(page.src, '');
  assertNoOriginal(page);
});

test('a shadow edit seen in the drawing list re-reads the map row', async () => {
  const page = makePage();
  const ms = makeSync(page, { row: SHADOWED_ROW });
  let reads = 0;
  ms._refreshMapRow = async () => { reads++; };
  const shadow = { id: 'sh', drawing_type: 'shadow', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };
  await ms._noteShadows('map-1', []); // first sight, no shadows: nothing to do
  assert.equal(reads, 0);
  await ms._noteShadows('map-1', [shadow]);
  assert.equal(reads, 1);
  await ms._noteShadows('map-1', [shadow]); // unchanged
  assert.equal(reads, 1);
  await ms._noteShadows('map-1', []); // removed
  assert.equal(reads, 2);
});

test('removing the last shadow brings the original back', async () => {
  const page = makePage({ src: STORED, meta: { player_image: true, image_url: STORED } });
  const ms = makeSync(page, { row: { id: 'map-1', name: 'Test Map', image_url: ORIGINAL } });
  ms._shadowSigs.set('map-1', '1,1,5,5');
  await ms._noteShadows('map-1', []);
  assert.equal(page.src, ORIGINAL);
  assert.equal(page.getFlag(FLAG_SCOPE, 'chronicleMapMeta').player_image, false);
});
