#!/usr/bin/env node
/**
 * Unit tests for `isCalendarNoteJournal` in `scripts/calendar-sync.mjs`.
 *
 * A journal Chronicle already mirrored to a calendar event carries our own
 * `calendarEventId` link flag and must be recognized so JournalSync skips it
 * instead of POSTing it to /entities — entity_type_id:0 there resolves to the
 * first entity type, so it would appear in the wrong entity list.
 *
 * Run: `node --test tools/test-calendar-note-journal.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Stub Foundry globals that calendar-sync.mjs transitively imports at module
// load time. The pure helper under test touches none of these.
globalThis.foundry = globalThis.foundry || {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (base) => base,
    },
  },
};
globalThis.game = globalThis.game || {
  settings: { get: () => null, register: () => {}, registerMenu: () => {} },
  i18n:     { localize: (k) => k, format: (k) => k },
  user:     { isGM: true },
  modules:  { get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, off: () => {} };

const {
  isCalendarNoteJournal,
} = await import('../scripts/calendar-sync.mjs');

const FLAG_SCOPE = 'chronicle-sync';

/**
 * Build a JournalEntry-like stub. When `chronicleFlags` is provided, a `getFlag`
 * shim is attached (as the real Foundry document has) so we exercise that path;
 * otherwise the helper falls back to reading the nested `flags` object.
 */
function journalStub(flags = {}, { withGetFlag = false, chronicleFlags = null } = {}) {
  const allFlags = { ...flags };
  if (chronicleFlags) allFlags[FLAG_SCOPE] = chronicleFlags;
  const stub = { name: 'Stub', flags: allFlags };
  if (withGetFlag) {
    stub.getFlag = (scope, key) => allFlags[scope]?.[key];
  }
  return stub;
}

// ---------------------------------------------------------------------
// Positive: our own calendarEventId link flag (both read paths)
// ---------------------------------------------------------------------

test('mirrored note with calendarEventId via getFlag → true', () => {
  const j = journalStub({}, { withGetFlag: true, chronicleFlags: { calendarEventId: 'evt_1' } });
  assert.equal(isCalendarNoteJournal(j), true);
});

test('mirrored note with calendarEventId via nested flags (no getFlag) → true', () => {
  const j = journalStub({}, { chronicleFlags: { calendarEventId: 'evt_1' } });
  assert.equal(isCalendarNoteJournal(j), true);
});

// ---------------------------------------------------------------------
// Negative: ordinary journals must NOT be flagged (no sync regression)
// ---------------------------------------------------------------------

test('plain journal with no flags → false', () => {
  assert.equal(isCalendarNoteJournal(journalStub({})), false);
});

test('worldbuilding journal with an unrelated module flag → false', () => {
  const j = journalStub({ 'monks-enhanced-journal': { type: 'base' } });
  assert.equal(isCalendarNoteJournal(j), false);
});

test('journal whose chronicle flags hold an entityId (a real entity) → false', () => {
  // A genuinely synced entity-journal has entityId but NOT calendarEventId.
  const j = journalStub({}, { withGetFlag: true, chronicleFlags: { entityId: 'ent_9' } });
  assert.equal(isCalendarNoteJournal(j), false);
});

test('an unknown module flag is not a calendar note', () => {
  assert.equal(isCalendarNoteJournal(journalStub({ 'some-calendar-module': { isCalendarNote: true } })), false);
});

// ---------------------------------------------------------------------
// Positive: notes a third-party calendar module left in the world are
// never pushed as entities, though the module no longer syncs them.
// ---------------------------------------------------------------------

test('leftover third-party calendar notes are skipped', () => {
  const cases = [
    [{ calendaria: { isCalendarNote: true } }, true],
    [{ calendaria: { isCalendarJournal: true } }, true],
    [{ calendaria: { enricher: 'x' } }, false],
    [{ 'foundryvtt-simple-calendar': { noteData: {} } }, true],
    [{ 'simple-calendar': {} }, true],
  ];
  for (const [flags, want] of cases) {
    assert.equal(isCalendarNoteJournal(journalStub(flags)), want, JSON.stringify(flags));
  }
});

// ---------------------------------------------------------------------
// Negative: non-journal inputs are safe
// ---------------------------------------------------------------------

test('null / undefined / non-object inputs → false', () => {
  assert.equal(isCalendarNoteJournal(null), false);
  assert.equal(isCalendarNoteJournal(undefined), false);
  assert.equal(isCalendarNoteJournal('journal'), false);
  assert.equal(isCalendarNoteJournal(42), false);
});
