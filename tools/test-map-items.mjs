#!/usr/bin/env node
/**
 * `_map-item-rules.mjs`: giving a Chronicle map to a character. Covers the
 * item type a map becomes on different systems, the journal access its
 * owners get (raise only, never GMs or default), and the UUID an item may
 * point at. Also pins that the sheet hooks are registered for every client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { pickMapItemType, journalAccessForActorOwners, journalAccessForCarriedMaps, mapPageUuidOf } =
  await import('../scripts/_map-item-rules.mjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LV = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };

test('pickMapItemType: prefers carried-thing types, else the first real type', () => {
  assert.equal(pickMapItemType(['weapon', 'equipment', 'loot', 'spell']), 'loot', 'dnd5e');
  assert.equal(pickMapItemType(['ability', 'treasure', 'kit']), 'treasure');
  assert.equal(pickMapItemType(['base', 'feature', 'title']), 'feature', 'no preferred type');
  assert.equal(pickMapItemType(['base']), null);
  assert.equal(pickMapItemType(undefined), null);
});

test('journalAccessForActorOwners: owners get observer; nobody is lowered', () => {
  const access = journalAccessForActorOwners(
    { default: 0, gm1: 3, p1: 3, p2: 3, p3: 2 },
    { default: 0, p2: 3 },
    new Set(['gm1']),
    LV,
  );
  assert.deepEqual(access, { p1: 2 }, 'p2 already owns the journal; p3 only observes the actor; GM and default untouched');
  assert.deepEqual(journalAccessForActorOwners({ p1: 3 }, { p1: 2 }, new Set(), LV), {});
  assert.deepEqual(journalAccessForActorOwners(null, null, new Set(), LV), {});
});

test('mapPageUuidOf: only a JournalEntryPage UUID', () => {
  const ok = 'JournalEntry.abcdefghijklmnop.JournalEntryPage.ABCDEFGHIJKLMNOP';
  assert.equal(mapPageUuidOf({ mapPageUuid: ok }), ok);
  assert.equal(mapPageUuidOf({ mapPageUuid: 'Actor.abcdefghijklmnop' }), null);
  assert.equal(mapPageUuidOf({ mapPageUuid: `${ok}"><img>` }), null);
  assert.equal(mapPageUuidOf(null), null);
});

test('pin: sheet hooks are registered for every client, not only the GM', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/module.mjs'), 'utf8');
  const ready = src.slice(src.indexOf("Hooks.once('ready'"));
  const call = ready.indexOf('registerMapSheetItems();');
  assert.ok(call > 0, 'registerMapSheetItems is called on ready');
  assert.ok(!/if\s*\(\s*!?game\.user\.isGM/.test(ready.slice(0, call)), 'no GM gate before it');
});

test('journalAccessForCarriedMaps: a later owner is raised on every carried map, never lowered', () => {
  const gm = new Set(['gm1']);
  const actor = { gm1: 3, p1: 3, p2: 3, p3: 2, default: 0 };
  const cases = [
    ['new owner on one map', actor, [{ id: 'j1', ownership: { p1: 2 } }], { j1: { p2: 2 } }],
    ['two maps, each judged alone', actor, [{ id: 'j1', ownership: { p1: 2 } }, { id: 'j2', ownership: { p1: 2, p2: 3 } }], { j1: { p2: 2 }, j2: undefined }],
    ['an owner already above observer is kept', { p1: 3 }, [{ id: 'j1', ownership: { p1: 3 } }], {}],
    ['a limited observer-to-be is raised', { p1: 3 }, [{ id: 'j1', ownership: { p1: 1 } }], { j1: { p1: 2 } }],
    ['a map listed twice is done once', { p1: 3 }, [{ id: 'j1', ownership: {} }, { id: 'j1', ownership: {} }], { j1: { p1: 2 } }],
    ['no maps, nothing to do', actor, [], {}],
    ['non-owners and GMs are ignored', { gm1: 3, p3: 2, default: 3 }, [{ id: 'j1', ownership: {} }], {}],
  ];
  for (const [name, own, journals, want] of cases) {
    const got = journalAccessForCarriedMaps(own, journals, gm, LV);
    const expect = new Map(Object.entries(want).filter(([, v]) => v));
    assert.deepEqual(got, expect, name);
  }
});

test('the module reapplies the grant when an actor\'s ownership changes (GM client only)', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/map-sheet-items.mjs'), 'utf8');
  assert.match(src, /Hooks\.on\('updateActor', _onUpdateActor\)/);
  assert.match(src, /async function _onUpdateActor[\s\S]*?!game\.user\.isGM[\s\S]*?'ownership' in changes/);
});
