#!/usr/bin/env node
/**
 * Heroes and NPCs folders for character actors.
 *
 * Run: `node --test tools/test-actor-folder.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { folderKindFor, needsPlacing, HEROES, NPCS, FOLDER_PLACED_FLAG } from '../scripts/_actor-folder.mjs';

test('folderKindFor', () => {
  const cases = [
    ['claimed page', { entity: { owner_user_id: 'u1' }, actor: {} }, HEROES],
    ['player sub-type page', { entity: { entity_type_id: 7 }, actor: {}, pcSubtypeId: 7 }, HEROES],
    ['actor a player owns', { entity: {}, actor: { hasPlayerOwner: true } }, HEROES],
    ['nobody owns it', { entity: { entity_type_id: 3 }, actor: { hasPlayerOwner: false }, pcSubtypeId: 7 }, NPCS],
    ['no sub-type known', { entity: { entity_type_id: undefined }, actor: {}, pcSubtypeId: null }, NPCS],
  ];
  for (const [name, input, want] of cases) assert.equal(folderKindFor(input), want, name);
});

test('needsPlacing', () => {
  const flags = (v) => ({ getFlag: (_s, k) => (k === FOLDER_PLACED_FLAG ? v : undefined) });
  assert.equal(needsPlacing({ ...flags(undefined) }, 'chronicle-sync'), true, 'new and loose');
  assert.equal(needsPlacing({ folder: { id: 'f' }, ...flags(undefined) }, 'chronicle-sync'), false, 'already in a folder');
  assert.equal(needsPlacing({ ...flags(true) }, 'chronicle-sync'), false, 'placed before, then taken out by the GM');
});
