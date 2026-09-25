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

test('pin: _refreshPageFlags imports and uses the per-kind helpers, not bare field checks', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/map-sync.mjs'), 'utf8');
  assert.ok(
    /import\s*\{[^}]*isMarkerSafeForPlayerFlags[^}]*isDrawingSafeForPlayerFlags[^}]*isTokenSafeForPlayerFlags[^}]*\}\s*from\s*['"]\.\/_map-flag-filter\.mjs['"]/.test(src),
    'map-sync.mjs must import all three helpers from the shared filter module',
  );
  const m = src.match(/async _refreshPageFlags\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(m, '_refreshPageFlags body could not be located');
  const body = m[1];
  assert.ok(/\.filter\(isMarkerSafeForPlayerFlags\)/.test(body), '_refreshPageFlags must filter markers with isMarkerSafeForPlayerFlags');
  assert.ok(/\.filter\(isDrawingSafeForPlayerFlags\)/.test(body), '_refreshPageFlags must filter drawings with isDrawingSafeForPlayerFlags');
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
  assert.ok(/chronicleMarkers['"]\)[\s\S]*?isMarkerSafeForPlayerFlags/.test(body), '_materializeMap must reconcile stored markers through isMarkerSafeForPlayerFlags');
  assert.ok(/chronicleDrawings['"]\)[\s\S]*?isDrawingSafeForPlayerFlags/.test(body), '_materializeMap must reconcile stored drawings through isDrawingSafeForPlayerFlags');
  assert.ok(/chronicleTokens['"]\)[\s\S]*?isTokenSafeForPlayerFlags/.test(body), '_materializeMap must reconcile stored tokens through isTokenSafeForPlayerFlags');
});
