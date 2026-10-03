#!/usr/bin/env node
/**
 * `_map-flag-filter.mjs` is what keeps restricted map sub-resources out of
 * JournalEntry page flags, which Foundry syncs to every client with
 * observer access — there is no per-recipient delivery for page flags, so
 * anything written there is readable by every observer regardless of
 * render-time filtering.
 *
 * Covers:
 *   - `isMarkerSafeForPlayerFlags` / `isDrawingSafeForPlayerFlags`: the
 *     shared `visibility`/`visibility_rules` predicate, including the wire
 *     format (`visibility_rules` is a JSON *string*, not a nested object),
 *     the JSON-array shape (not the `{allowed_users, denied_users}`
 *     object), and fail-closed behavior on malformed input.
 *   - `isTokenSafeForPlayerFlags`: the `is_hidden`-only predicate, also
 *     fail-closed on malformed input.
 *   - `MapSync._refreshPageFlags` uses all three helpers (not a bare
 *     `visibility`/`is_visible`/`is_hidden` check, and not an unfiltered
 *     token write) so a live write is actually filtered.
 *   - `MapSync._materializeMap`'s existing-page path reconciles markers,
 *     drawings, and tokens an older module version already wrote into
 *     flags — the next sync (GM login, "Resync All Maps", or any
 *     marker/drawing/token/layer event) strips them instead of leaving
 *     them until a viewer opens.
 *   - Shadow areas (`drawing_type: "shadow"`): pins under one, drawings
 *     wholly under one, and the shadow drawings themselves stay out of the
 *     player copy, on live writes and on the stored-flags reconcile; a
 *     failed drawing fetch leaves the stored copy alone.
 *   - `userCanSeeMarker`: the viewer's render-time check honors the
 *     wire-format (JSON string) per-user rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --- Foundry global stubs (must exist before importing map-sync.mjs) ---

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
globalThis.ui = globalThis.ui || {
  notifications: { info: () => {}, warn: () => {}, error: () => {} },
};
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

const {
  isMarkerSafeForPlayerFlags,
  isDrawingSafeForPlayerFlags,
  isTokenSafeForPlayerFlags,
  shadowAreasOf,
  isMarkerUnderShadow,
  isDrawingUnderShadow,
  playerSafeMapItems,
  userCanSeeMarker,
} = await import('../scripts/_map-flag-filter.mjs');
const { MapSync } = await import('../scripts/map-sync.mjs');
const { FLAG_SCOPE } = await import('../scripts/constants.mjs');

// ---------------------------------------------------------------------
// §1 — isMarkerSafeForPlayerFlags
// ---------------------------------------------------------------------

test('isMarkerSafeForPlayerFlags: dm_only is unsafe', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'dm_only' }), false);
});

test('isMarkerSafeForPlayerFlags: everyone marker with no visibility_rules is safe', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone' }), true);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: null }), true);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: '' }), true);
});

test('isMarkerSafeForPlayerFlags: visibility_rules is a JSON STRING on the wire, not an object', () => {
  // Chronicle's Marker.VisibilityRules is `*string` — a marker with a
  // restrictive allow-list arrives as a JSON-encoded string, matching the
  // fixture in tools/test-marker-config-payload.mjs.
  const marker = {
    visibility: 'everyone',
    visibility_rules: '{"allowed_users":["cu-7"]}',
  };
  assert.equal(isMarkerSafeForPlayerFlags(marker), false);
});

test('isMarkerSafeForPlayerFlags: non-empty denied_users (string-encoded) is unsafe', () => {
  const marker = { visibility: 'everyone', visibility_rules: '{"denied_users":["cu-9"]}' };
  assert.equal(isMarkerSafeForPlayerFlags(marker), false);
});

test('isMarkerSafeForPlayerFlags: empty-but-present allowed_users/denied_users stay safe', () => {
  const marker = {
    visibility: 'everyone',
    visibility_rules: '{"allowed_users":[],"denied_users":[]}',
  };
  assert.equal(isMarkerSafeForPlayerFlags(marker), true);
});

test('isMarkerSafeForPlayerFlags: already-parsed object shape is honored too (defensive)', () => {
  assert.equal(
    isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: { allowed_users: ['u1'] } }),
    false,
  );
  assert.equal(
    isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: {} }),
    true,
  );
});

test('isMarkerSafeForPlayerFlags: a JSON "null" rule string means no rules, as Chronicle reads it', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 'null' }), true);
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 'null' }), true);
});

test('isMarkerSafeForPlayerFlags: malformed visibility_rules fails CLOSED', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 'not json' }), false);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 42 }), false);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: '"just a string"' }), false);
});

test('isMarkerSafeForPlayerFlags: null/non-object marker fails CLOSED', () => {
  assert.equal(isMarkerSafeForPlayerFlags(null), false);
  assert.equal(isMarkerSafeForPlayerFlags(undefined), false);
});

// ---------------------------------------------------------------------
// §2 — isDrawingSafeForPlayerFlags (same shape/rule as markers; Chronicle
// drawings carry `visibility`/`visibility_rules`, not `is_visible`/
// `is_hidden` — see internal/plugins/maps/drawing.go)
// ---------------------------------------------------------------------

test('isDrawingSafeForPlayerFlags: dm_only is unsafe', () => {
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'dm_only' }), false);
});

test('isDrawingSafeForPlayerFlags: everyone drawing with no visibility_rules is safe (unrestricted)', () => {
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone' }), true);
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: null }), true);
});

test('isDrawingSafeForPlayerFlags: non-empty allowed_users (string-encoded) is unsafe', () => {
  const drawing = { visibility: 'everyone', visibility_rules: '{"allowed_users":["cu-7"]}' };
  assert.equal(isDrawingSafeForPlayerFlags(drawing), false);
});

test('isDrawingSafeForPlayerFlags: non-empty denied_users (string-encoded) is unsafe', () => {
  const drawing = { visibility: 'everyone', visibility_rules: '{"denied_users":["cu-9"]}' };
  assert.equal(isDrawingSafeForPlayerFlags(drawing), false);
});

test('isDrawingSafeForPlayerFlags: empty-but-present allowed_users/denied_users stay safe (unrestricted)', () => {
  const drawing = {
    visibility: 'everyone',
    visibility_rules: '{"allowed_users":[],"denied_users":[]}',
  };
  assert.equal(isDrawingSafeForPlayerFlags(drawing), true);
});

test('isDrawingSafeForPlayerFlags: malformed visibility_rules fails CLOSED', () => {
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 'not json' }), false);
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: 42 }), false);
});

test('isDrawingSafeForPlayerFlags: null/non-object drawing fails CLOSED', () => {
  assert.equal(isDrawingSafeForPlayerFlags(null), false);
  assert.equal(isDrawingSafeForPlayerFlags(undefined), false);
});

test('isDrawingSafeForPlayerFlags: fields Chronicle drawings do not have (is_visible/is_hidden) are not what gates them', () => {
  // A drawing has no is_visible/is_hidden on the wire (drawing.go carries
  // visibility/visibility_rules only) — those keys, present or not,
  // must not be what decides safety; visibility/visibility_rules must.
  assert.equal(
    isDrawingSafeForPlayerFlags({ visibility: 'everyone', is_visible: false, is_hidden: true }),
    true,
    'an unrestricted drawing stays safe even if stray is_visible/is_hidden keys are present',
  );
  assert.equal(
    isDrawingSafeForPlayerFlags({ visibility: 'dm_only', is_visible: true, is_hidden: false }),
    false,
    'a dm_only drawing is still excluded even if stray is_visible/is_hidden keys say otherwise',
  );
});

// ---------------------------------------------------------------------
// §3 — the array-shape hardening: a JSON array is not the
// {allowed_users, denied_users} object and must fail closed, not be
// treated as an (empty-looking) unrestricted object.
// ---------------------------------------------------------------------

test('isMarkerSafeForPlayerFlags: visibility_rules as a JSON-string array fails CLOSED', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: '["cu-7"]' }), false);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: '[]' }), false);
});

test('isMarkerSafeForPlayerFlags: visibility_rules as an already-parsed array fails CLOSED', () => {
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: ['cu-7'] }), false);
  assert.equal(isMarkerSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: [] }), false);
});

test('isDrawingSafeForPlayerFlags: visibility_rules as an array (string or parsed) fails CLOSED', () => {
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: '["cu-9"]' }), false);
  assert.equal(isDrawingSafeForPlayerFlags({ visibility: 'everyone', visibility_rules: [] }), false);
});

// ---------------------------------------------------------------------
// §4 — isTokenSafeForPlayerFlags (Chronicle's Token.IsHidden — the same
// field its own non-owner token listing excludes with `is_hidden =
// FALSE`; no per-user visibility_rules on tokens)
// ---------------------------------------------------------------------

test('isTokenSafeForPlayerFlags: is_hidden true is unsafe', () => {
  assert.equal(isTokenSafeForPlayerFlags({ is_hidden: true }), false);
});

test('isTokenSafeForPlayerFlags: is_hidden false is safe', () => {
  assert.equal(isTokenSafeForPlayerFlags({ is_hidden: false }), true);
});

test('isTokenSafeForPlayerFlags: malformed tokens fail CLOSED', () => {
  assert.equal(isTokenSafeForPlayerFlags(null), false);
  assert.equal(isTokenSafeForPlayerFlags(undefined), false);
  assert.equal(isTokenSafeForPlayerFlags('tk-1'), false, 'non-object');
  assert.equal(isTokenSafeForPlayerFlags({}), false, 'is_hidden missing entirely');
  assert.equal(isTokenSafeForPlayerFlags({ is_hidden: 'false' }), false, 'is_hidden as a string, not a boolean');
  assert.equal(isTokenSafeForPlayerFlags({ is_hidden: 0 }), false, 'is_hidden as a falsy non-boolean');
  assert.equal(isTokenSafeForPlayerFlags({ is_hidden: null }), false, 'is_hidden explicitly null');
});

// ---------------------------------------------------------------------
// §5 — MapSync._refreshPageFlags actually filters the live write, for
// all three kinds.
// ---------------------------------------------------------------------

/** A fake JournalEntryPage that records flag writes and applies them. */
function makeFakePage({ markers = [], drawings = [], tokens = [] } = {}) {
  const flags = {
    [FLAG_SCOPE]: {
      mapId: 'map-1',
      chronicleMarkers: markers,
      chronicleDrawings: drawings,
      chronicleTokens: tokens,
    },
  };
  const page = {
    id: 'page-1',
    name: 'Test Map',
    src: 'http://localhost:8080/media/x.png',
    parent: { id: 'entry-1', name: 'Test Map', update: async () => {} },
    updates: [],
    getFlag(scope, key) {
      return flags[scope]?.[key];
    },
    async update(data) {
      page.updates.push(data);
      for (const [k, v] of Object.entries(data)) {
        const prefix = `flags.${FLAG_SCOPE}.`;
        if (k.startsWith(prefix)) {
          flags[FLAG_SCOPE][k.slice(prefix.length)] = v;
        } else if (k === 'flags.core.sheetClass') {
          // ignored — irrelevant to these tests.
        } else {
          page[k] = v;
        }
      }
    },
  };
  return page;
}

const RESTRICTED_MARKER = {
  id: 'mk-restricted',
  visibility: 'everyone',
  name: 'Secret Lair',
  visibility_rules: '{"allowed_users":["cu-7"]}',
};
const DM_ONLY_MARKER = { id: 'mk-dm', visibility: 'dm_only', name: 'GM Notes' };
const OPEN_MARKER = { id: 'mk-open', visibility: 'everyone', name: 'Town Square' };

const RESTRICTED_DRAWING = {
  id: 'dr-restricted',
  visibility: 'everyone',
  visibility_rules: '{"denied_users":["cu-9"]}',
};
const DM_ONLY_DRAWING = { id: 'dr-dm', visibility: 'dm_only' };
const OPEN_DRAWING = { id: 'dr-open', visibility: 'everyone' };

const HIDDEN_TOKEN = { id: 'tk-hidden', is_hidden: true, name: 'Ambush' };
const VISIBLE_TOKEN = { id: 'tk-visible', is_hidden: false, name: 'Guard' };

test('_refreshPageFlags: restricted markers, drawings, and hidden tokens are all excluded', async () => {
  const ms = new MapSync();
  const page = makeFakePage();
  ms.findPageByMapId = () => page;

  await ms._refreshPageFlags('map-1', {
    markers: [RESTRICTED_MARKER, DM_ONLY_MARKER, OPEN_MARKER],
    drawings: [RESTRICTED_DRAWING, DM_ONLY_DRAWING, OPEN_DRAWING],
    tokens: [HIDDEN_TOKEN, VISIBLE_TOKEN],
    layers: [],
  });

  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id),
    ['mk-open'],
  );
  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleDrawings').map((d) => d.id),
    ['dr-open'],
  );
  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleTokens').map((t) => t.id),
    ['tk-visible'],
  );
});

test('_refreshPageFlags: layers are written through unfiltered (names/display settings only)', async () => {
  const ms = new MapSync();
  const page = makeFakePage();
  ms.findPageByMapId = () => page;

  const layers = [{ id: 'ly-1', name: 'Background' }];
  await ms._refreshPageFlags('map-1', { markers: [], drawings: [], tokens: [], layers });

  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleLayers'), layers);
});

// ---------------------------------------------------------------------
// §6 — reconciliation: markers, drawings, and tokens already written by
// an older module version must be removed on the next sync, not just
// prevented going forward.
// ---------------------------------------------------------------------

test('_materializeMap: existing page with stale restricted/hidden data is cleaned on the next sync', async () => {
  const ms = new MapSync();
  ms._ensureMapsFolder = async () => ({ id: 'folder-1' });

  const page = makeFakePage({
    markers: [RESTRICTED_MARKER, DM_ONLY_MARKER, OPEN_MARKER],
    drawings: [RESTRICTED_DRAWING, DM_ONLY_DRAWING, OPEN_DRAWING],
    tokens: [HIDDEN_TOKEN, VISIBLE_TOKEN],
  });
  ms.findPageByMapId = () => page;

  await ms._materializeMap({
    id: 'map-1',
    name: 'Test Map',
    image_url: 'http://localhost:8080/media/x.png',
  });

  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id),
    ['mk-open'],
    'a full sync must strip markers an older version already wrote',
  );
  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleDrawings').map((d) => d.id),
    ['dr-open'],
    'a full sync must strip drawings an older version already wrote',
  );
  assert.deepEqual(
    page.getFlag(FLAG_SCOPE, 'chronicleTokens').map((t) => t.id),
    ['tk-visible'],
    'a full sync must strip hidden tokens an older version already wrote',
  );
});

test('_materializeMap: existing page with only safe data is left untouched (no spurious writes)', async () => {
  const ms = new MapSync();
  ms._ensureMapsFolder = async () => ({ id: 'folder-1' });

  const page = makeFakePage({
    markers: [OPEN_MARKER],
    drawings: [OPEN_DRAWING],
    tokens: [VISIBLE_TOKEN],
  });
  ms.findPageByMapId = () => page;

  await ms._materializeMap({
    id: 'map-1',
    name: 'Test Map',
    image_url: 'http://localhost:8080/media/x.png',
  });

  const [update] = page.updates;
  assert.ok(update, 'materialization still writes chronicleMapMeta etc.');
  assert.equal(`flags.${FLAG_SCOPE}.chronicleMarkers` in update, false, 'nothing needed removing from markers');
  assert.equal(`flags.${FLAG_SCOPE}.chronicleDrawings` in update, false, 'nothing needed removing from drawings');
  assert.equal(`flags.${FLAG_SCOPE}.chronicleTokens` in update, false, 'nothing needed removing from tokens');
});

// ---------------------------------------------------------------------
// Static-source regression pins
// ---------------------------------------------------------------------

test('pin: _refreshPageFlags filters through the shared helpers, not bare field checks', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/map-sync.mjs'), 'utf8');
  assert.ok(
    /import\s*\{[^}]*playerSafeMapItems[^}]*isTokenSafeForPlayerFlags[^}]*\}\s*from\s*['"]\.\/_map-flag-filter\.mjs['"]/.test(src),
    'map-sync.mjs must import its filters from the shared filter module',
  );
  const m = src.match(/async _refreshPageFlags\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(m, '_refreshPageFlags body could not be located');
  const body = m[1];
  assert.ok(/playerSafeMapItems\(markers, drawings\)/.test(body), '_refreshPageFlags must filter markers and drawings with playerSafeMapItems');
  assert.ok(/\.filter\(isTokenSafeForPlayerFlags\)/.test(body), '_refreshPageFlags must filter tokens with isTokenSafeForPlayerFlags');
  assert.ok(
    !/is_visible\s*!==\s*false/.test(body) && !/is_hidden\s*!==\s*true/.test(body),
    'the old dead is_visible/is_hidden drawing check must be gone from _refreshPageFlags',
  );
  assert.ok(
    !/chronicleTokens[^\n]*:\s*tokens\s*\|\|\s*\[\]/.test(body),
    'tokens must no longer be written to flags unfiltered',
  );
});

test('pin: _materializeMap reconciles stored markers, drawings, and tokens through the shared helpers', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/map-sync.mjs'), 'utf8');
  const m = src.match(/async _materializeMap\([^)]*\)\s*\{([\s\S]*?)\n {2}\}\n/);
  assert.ok(m, '_materializeMap body could not be located');
  const body = m[1];
  assert.ok(/chronicleDrawings['"]\)[\s\S]*?playerSafeMapItems\(storedMarkers, storedDrawings\)/.test(body), '_materializeMap must reconcile stored markers and drawings through playerSafeMapItems');
  assert.ok(/chronicleTokens['"]\)[\s\S]*?isTokenSafeForPlayerFlags/.test(body), '_materializeMap must reconcile stored tokens through isTokenSafeForPlayerFlags');
});

test('pin: the map viewer uses the shared userCanSeeMarker, not its own copy', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/map-viewer.mjs'), 'utf8');
  assert.ok(/import\s*\{\s*userCanSeeMarker\s*\}\s*from\s*['"]\.\/_map-flag-filter\.mjs['"]/.test(src));
  assert.ok(!/function _userCanSeeMarker/.test(src), 'the old object-only check must be gone');
});

// ---------------------------------------------------------------------
// §7 — shadow areas
// ---------------------------------------------------------------------

const SHADOW = {
  id: 'dr-shadow', drawing_type: 'shadow', visibility: 'everyone',
  // Dragged from the bottom-right corner: corners must be normalised.
  points: [{ x: 60, y: 60 }, { x: 20, y: 20 }],
};

// A drawing clear of SHADOW. Points are required once a shadow exists: a
// drawing without them can't be placed, so it fails closed.
const CLEAR_MARKER = { id: 'mk-open', visibility: 'everyone', x: 80, y: 80 };
const CLEAR_DRAWING = { id: 'dr-open', visibility: 'everyone', points: [{ x: 70, y: 70 }, { x: 90, y: 90 }] };

test('shadowAreasOf: two corners, normalised; other shapes and bad points are not areas', () => {
  assert.deepEqual(shadowAreasOf([SHADOW]), [{ minX: 20, minY: 20, maxX: 60, maxY: 60 }]);
  assert.deepEqual(shadowAreasOf([{ ...SHADOW, points: JSON.stringify(SHADOW.points) }]).length, 1, 'string points parse');
  assert.deepEqual(shadowAreasOf([{ drawing_type: 'rectangle', points: SHADOW.points }]), []);
  assert.deepEqual(shadowAreasOf([{ drawing_type: 'shadow', points: [{ x: 1, y: 1 }] }]), []);
  assert.deepEqual(shadowAreasOf([{ drawing_type: 'shadow', points: 'nope' }]), []);
  assert.deepEqual(shadowAreasOf(null), []);
});

test('isMarkerUnderShadow: inside and on the edge are hidden, outside is not', () => {
  const areas = shadowAreasOf([SHADOW]);
  assert.equal(isMarkerUnderShadow({ x: 40, y: 40 }, areas), true);
  assert.equal(isMarkerUnderShadow({ x: 20, y: 60 }, areas), true, 'edges count as inside');
  assert.equal(isMarkerUnderShadow({ x: 61, y: 40 }, areas), false);
  assert.equal(isMarkerUnderShadow({ x: 'bad' }, areas), true, 'no usable position fails closed');
  assert.equal(isMarkerUnderShadow({ x: 'bad' }, []), false, 'no shadows: nothing hidden');
});

test('isDrawingUnderShadow: wholly under is hidden, touching is not, unparseable is hidden', () => {
  const areas = shadowAreasOf([SHADOW]);
  assert.equal(isDrawingUnderShadow({ points: [{ x: 30, y: 30 }, { x: 50, y: 50 }] }, areas), true);
  assert.equal(isDrawingUnderShadow({ points: [{ x: 30, y: 30 }, { x: 90, y: 90 }] }, areas), false);
  assert.equal(isDrawingUnderShadow({ points: 'garbage' }, areas), true);
  assert.equal(isDrawingUnderShadow({ points: [] }, areas), false);
  assert.equal(isDrawingUnderShadow(SHADOW, areas), false, 'a shadow does not hide itself');
});

test('playerSafeMapItems: drops shadowed pins and drawings and the shadow itself', () => {
  const inside = { id: 'mk-in', visibility: 'everyone', x: 30, y: 30 };
  const outside = { id: 'mk-out', visibility: 'everyone', x: 80, y: 80 };
  const under = { id: 'dr-under', visibility: 'everyone', points: [{ x: 25, y: 25 }, { x: 35, y: 35 }] };
  const across = { id: 'dr-across', visibility: 'everyone', points: [{ x: 25, y: 25 }, { x: 95, y: 95 }] };
  const out = playerSafeMapItems([inside, outside, DM_ONLY_MARKER], [SHADOW, under, across, RESTRICTED_DRAWING]);
  assert.deepEqual(out.markers.map((m) => m.id), ['mk-out']);
  assert.deepEqual(out.drawings.map((d) => d.id), ['dr-across']);
});

test('_refreshPageFlags: shadowed pins never reach the player copy', async () => {
  const ms = new MapSync();
  const page = makeFakePage();
  ms.findPageByMapId = () => page;

  await ms._refreshPageFlags('map-1', {
    markers: [{ id: 'mk-in', visibility: 'everyone', x: 30, y: 30 }, CLEAR_MARKER],
    drawings: [SHADOW, CLEAR_DRAWING],
    tokens: [],
    layers: [],
  });

  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleDrawings').map((d) => d.id), ['dr-open']);
});

test('_refreshPageFlags: a failed drawing fetch leaves stored markers and drawings alone', async () => {
  const ms = new MapSync();
  const page = makeFakePage({ markers: [OPEN_MARKER], drawings: [OPEN_DRAWING] });
  ms.findPageByMapId = () => page;

  await ms._refreshPageFlags('map-1', {
    markers: [{ id: 'mk-new', visibility: 'everyone', x: 30, y: 30 }],
    drawings: [],
    tokens: [VISIBLE_TOKEN],
    layers: [],
    drawingsKnown: false,
  });

  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleDrawings').map((d) => d.id), ['dr-open']);
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleTokens').map((t) => t.id), ['tk-visible']);
});

test('_refreshSubResources: a failed drawing fetch is passed on as unknown', async () => {
  const ms = new MapSync();
  const page = makeFakePage({ markers: [OPEN_MARKER], drawings: [OPEN_DRAWING] });
  ms.findPageByMapId = () => page;
  ms._logError = () => {};
  ms._api = {
    get: async (path) => {
      if (path.endsWith('/drawings')) throw Object.assign(new Error('boom'), { status: 500 });
      if (path.endsWith('/markers')) return [{ id: 'mk-new', visibility: 'everyone', x: 30, y: 30 }];
      return [];
    },
  };

  await ms._refreshSubResources('map-1');
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
});

test('_pollSubResources: drawings failing on refresh and again on poll never publish shadowed pins', async () => {
  const ms = new MapSync();
  const page = makeFakePage({ markers: [CLEAR_MARKER], drawings: [CLEAR_DRAWING] });
  ms.findPageByMapId = () => page;
  ms._logError = () => {};
  ms._notifyViewers = () => {};
  ms._api = {
    get: async (path) => {
      if (path.endsWith('/drawings')) throw Object.assign(new Error('boom'), { status: 500 });
      if (path.endsWith('/markers')) return [{ id: 'mk-in', visibility: 'everyone', x: 30, y: 30 }];
      return [];
    },
  };

  await ms._refreshSubResources('map-1');
  await ms._pollSubResources('map-1');
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
});

test('_pollSubResources: a failed drawing poll after a good fetch keeps applying the cached shadows', async () => {
  const ms = new MapSync();
  const page = makeFakePage();
  ms.findPageByMapId = () => page;
  ms._logError = () => {};
  ms._notifyViewers = () => {};
  let drawingsFail = false;
  ms._api = {
    get: async (path) => {
      if (path.endsWith('/drawings')) {
        if (drawingsFail) throw new Error('boom');
        return [SHADOW];
      }
      if (path.endsWith('/markers')) return [{ id: 'mk-in', visibility: 'everyone', x: 30, y: 30 }, CLEAR_MARKER];
      return [];
    },
  };

  await ms._refreshSubResources('map-1');
  drawingsFail = true;
  await ms._pollSubResources('map-1');
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
});

test('playerSafeMapItems: a GM-only shadow still hides what is under it', () => {
  const out = playerSafeMapItems(
    [{ id: 'mk-in', visibility: 'everyone', x: 30, y: 30 }, CLEAR_MARKER],
    [{ ...SHADOW, visibility: 'dm_only' }],
  );
  assert.deepEqual(out.markers.map((m) => m.id), ['mk-open']);
  assert.deepEqual(out.drawings, []);
});

test('_materializeMap: shadow data an older module wrote is stripped on the next sync', async () => {
  const ms = new MapSync();
  ms._ensureMapsFolder = async () => ({ id: 'folder-1' });
  const page = makeFakePage({
    markers: [{ id: 'mk-in', visibility: 'everyone', x: 30, y: 30 }, CLEAR_MARKER],
    drawings: [SHADOW, CLEAR_DRAWING],
  });
  ms.findPageByMapId = () => page;

  await ms._materializeMap({ id: 'map-1', name: 'Test Map', image_url: 'http://localhost:8080/media/x.png' });

  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleMarkers').map((m) => m.id), ['mk-open']);
  assert.deepEqual(page.getFlag(FLAG_SCOPE, 'chronicleDrawings').map((d) => d.id), ['dr-open']);
});

// ---------------------------------------------------------------------
// §8 — userCanSeeMarker (viewer render-time check)
// ---------------------------------------------------------------------

test('userCanSeeMarker: per-user rules arrive as a JSON string and are honored', () => {
  const allow = { visibility: 'everyone', visibility_rules: '{"allowed_users":["cu-7"]}' };
  const deny = { visibility: 'everyone', visibility_rules: '{"denied_users":["cu-9"]}' };
  assert.equal(userCanSeeMarker(allow, false, 'cu-7'), true);
  assert.equal(userCanSeeMarker(allow, false, 'cu-8'), false);
  assert.equal(userCanSeeMarker(allow, false, null), false, 'unmapped player is not on an allow list');
  assert.equal(userCanSeeMarker(deny, false, 'cu-9'), false);
  assert.equal(userCanSeeMarker(deny, false, 'cu-8'), true);
});

test('userCanSeeMarker: dm_only, GM, empty and broken rules', () => {
  assert.equal(userCanSeeMarker(DM_ONLY_MARKER, false, 'cu-7'), false);
  assert.equal(userCanSeeMarker(DM_ONLY_MARKER, true, null), true);
  assert.equal(userCanSeeMarker(RESTRICTED_MARKER, true, null), true, 'the GM sees everything');
  assert.equal(userCanSeeMarker(OPEN_MARKER, false, null), true);
  assert.equal(userCanSeeMarker({ visibility: 'everyone', visibility_rules: '{}' }, false, null), true);
  assert.equal(userCanSeeMarker({ visibility: 'everyone', visibility_rules: 'not json' }, false, 'cu-7'), false);
  assert.equal(userCanSeeMarker(null, true, null), false);
});
