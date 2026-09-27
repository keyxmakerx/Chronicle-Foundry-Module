#!/usr/bin/env node
/**
 * Tests for the note.created/note.updated payload-shape decision
 * (scripts/_note-event.mjs).
 *
 * Chronicle#787 trimmed `note.created`/`note.updated` to `{ noteId, entityId }`
 * — no content — so note-sync.mjs must tell that shape apart from an older
 * Chronicle's full-note payload, and know what a failed fetch-by-id means.
 * `entityId` is present on BOTH shapes, so it must never read as a content
 * signal on its own — the regression this module exists to prevent.
 *
 * Run: `node --test tools/test-note-event.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  noteEventId,
  noteEventHasContent,
  noteFetchFailureAction,
} from '../scripts/_note-event.mjs';

test('ids-only message (Chronicle#787 shape): id resolves, no content', () => {
  const payload = { noteId: 'note-123', entityId: 'entity-456' };
  assert.equal(noteEventId(payload), 'note-123');
  assert.equal(noteEventHasContent(payload), false,
    'entityId alone must not read as content — it is present on the ids-only shape too');
});

test('ids-only message with no entityId (a Journal note, not a page jot)', () => {
  const payload = { noteId: 'note-123' };
  assert.equal(noteEventId(payload), 'note-123');
  assert.equal(noteEventHasContent(payload), false);
});

test('legacy full message (pre-#787 Chronicle): id falls back to `id`, content detected', () => {
  const payload = {
    id: 'note-123',
    campaignId: 'camp-1',
    userId: 'user-1',
    entityId: null,
    isFolder: false,
    title: 'Session 3 recap',
    content: [],
    entryHtml: '<p>The party arrives.</p>',
    color: '#374151',
    pinned: false,
    isShared: true,
    sharedWith: [],
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-27T00:00:00Z',
  };
  assert.equal(noteEventId(payload), 'note-123');
  assert.equal(noteEventHasContent(payload), true);
});

test('legacy message with only a title still reads as content', () => {
  // Title is the one field Chronicle's Note model always serializes
  // (never `omitempty`), so it alone is a sufficient, reliable signal.
  assert.equal(noteEventHasContent({ id: 'note-123', title: '' }), true);
});

test('a snake_case legacy payload (defensive: entry_html key) still reads as content', () => {
  assert.equal(noteEventHasContent({ id: 'note-123', entry_html: '<p>x</p>' }), true);
});

test('noteId wins over id when a payload somehow carries both', () => {
  assert.equal(noteEventId({ noteId: 'new-id', id: 'old-id' }), 'new-id');
});

test('missing ids: empty payload and payload with only entityId', () => {
  assert.equal(noteEventId({}), null);
  assert.equal(noteEventId({ entityId: 'entity-456' }), null);
  assert.equal(noteEventId(null), null);
  assert.equal(noteEventId(undefined), null);
});

test('missing ids: blank/nullish id values do not resolve', () => {
  assert.equal(noteEventId({ noteId: '' }), null);
  assert.equal(noteEventId({ noteId: null }), null);
  assert.equal(noteEventId({ id: undefined, noteId: undefined }), null);
});

test('a non-string id is coerced to a string', () => {
  assert.equal(noteEventId({ noteId: 12345 }), '12345');
});

test('an empty payload has no content', () => {
  assert.equal(noteEventHasContent({}), false);
  assert.equal(noteEventHasContent(null), false);
  assert.equal(noteEventHasContent(undefined), false);
});

test('404/403 fetch-failure path decision: both mean "treat as delete"', () => {
  assert.equal(noteFetchFailureAction(404), 'delete',
    'Chronicle answers both "not found" and "not visible to this key" with 404');
  assert.equal(noteFetchFailureAction(403), 'delete',
    'some deployments may answer 403 for the same not-visible case');
});

test('404/403 fetch-failure path decision: anything else is a real error', () => {
  assert.equal(noteFetchFailureAction(500), 'error');
  assert.equal(noteFetchFailureAction(409), 'error');
  assert.equal(noteFetchFailureAction(401), 'error');
  assert.equal(noteFetchFailureAction(undefined), 'error',
    'a network failure carries no status and must not be guessed into a delete');
  assert.equal(noteFetchFailureAction(null), 'error');
});
