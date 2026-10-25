#!/usr/bin/env node
/**
 * A creature page Chronicle matched to a monster Foundry already has: playing
 * Foundry's numbers, a fight places Foundry's own monster (a world actor no
 * page made, else that monster's compendium) and never the page's actor;
 * playing the page's numbers, only the page's actor will do.
 *
 * Run: `node --test tools/test-creature-matches.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { playsFoundry, playsPage, rowAsPlayed, unwrapMatches } from '../scripts/_creature-matches.mjs';
import { compendiumFallback, resolveActor } from '../scripts/_encounter-roster.mjs';

const stalker = { name: 'Stalker', pack: 'Monsters' };
const matches = unwrapMatches({ data: [
  { entityId: 'p1', state: 'matched', use: 'foundry', monster: stalker },
  { entityId: 'p2', state: 'matched', use: 'page', monster: stalker },
  { entityId: 'p3', state: 'suggested', monster: stalker },
  { entityId: 'p4', state: 'missing', use: 'page', monster: stalker },
  { state: 'matched' },
] });

test('matches unwrap by page, from either list shape', () => {
  assert.equal(matches.size, 4);
  assert.equal(unwrapMatches([{ entityId: 'x', state: 'none' }]).size, 1);
  assert.equal(unwrapMatches(null).size, 0);
});

test('whose numbers play', () => {
  assert.equal(playsFoundry(matches.get('p1')), true);
  assert.equal(playsFoundry(matches.get('p2')), false);
  assert.equal(playsFoundry(matches.get('p3')), false, 'a look-alike plays as before');
  assert.equal(playsPage(matches.get('p2')), true);
  assert.equal(playsPage(matches.get('p4')), true, 'a match Foundry lost plays the page');
  assert.equal(playsFoundry({ state: 'matched', use: 'foundry' }), false, 'no monster, no match');
});

const actors = [
  { id: 'a-page', name: 'Stalker', linkedEntityId: 'p1', inCreatureFolder: true },
  { id: 'a-page2', name: 'Stalker', linkedEntityId: 'p2', inCreatureFolder: true },
  { id: 'a-world', name: 'stalker', linkedEntityId: '' },
];
const entries = [{ name: 'Stalker', uuid: 'u-other', pack: 'Homebrew' }, { name: 'Stalker', uuid: 'u-mon', pack: 'Monsters' }];

test('a page playing Foundry\'s numbers places Foundry\'s monster', () => {
  const row = rowAsPlayed({ entityId: 'p1', baseName: 'Stalker' }, matches);
  assert.deepEqual(row.foundryMonster, stalker);
  assert.equal(resolveActor(row, actors).actor.id, 'a-world', 'never the page\'s own actor');
  assert.equal(resolveActor(row, actors.filter((a) => a.id !== 'a-world')), null);
  assert.equal(compendiumFallback(row, entries).uuid, 'u-mon', 'the matched compendium first');
});

test('a page playing its own numbers takes only its actor', () => {
  const row = rowAsPlayed({ entityId: 'p2', baseName: 'Stalker' }, matches);
  assert.equal(row.pageOnly, true);
  assert.equal(resolveActor(row, actors).actor.id, 'a-page2');
  assert.equal(resolveActor(row, actors.filter((a) => a.id !== 'a-page2')), null, 'not a same-named world actor');
  assert.equal(compendiumFallback(row, entries), null, 'not a compendium copy');
});

test('rows with no match place as before', () => {
  const row = { entityId: 'p9', baseName: 'Stalker' };
  assert.equal(rowAsPlayed(row, matches), row);
  assert.equal(rowAsPlayed(row, null), row);
  assert.equal(resolveActor(row, actors).actor.id, 'a-page', 'the creatures folder first, as before');
  assert.equal(compendiumFallback({ baseName: 'Stalker' }, entries).uuid, 'u-other', 'the first compendium, as before');
});
