#!/usr/bin/env node
/**
 * Unit tests for `isCalendarNoteJournal` in `scripts/calendar-sync.mjs`.
 *
 * Pins the FM calendar-journal guard: calendar-module notes (SimpleCalendar /
 * Calendaria) are stored as Foundry JournalEntries and must be recognized so
 * JournalSync skips them instead of POSTing them to /entities (where
 * entity_type_id:0 resolves to the first entity type — typically "Character" —
 * and calendar holidays wrongly appear in the Characters list).
 *
 * Run: `node --test tools/test-calendar-note-journal.mjs`
 *
 * No mocking framework — uses Node's built-in `node:test` (Node ≥ 18).
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
  CALENDAR_NOTE_FLAG_SCOPES,
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
// Positive: calendar-module flag namespaces
// ---------------------------------------------------------------------

test('SimpleCalendar note (foundryvtt-simple-calendar flag) → true', () => {
  const j = journalStub({ 'foundryvtt-simple-calendar': { noteData: { startDate: { year: 1 } } } });
  assert.equal(isCalendarNoteJournal(j), true);
});

test('legacy simple-calendar flag namespace → true', () => {
  assert.equal(isCalendarNoteJournal(journalStub({ 'simple-calendar': { note: true } })), true);
});

test('Calendaria journal-backed note (calendaria flag) → true', () => {
  assert.equal(isCalendarNoteJournal(journalStub({ calendaria: { startDate: {} } })), true);
});

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

test('null SC flag value is not treated as ownership (typeof null === object guard)', () => {
  assert.equal(isCalendarNoteJournal(journalStub({ 'simple-calendar': null })), false);
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

// ---------------------------------------------------------------------
// Constant shape
// ---------------------------------------------------------------------

test('CALENDAR_NOTE_FLAG_SCOPES is frozen and covers the supported modules', () => {
  assert.ok(Object.isFrozen(CALENDAR_NOTE_FLAG_SCOPES));
  assert.ok(CALENDAR_NOTE_FLAG_SCOPES.includes('foundryvtt-simple-calendar'));
  assert.ok(CALENDAR_NOTE_FLAG_SCOPES.includes('simple-calendar'));
  assert.ok(CALENDAR_NOTE_FLAG_SCOPES.includes('calendaria'));
});
