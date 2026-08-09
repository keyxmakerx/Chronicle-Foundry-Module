#!/usr/bin/env node
/**
 * Regression pin for the partial-PUT marker bug
 * (FM-MARKER-DIALOG-PARTIAL-PUT).
 *
 * `PUT /api/v1/campaigns/:id/maps/:mapID/markers/:markerID` is a FULL
 * REPLACE. Chronicle binds the body into `apiUpdateMarkerRequest` (pointer
 * fields for the optional columns) and `mapService.UpdateMarker` assigns
 * every one of them onto the loaded row before
 * `mapRepo.UpdateMarker` UPDATEs `entity_id`, `visibility_rules` and
 * `foundry_id` unconditionally. A key absent from the JSON body therefore
 * binds to nil and lands on disk as NULL.
 *
 * `ChronicleMarkerConfigDialog.#onSave` used to rebuild its payload from
 * scratch with exactly eight keys — name, description, x, y, pin_category,
 * color, icon, visibility — so every GM edit of a Chronicle marker from the
 * Foundry map viewer silently cleared:
 *
 *   - `entity_id`        the marker → entity link (double-click navigation)
 *   - `visibility_rules` the per-user allow/deny list
 *   - `foundry_id`       the module's OWN pairing key
 *
 * The fix spreads the stored marker under the edited fields, matching the
 * sibling `PinConfigDialog.#onSave` in the same file.
 *
 * These tests drive the REAL save action off
 * `ChronicleMarkerConfigDialog.DEFAULT_OPTIONS.actions['save-marker']`
 * against a stubbed form, and assert on the object handed to the onSave
 * callback (which map-sync.mjs passes verbatim as the PUT body).
 *
 * Run: `node --test tools/test-marker-config-payload.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------
   Foundry globals — enough for map-viewer.mjs to evaluate at import.
   ------------------------------------------------------------------ */

class StubApplicationV2 {
  constructor(_options = {}) {}
  close() {}
  render() {}
}

globalThis.foundry = {
  applications: {
    api: { ApplicationV2: StubApplicationV2, HandlebarsApplicationMixin: (b) => b },
    // `class X extends undefined` is a TypeError, so the journal page-sheet
    // base must be a real class even though these tests never render it.
    sheets: { journal: { JournalEntryPageSheet: class {} } },
  },
};
globalThis.game = {
  user: { isGM: true, id: 'gm' },
  i18n: { localize: (k) => k, format: (k) => k },
  settings: { get: () => undefined, register: () => {} },
  journal: { contents: [] },
  modules: new Map(),
};
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {} };
globalThis.CONFIG = { JournalEntryPage: { sheetClasses: {} } };

const { ChronicleMarkerConfigDialog } = await import('../scripts/map-viewer.mjs');

const SAVE_ACTION = ChronicleMarkerConfigDialog.DEFAULT_OPTIONS.actions['save-marker'];

/**
 * A marker exactly as Chronicle serves it: the editable fields, the three
 * optional columns the bug dropped, plus the read-only/joined keys.
 */
function storedMarker(overrides = {}) {
  return {
    id: 'mk-1',
    map_id: 'map-1',
    name: 'Yawning Portal',
    description: 'A tavern',
    x: 12.5,
    y: 40.25,
    icon: 'fa-note-sticky',
    color: '#94A3B8',
    pin_category: 'note',
    entity_id: 'ent-yawning-portal',
    visibility: 'everyone',
    visibility_rules: '{"allowed_users":["cu-7"]}',
    foundry_id: 'JournalEntryPage.abc123',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    entity_name: 'Yawning Portal',
    entity_icon: 'fa-beer',
    ...overrides,
  };
}

/**
 * Build a dialog whose `element` resolves the marker config form to a stub
 * returning the given field values, then invoke the real save action.
 * @returns {object} the payload handed to the onSave callback
 */
function runSave(marker, fields) {
  let payload = null;
  const dialog = new ChronicleMarkerConfigDialog({
    marker: { ...marker },
    mode: 'edit',
    onSave: (data) => { payload = data; },
  });

  const form = {
    querySelector: (sel) => {
      const m = sel.match(/^\[name="(.+)"\]$/);
      const key = m && m[1];
      if (!(key in fields)) throw new Error(`test stub: unexpected form field ${sel}`);
      return { value: fields[key] };
    },
  };
  dialog.element = { querySelector: (sel) => (sel === '.chronicle-marker-config-form' ? form : null) };

  SAVE_ACTION.call(dialog, new Event('click'), null);
  assert.ok(payload, 'save action must invoke the onSave callback');
  return payload;
}

const EDIT_FIELDS = {
  name: 'Yawning Portal',
  description: 'A tavern',
  pin_category: 'quest',
  visibility: 'everyone',
};

/* ------------------------------------------------------------------
   The bug: optional columns must survive an edit.
   ------------------------------------------------------------------ */

test('marker save payload carries entity_id through (full-replace PUT would NULL it)', () => {
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  assert.equal(payload.entity_id, 'ent-yawning-portal');
});

test('marker save payload carries visibility_rules through', () => {
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  assert.equal(payload.visibility_rules, '{"allowed_users":["cu-7"]}');
});

test('marker save payload carries foundry_id through (the module pairing key)', () => {
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  assert.equal(payload.foundry_id, 'JournalEntryPage.abc123');
});

test('every optional column Chronicle UPDATEs unconditionally is present in the payload', () => {
  // repository.go UpdateMarker writes entity_id / visibility_rules /
  // foundry_id with no COALESCE — an absent key is a NULL write.
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  for (const key of ['entity_id', 'visibility_rules', 'foundry_id']) {
    assert.ok(key in payload, `payload must declare ${key}`);
  }
});

test('a stored marker with null optional columns still round-trips as null (no invention)', () => {
  const payload = runSave(
    storedMarker({ entity_id: null, visibility_rules: null, foundry_id: null }),
    EDIT_FIELDS,
  );
  assert.equal(payload.entity_id, null);
  assert.equal(payload.visibility_rules, null);
  assert.equal(payload.foundry_id, null);
});

/* ------------------------------------------------------------------
   The edits themselves must still win over the spread.
   ------------------------------------------------------------------ */

test('edited fields override the stored values', () => {
  const payload = runSave(storedMarker(), {
    name: '  The Yawning Portal  ',
    description: '  Durnan pours  ',
    pin_category: 'quest',
    visibility: 'dm_only',
  });
  assert.equal(payload.name, 'The Yawning Portal');
  assert.equal(payload.description, 'Durnan pours');
  assert.equal(payload.pin_category, 'quest');
  assert.equal(payload.visibility, 'dm_only');
  // color + icon are derived from the chosen category, not from the store.
  assert.equal(payload.color, '#8B5CF6');
  assert.equal(payload.icon, 'fa-scroll');
});

test('coordinates come from the stored marker (the dialog has no x/y fields)', () => {
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  assert.equal(payload.x, 12.5);
  assert.equal(payload.y, 40.25);
});

test('an out-of-range category or visibility still falls back to the safe default', () => {
  const payload = runSave(storedMarker(), {
    name: 'X',
    description: '',
    pin_category: 'javascript:alert(1)',
    visibility: 'everyone_plus',
  });
  assert.equal(payload.pin_category, 'note');
  assert.equal(payload.visibility, 'everyone');
});

test('an empty name falls back to "Marker" (service rejects an empty name)', () => {
  const payload = runSave(storedMarker(), {
    name: '   ',
    description: '',
    pin_category: 'note',
    visibility: 'everyone',
  });
  assert.equal(payload.name, 'Marker');
});

/* ------------------------------------------------------------------
   The spread must not smuggle an optimistic-concurrency token.
   ------------------------------------------------------------------ */

test('spread does not set expected_updated_at (updated_at is a different wire key)', () => {
  const payload = runSave(storedMarker(), EDIT_FIELDS);
  assert.equal(payload.expected_updated_at, undefined,
    'apiUpdateMarkerRequest reads expected_updated_at; spreading updated_at must not engage concurrency');
});
