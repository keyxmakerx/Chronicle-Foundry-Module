#!/usr/bin/env node
/**
 * The Satchel: the notebook, quest board and stash in one window. Its tabs
 * are the module's existing windows drawn inside it, so these pin that each
 * one is drawn frameless into its tab, that a notice opens in place, that
 * closing the Satchel closes them, and whose stash the Stash tab shows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { satchelTab, SATCHEL_TABS, stashActor } from '../scripts/_satchel.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('three tabs, and an unknown one falls back to the notebook', () => {
  assert.deepEqual(SATCHEL_TABS, ['notebook', 'quests', 'stash']);
  assert.equal(satchelTab('stash'), 'stash');
  assert.equal(satchelTab('nope'), 'notebook');
  assert.equal(satchelTab(undefined), 'notebook');
});

const test2 = { linked: (a) => !!a.entityId, allowed: (a) => a.owner };

test('the Stash tab shows the assigned character when it can', () => {
  const mine = { id: 'z', name: 'Zed', entityId: 'c9', owner: true };
  const other = { id: 'a', name: 'Abel', entityId: 'c1', owner: true };
  assert.equal(stashActor({ character: mine }, [other, mine], test2), mine);
});

test('otherwise the first synced character the player may open, by name', () => {
  const actors = [
    { id: 'b', name: 'Bren', entityId: 'c2', owner: true },
    { id: 'a2', name: 'Abel', entityId: 'c1', owner: true },
    { id: 'a1', name: 'Abel', entityId: null, owner: true },
    { id: 'a0', name: 'Aaron', entityId: 'c0', owner: false },
  ];
  assert.equal(stashActor({ character: { name: 'Unsynced', owner: true } }, actors, test2).id, 'a2');
  assert.equal(stashActor({}, [], test2), null);
  assert.equal(stashActor(null, null, test2), null);
});

test('each tab is the existing window, drawn frameless into its tab', async () => {
  const src = await read('scripts/satchel.mjs');
  assert.match(src, /static DEFAULT_OPTIONS = \{ window: \{ frame: false, positioned: false \} \};/);
  assert.match(src, /_insertElement\(element\) \{\s*this\.pane\?\.replaceChildren\(element\);/);
  assert.match(src, /hosted\(QuestBoardWindow\)/);
  assert.match(src, /hosted\(QuestSheetWindow\)/);
  assert.match(src, /hosted\(StashesWindow\)/);
  assert.match(src, /new FrameHost\('journal', box\)/);
  // A notice opens in the Satchel rather than in a window of its own.
  assert.match(src, /openQuest\(id\) \{\s*this\.satchel\?\.showQuest\(id\);/);
  const board = await read('scripts/quest-board.mjs');
  assert.match(board, /if \(id\) this\.openQuest\(id\);/);
  // Closing the Satchel closes what it holds and drops the frame's listener.
  assert.match(src, /this\._notebook\?\.destroy\(\);/);
  assert.match(src, /for \(const child of \[this\._board, this\._sheet, this\._stash\]\) child\?\.close\(\);/);
});

test('the notebook opens in the Satchel, and the four buttons and shortcuts reach it', async () => {
  const nb = await read('scripts/player-notebook.mjs');
  assert.match(nb, /await openSatchel\('notebook', \{ noteId \}\);/);
  assert.doesNotMatch(nb, /class NotebookApplication/);
  const mod = await read('scripts/module.mjs');
  assert.match(mod, /openSatchel: \(\) => \{ openSatchel\(\); \}/);
  assert.match(mod, /satchel: \(\) => \{ openSatchel\(\); \}/);
});

test('every Satchel string is in en.json', async () => {
  const src = await read('scripts/satchel.mjs');
  const lang = JSON.parse(await read('lang/en.json')).CHRONICLE.Satchel;
  const get = (k) => k.split('.').reduce((o, p) => o?.[p], lang);
  for (const [, key] of src.matchAll(/\bt\('([A-Za-z.]+)'/g)) assert.equal(typeof get(key), 'string', key);
  for (const tab of SATCHEL_TABS) assert.equal(typeof lang.Tab[tab], 'string', tab);
  for (const key of ['StashGM', 'StashOff', 'StashNoCharacter']) {
    assert.equal(typeof lang[key], 'string', key);
    assert.equal(typeof lang[`${key}Title`], 'string', `${key}Title`);
  }
});
