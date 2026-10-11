#!/usr/bin/env node
/**
 * Shop journals are found by the Chronicle type's slug, so a renamed shop
 * type still opens; the "Open shop" menu works on Foundry 12's and 13+'s
 * directory hooks and row shapes (scripts/_shop-journal.mjs).
 *
 * Run: node --test tools/test-shop-journal.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isShopJournal, journalFromRow, TYPE_SLUG_FLAG } from '../scripts/_shop-journal.mjs';

const SCOPE = 'chronicle-sync';
const journal = (flags) => ({ id: 'j1', getFlag: (s, k) => (s === SCOPE ? flags[k] : undefined) });

test('a journal is a shop by its type slug, whatever the type is called', () => {
  assert.equal(isShopJournal(journal({ entityId: 'e', [TYPE_SLUG_FLAG]: 'shop', entityType: 'Merchants' }), SCOPE), true);
  assert.equal(isShopJournal(journal({ entityId: 'e', [TYPE_SLUG_FLAG]: 'npc', entityType: 'Shop' }), SCOPE), false);
});

test('without a recorded slug the type name decides', () => {
  assert.equal(isShopJournal(journal({ entityId: 'e', entityType: 'Shop' }), SCOPE), true);
  assert.equal(isShopJournal(journal({ entityId: 'e', entityType: ' shop ' }), SCOPE), true);
  assert.equal(isShopJournal(journal({ entityId: 'e', entityType: 'Shops' }), SCOPE), false);
});

test('an unlinked journal is never a shop', () => {
  assert.equal(isShopJournal(journal({ [TYPE_SLUG_FLAG]: 'shop' }), SCOPE), false);
  assert.equal(isShopJournal(null, SCOPE), false);
});

test('a directory row resolves on either Foundry row shape', () => {
  const j = journal({});
  globalThis.game = { journal: { get: (id) => (id === 'j1' ? j : undefined) } };
  globalThis.HTMLElement = class {};
  const v13 = Object.assign(new HTMLElement(), { dataset: { entryId: 'j1' } });
  assert.equal(journalFromRow(v13), j);
  assert.equal(journalFromRow([{ dataset: { documentId: 'j1' } }]), j);
  assert.equal(journalFromRow([{ dataset: {} }]), null);
});

test('the shop menu listens on both directory hook names and records the slug', () => {
  const widget = readFileSync(new URL('../scripts/shop-widget.mjs', import.meta.url), 'utf8');
  assert.match(widget, /Hooks\.on\('getJournalEntryContext', addOpenShop\)/);
  assert.match(widget, /Hooks\.on\('getJournalEntryContextOptions', addOpenShop\)/);
  assert.doesNotMatch(widget, /=== 'Shop'/);
  const sync = readFileSync(new URL('../scripts/journal-sync.mjs', import.meta.url), 'utf8');
  assert.equal((sync.match(/entity\.type_slug/g) || []).length, 2, 'create and update both record the slug');
});
