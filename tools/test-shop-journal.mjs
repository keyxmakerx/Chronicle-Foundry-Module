#!/usr/bin/env node
/**
 * Shop journals are found by the Chronicle type's slug, so a renamed shop
 * type still opens; the "Open shop" menu works on Foundry 12's and 13+'s
 * directory hooks and row shapes, and a shop's journal page carries its
 * door (scripts/_shop-journal.mjs).
 *
 * Run: node --test tools/test-shop-journal.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addJournalDoor, isShopJournal, journalFromRow, TYPE_SLUG_FLAG } from '../scripts/_shop-journal.mjs';

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

// Just enough DOM for the door: elements found by class, a pages area that
// takes children at the front, and the markup's spans as real children.
class El {
  constructor(tag, cls = '') { this.tagName = tag; this.className = cls; this.children = []; this.attrs = {}; this.listeners = {}; this.textContent = ''; this._html = ''; }
  set innerHTML(h) { this._html = h; this.children = [...h.matchAll(/<span class="(\w+)">/g)].map((m) => new El('span', m[1])); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  prepend(el) { this.children.unshift(el); }
  querySelector(sel) {
    const cls = sel.replace(':scope > ', '').match(/^\.([\w-]+)$/)?.[1];
    if (!cls) return null;
    const walk = (el) => { for (const c of el.children) { if (c.className === cls) return c; const f = !sel.startsWith(':scope') && walk(c); if (f) return f; } return null; };
    return walk(this);
  }
}

test('a shop journal page gets one door, its name as text, that walks in when pressed', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  const root = new El('div');
  const pages = new El('div', 'journal-entry-pages');
  pages.children.push(new El('section', 'journal-entry-page'));
  root.children.push(pages);
  let opened = 0;
  const name = '<img src=x onerror=alert(1)> Spikes';
  addJournalDoor(root, name, 'Step inside', () => opened++);
  addJournalDoor(root, name, 'Step inside', () => opened++);
  const doors = pages.children.filter((c) => c.className === 'chronicle-shop-door');
  assert.equal(doors.length, 1, 'a re-render adds no second door');
  const door = pages.children[0];
  assert.equal(door.className, 'chronicle-shop-door', 'the door comes first, above the pages');
  assert.equal(door.tagName, 'button');
  assert.equal(door.type, 'button');
  assert.equal(door.querySelector('.name').textContent, name);
  assert.doesNotMatch(door.innerHTML, /Spikes|onerror/, 'the name never goes in as markup');
  assert.equal(door.querySelector('.hint').textContent, 'Step inside');
  door.listeners.click({ preventDefault() {} });
  assert.equal(opened, 1);
});

test('a sheet with no pages area gets no door', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  assert.doesNotThrow(() => addJournalDoor(new El('div'), 'Spikes', 'Step inside', () => {}));
  assert.doesNotThrow(() => addJournalDoor(null, 'Spikes', 'Step inside', () => {}));
});

test('the door walks in: the journal button passes enter, and both openers honour it', () => {
  const win = readFileSync(new URL('../scripts/shop-room-window.mjs', import.meta.url), 'utf8');
  assert.match(win, /addJournalDoor\(root, journal\.name, t\('StepInside'\), \(\) => open\(\{ enter: true \}\)\)/);
  assert.match(win, /selfOpened: true, closed, enter,/);
  const widget = readFileSync(new URL('../scripts/shop-widget.mjs', import.meta.url), 'utf8');
  assert.match(widget, /async openShop\(entityId, shopName, \{ enter = false \} = \{\}\)/);
  assert.match(widget, /if \(enter\) open\.enter\(\);/);
  const mod = readFileSync(new URL('../scripts/module.mjs', import.meta.url), 'utf8');
  assert.match(mod, /registerShopJournalButton\(\(id, name, opts\) => shopWidget\.openShop\(id, name, opts\)\)/);
});
