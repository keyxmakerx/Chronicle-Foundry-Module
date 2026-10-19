#!/usr/bin/env node
/**
 * The DM Screen's Cast and Party tabs. Cast lists only tokens that belong to
 * a Chronicle page and to no player, so a hero never shows as an NPC. Party
 * reads the shared stashes through one stable hero and draws what Chronicle
 * sent, and both tabs are mounted, torn down and labelled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { castRows } from '../scripts/_npc-presence.mjs';
import { stashHero, stashRows } from '../scripts/_dm-party.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('Cast keeps Chronicle NPC tokens only, sorted by name', () => {
  const rows = castRows([
    { id: 't3', name: 'Varra', entityId: 'e1', playerOwned: false, hidden: true, talking: false, typeName: 'Character' },
    { id: 't1', name: 'Mira', entityId: 'e2', playerOwned: true, hidden: false, talking: false },
    { id: 't2', name: 'Goblin', entityId: null, playerOwned: false, hidden: false, talking: false },
    { id: 't4', name: 'Ferryman', entityId: 'e3', playerOwned: false, hidden: false, talking: true },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['t4', 't3']);
  assert.equal(rows[1].hidden, true);
  assert.equal(rows[0].talking, true);
  assert.equal(rows[1].typeName, 'Character');
});

test('Cast keeps every token of the same NPC, in a stable order', () => {
  const rows = castRows([
    { id: 'b', name: 'Guard', entityId: 'e1', playerOwned: false },
    { id: 'a', name: 'Guard', entityId: 'e1', playerOwned: false },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(castRows(null), []);
});

test('Party reads stashes through the first synced hero by name', () => {
  assert.deepEqual(stashHero([
    { id: 'a2', name: 'Tobin', entityId: 'c2', playerOwned: true },
    { id: 'a1', name: 'Kael', entityId: 'c1', playerOwned: true },
    { id: 'a0', name: 'Aaron the NPC', entityId: 'c0', playerOwned: false },
    { id: 'a3', name: 'Abel', entityId: null, playerOwned: true },
  ]), { id: 'a1', name: 'Kael', entityId: 'c1' });
  assert.equal(stashHero([]), null);
});

test('Party draws the shared stashes from a stash view', () => {
  const rows = stashRows({
    character: { id: 'c1', name: 'Kael', money: 3, items: [] },
    stashes: [
      { id: 7, name: 'Party chest', money: 214.5, items: [{ itemId: 'i1', name: 'Rope', quantity: 2 }, { id: 'i2', name: 'Lamp' }] },
      { name: 'No id' },
    ],
  });
  assert.deepEqual(rows, [{
    id: '7', name: 'Party chest', money: '214.50',
    items: [{ name: 'Rope', quantity: 2 }, { name: 'Lamp', quantity: 1 }],
  }]);
  assert.equal(stashRows({}), null);
});

test('the DM Screen mounts, tears down and labels both tabs', async () => {
  const src = await read('scripts/dm-screen.mjs');
  const hbs = await read('templates/dm-screen.hbs');
  const lang = JSON.parse(await read('lang/en.json'));
  assert.match(src, /this\._cast\.mount\(cast\)/);
  assert.match(src, /this\._party\.mount\(party\)/);
  assert.match(src, /this\._cast\.destroy\(\);\s*this\._party\.destroy\(\);/);
  for (const tab of ['cast', 'party']) {
    assert.match(hbs, new RegExp(`data-tab="${tab}"`));
    assert.match(hbs, new RegExp(`data-dms-pane="${tab}"`));
  }
  const keys = (pane) => Object.keys(lang.CHRONICLE.DMScreen[pane]);
  for (const file of ['scripts/dm-cast.mjs', 'scripts/dm-party.mjs']) {
    const body = await read(file);
    const pane = file.includes('cast') ? 'Cast' : 'Party';
    for (const [, key] of body.matchAll(/\bt\('([A-Za-z]+)'/g)) assert.ok(keys(pane).includes(key), `${pane}.${key}`);
  }
});

test('Cast runs the token HUD actions, GM only', async () => {
  const src = await read('scripts/npc-presence.mjs');
  const body = src.slice(src.indexOf('export async function castAction'), src.indexOf('/* ---------------- Spotlight'));
  assert.match(body, /if \(!game\.user\.isGM\) return;/);
  assert.match(body, /_spotlight\(token\)/);
  assert.match(body, /_toggleTalk\(token\)/);
});
