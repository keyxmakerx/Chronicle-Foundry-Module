#!/usr/bin/env node
/**
 * `_map-handout.mjs`: a map the GM gave in Chronicle. Covers which page is a
 * handout (the marker must name the map it points at), which Has Item lines
 * are looked up, that a handout joins a sheet players see only when every
 * viewer is one of its holders, and who loses the journal when the item goes.
 * Also pins that a linked character's give goes through Chronicle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const {
  handoutMapId, handoutCandidates, handoutSeenOnlyByHolders, withHandoutHolder, journalAccessToRevoke,
} = await import('../scripts/_map-handout.mjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LV = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };

test('handoutMapId: the marker must name the map the page points at', () => {
  const cases = [
    ['a handout', { map_id: 'm1', fields_data: { chronicle_map_handout: 'm1' } }, 'm1'],
    ['pointed at a map, no marker', { map_id: 'm1', fields_data: {} }, null],
    ['marker names another map', { map_id: 'm1', fields_data: { chronicle_map_handout: 'm2' } }, null],
    ['marker, no map', { fields_data: { chronicle_map_handout: 'm1' } }, null],
    ['nothing', null, null],
  ];
  for (const [name, entity, want] of cases) assert.equal(handoutMapId(entity), want, name);
});

test('handoutCandidates: only visible Has Item lines named like a handout', () => {
  const rels = [
    { id: 'a', relationType: 'Has Item', targetEntityName: 'Map: Harbour' },
    { id: 'b', relationType: 'Has Item', targetEntityName: 'Map: Crypt', dmOnly: true },
    { id: 'c', relationType: 'Has Item', targetEntityName: 'Rope' },
    { id: 'd', relationType: 'Knows', targetEntityName: 'Map: Harbour' },
  ];
  assert.deepEqual(handoutCandidates(rels, 'Has Item').map((r) => r.id), ['a']);
  assert.deepEqual(handoutCandidates(null, 'Has Item'), []);
});

test('handoutSeenOnlyByHolders: every player who sees the actor must be on the page', () => {
  const perms = { visibility: 'custom', permissions: [
    { subject_type: 'role', subject_id: '2', permission: 'edit' },
    { subject_type: 'user', subject_id: 'c-mira', permission: 'view' },
  ] };
  const members = { mira: 'c-mira', tom: 'c-tom' };
  const memberOf = (id) => members[id] ?? null;
  const isGM = (id) => id === 'gm';
  const cases = [
    ['the holder alone', perms, { default: 0, gm: 3, mira: 3 }, true],
    ['another player observes the actor', perms, { default: 0, mira: 3, tom: 2 }, false],
    ['default lets everyone look', perms, { default: 1, mira: 3 }, false],
    ['an unlinked player', perms, { default: 0, mira: 3, nobody: 3 }, false],
    ['a player below LIMITED is not a viewer', perms, { default: 0, mira: 3, tom: 0 }, true],
    ['page not on an allow list', { visibility: 'default' }, { mira: 3 }, false],
    ['permissions unread', null, { mira: 3 }, false],
  ];
  for (const [name, p, own, want] of cases) {
    assert.equal(handoutSeenOnlyByHolders(p, own, isGM, memberOf, LV.LIMITED), want, name);
  }
});

test('withHandoutHolder: added once, taken out cleanly', () => {
  assert.deepEqual(withHandoutHolder({}, 'a1', true), ['a1']);
  assert.deepEqual(withHandoutHolder({ mapHandoutTo: ['a1'] }, 'a1', true), ['a1']);
  assert.deepEqual(withHandoutHolder({ mapHandoutTo: ['a1', 'a2', 7] }, 'a1', false), ['a2']);
});

test('journalAccessToRevoke: only the give\'s own OBSERVER, never someone still given the map', () => {
  const gm = new Set(['gm']);
  const all = ['p1', 'gm', 'default'];
  const cases = [
    ['the owner loses it', { p1: 3 }, { p1: 2 }, new Set(), all, ['p1']],
    ['owner of another given actor keeps it', { p1: 3 }, { p1: 2 }, new Set(['p1']), all, []],
    ['a level the GM raised further stays', { p1: 3 }, { p1: 3 }, new Set(), all, []],
    ['an OBSERVER the GM set by hand stays', { p1: 3 }, { p1: 2 }, new Set(), [], []],
    ['an observer of the actor was never granted', { p1: 2 }, { p1: 2 }, new Set(), all, []],
    ['GMs and default are never touched', { gm: 3, default: 3 }, { gm: 2, default: 2 }, new Set(), all, []],
  ];
  for (const [name, actor, journal, still, raised, want] of cases) {
    assert.deepEqual(journalAccessToRevoke(actor, journal, gm, still, LV, raised), want, name);
  }
});

test('pin: a linked character is given the map in Chronicle, not with a Foundry-only item', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/map-sheet-items.mjs'), 'utf8');
  const give = src.slice(src.indexOf('export async function giveMapToActor'));
  const post = give.indexOf("api.post('/stashes/give'");
  assert.ok(post > 0, 'posts the give to Chronicle');
  assert.ok(post < give.indexOf('createEmbeddedDocuments'), 'before any local item is made');
});

test('pin: a player\'s own Foundry add never sends a map handout under the GM\'s key', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/item-sync.mjs'), 'utf8');
  const add = src.slice(src.indexOf('async _playerAdd('));
  const refuse = add.indexOf('if (handoutMapId(page))');
  assert.ok(refuse > 0, 'the player path checks for a handout');
  assert.ok(refuse < add.indexOf('ownsCharacter('), 'before the owner\'s own add is sent');
});
