/**
 * Pins _actor-catch-up.mjs: the connect pass makes an actor only for a
 * character made since the last sync and not set aside by the GM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { madeSince, bringsInActor } from '../scripts/_actor-catch-up.mjs';

const since = '2026-11-19T10:00:00Z';

test('a character made after the last sync qualifies; one made before does not', () => {
  assert.equal(madeSince({ created_at: '2026-11-19T10:00:01Z' }, since), true);
  assert.equal(madeSince({ created_at: '2026-11-19T09:59:59Z' }, since), false);
  assert.equal(madeSince({ created_at: since }, since), false);
});

test('the first connect (no last sync) and missing or bad dates bring nothing in', () => {
  assert.equal(madeSince({ created_at: '2026-11-19T11:00:00Z' }, null), false);
  assert.equal(madeSince({}, since), false);
  assert.equal(madeSince({ created_at: 'not a date' }, since), false);
  assert.equal(madeSince(null, since), false);
});

test('a character the GM set aside stays away', () => {
  const entity = { id: 'e1', created_at: '2026-11-19T11:00:00Z' };
  assert.equal(bringsInActor({ entity, createdAfter: since }), true);
  assert.equal(bringsInActor({ entity, createdAfter: since, excludedIds: ['e1'] }), false);
  assert.equal(bringsInActor({ entity: { created_at: entity.created_at }, createdAfter: since }), false);
});
