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

const { pickMapItemType, journalAccessForActorOwners, mapPageUuidOf } =
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
