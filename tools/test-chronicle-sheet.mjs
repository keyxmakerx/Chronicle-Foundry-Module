#!/usr/bin/env node
/** Pins the Chronicle sheet's rules (scripts/_chronicle-sheet-model.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHRONICLE_SHEET_CLASS, MAX_FACTS, pageTitleHidden, playerSafeFacts, sheetClassPlan, sheetModel,
} from '../scripts/_chronicle-sheet-model.mjs';

const defs = [
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'region', label: 'Region', type: 'select' },
  { key: 'ruler', label: 'Ruler', type: 'text' },
  { key: 'gm_notes', label: 'GM notes', type: 'text', gm_only: true },
  { key: 'backstory', label: 'Backstory', type: 'text', owner_only: true },
  { key: 'divider', label: 'Basics', type: 'rule' },
  { key: 'history', label: 'History', type: 'textarea' },
  { key: 'walled', label: 'Walled', type: 'checkbox' },
  { key: 'pop', label: 'Population', type: 'number' },
  { key: 'gods', label: 'Shrines', type: 'text' },
];

test('facts carry only values every reader of the journal may see', () => {
  const facts = playerSafeFacts({
    type: 'City', region: ' Imix ', ruler: 'Warden Maric Toldt',
    gm_notes: 'The clerk is bribed', backstory: 'Owner only', divider: 'x', history: 'long text',
    walled: true, pop: 4200, gods: ['Aðr', 'Sekhar'], undefined_field: 'no definition',
  }, defs);
  assert.deepEqual(facts, [
    { label: 'Type', value: 'City' },
    { label: 'Region', value: 'Imix' },
    { label: 'Ruler', value: 'Warden Maric Toldt' },
    { label: 'Walled', value: 'Yes' },
    { label: 'Population', value: '4200' },
    { label: 'Shrines', value: 'Aðr, Sekhar' },
  ]);
  const text = JSON.stringify(facts);
  for (const secret of ['bribed', 'Owner only', 'no definition']) assert.ok(!text.includes(secret), secret);
});

test('facts are empty, never guessed, without definitions or values', () => {
  assert.deepEqual(playerSafeFacts({ type: 'City' }, null), []);
  assert.deepEqual(playerSafeFacts(null, defs), []);
  assert.deepEqual(playerSafeFacts({ type: '', walled: false, ruler: { name: 'x' }, pop: NaN }, defs), []);
});

test('facts are capped and short', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}`, label: `F${i}` }));
  const data = Object.fromEntries(many.map((d) => [d.key, 'x'.repeat(400)]));
  const facts = playerSafeFacts(data, many);
  assert.equal(facts.length, MAX_FACTS);
  assert.equal(facts[0].value.length, 160);
});

const labels = { overview: 'Overview', playerNotes: 'Player notes' };

test('the header shows category then folder, once each', () => {
  const m = sheetModel({ category: 'Lore', folder: 'Gods', tags: ['gods', ' '], facts: [], pages: [] }, labels);
  assert.deepEqual(m.eyebrow, ['Lore', 'Gods']);
  assert.deepEqual(m.tags, ['gods']);
  assert.deepEqual(sheetModel({ category: 'Lore', folder: 'Lore', pages: [] }, labels).eyebrow, ['Lore']);
  assert.deepEqual(sheetModel({ pages: [] }, labels).eyebrow, []);
});

test('the lead text is not listed twice when the page also has an Overview heading', () => {
  const pages = [
    { id: 'lead', name: 'Overview', type: 'text', sort: 1 },
    { id: 'ov', name: 'Overview', type: 'text', sort: 2 },
    { id: 'rule', name: 'The hidden rule', type: 'text', sort: 3 },
  ];
  assert.deepEqual(sheetModel({ pages }, labels).contents.map((c) => c.pageId), ['ov', 'rule']);
});

test('contents list the text sections in order, and only when there are several', () => {
  const pages = [
    { id: 'p3', name: 'Sayings', type: 'text', sort: 3 },
    { id: 'img', name: 'Image', type: 'image', sort: 0 },
    { id: 'p1', name: 'Overview', type: 'text', sort: 1 },
    { id: 'p2', name: 'Worship today', type: 'text', sort: 2 },
    { id: 'pn', name: 'Player Notes', type: 'text', sort: 4, isPlayerNotes: true },
  ];
  assert.deepEqual(sheetModel({ pages }, labels).contents.map((c) => [c.pageId, c.label]), [
    ['p1', 'Overview'], ['p2', 'Worship today'], ['p3', 'Sayings'], ['pn', 'Player notes'],
  ]);
  assert.deepEqual(sheetModel({ pages: [{ id: 'a', name: 'Content', type: 'text', sort: 1 }] }, labels).contents, []);
});

test('the sheet is offered once, and a GM choice is kept', () => {
  const journals = [
    { id: 'new', linked: true, sheetClass: '', offered: false },
    { id: 'chose-other', linked: true, sheetClass: 'monks.Sheet', offered: false },
    { id: 'switched-back', linked: true, sheetClass: '', offered: true },
    { id: 'has-it', linked: true, sheetClass: CHRONICLE_SHEET_CLASS, offered: true },
    { id: 'foundry-only', linked: false, sheetClass: '', offered: false },
  ];
  assert.deepEqual(sheetClassPlan(journals, true), [
    { id: 'new', sheetClass: CHRONICLE_SHEET_CLASS, offered: true },
    { id: 'chose-other', sheetClass: 'monks.Sheet', offered: true },
  ]);
  // Running it again changes nothing.
  const after = journals.map((j) => ({ ...j, ...(sheetClassPlan([j], true)[0] ?? {}) }));
  assert.deepEqual(sheetClassPlan(after, true), []);
});

test('turning the setting off takes back only the sheet it gave', () => {
  const journals = [
    { id: 'has-it', linked: true, sheetClass: CHRONICLE_SHEET_CLASS, offered: true },
    { id: 'chose-other', linked: true, sheetClass: 'monks.Sheet', offered: true },
    { id: 'switched-back', linked: true, sheetClass: '', offered: true },
  ];
  assert.deepEqual(sheetClassPlan(journals, false), [{ id: 'has-it', sheetClass: '', offered: false }]);
});

test('the sheet id matches its registration', () => {
  const src = readFileSync(new URL('../scripts/chronicle-sheet.mjs', import.meta.url), 'utf8');
  const [scope, name] = CHRONICLE_SHEET_CLASS.split('.');
  assert.equal(scope, JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8')).id);
  assert.match(src, new RegExp(`class ${name} extends Base`));
  assert.match(src, /registerSheet\(JournalEntry, MODULE_ID, ChronicleJournalSheet/);
});

test('a page title is left out only where the page text already says it', () => {
  assert.equal(pageTitleHidden({ name: 'Ways out', html: '<h2>Ways out</h2><p>…</p>' }), true);
  assert.equal(pageTitleHidden({ name: 'Ways out', html: '<div><h2>Ways <b>out</b></h2></div>' }), true);
  // The lead text of a synced page: its title is sync's stand-in.
  assert.equal(pageTitleHidden({ name: 'Overview', html: '<p>Lead</p>', linked: true }), true);
  // A GM's own page, or one in a journal that isn't synced, keeps its title.
  assert.equal(pageTitleHidden({ name: 'Overview', html: '<p>Lead</p>', linked: false }), false);
  assert.equal(pageTitleHidden({ name: 'Session prep', html: '<p>Notes</p>', linked: true }), false);
  assert.equal(pageTitleHidden({ name: 'Session prep', html: '<h2>Something else</h2>', linked: true }), false);
  assert.equal(pageTitleHidden({ name: 'Player Notes', html: '<h2>Player Notes</h2>', isPlayerNotes: true }), false);
});
