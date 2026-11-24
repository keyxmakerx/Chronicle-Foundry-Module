#!/usr/bin/env node
/**
 * Negotiation mirror rules (scripts/_negotiation-mirror.mjs): which message
 * counts, that only the players' half of the tracker reaches the actor, which
 * actors a page owns, and that an unchanged tracker writes nothing. Also pins
 * that the glue is Draw Steel only, active-GM only and never notifies.
 *
 * Run: node --test tools/test-negotiation-mirror.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  isNegotiationMessage, toFoundryNegotiation, pickNegotiationActors, negotiationChanges, SHOWN_PATH,
} from '../scripts/_negotiation-mirror.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const glue = readFileSync(resolve(REPO_ROOT, 'scripts/negotiation-mirror.mjs'), 'utf8');

const good = { type: 'system_state.updated', resourceId: 'e1', payload: { systemId: 'drawsteel', key: 'negotiation' } };

test('isNegotiationMessage: only the drawsteel negotiation state of a page', () => {
  assert.equal(isNegotiationMessage(good), true);
  for (const bad of [
    null, {}, { ...good, type: 'entity.updated' }, { ...good, resourceId: '' },
    { ...good, payload: { systemId: 'dnd5e', key: 'negotiation' } },
    { ...good, payload: { systemId: 'drawsteel', key: 'other' } },
    { ...good, payload: null },
  ]) assert.equal(isNegotiationMessage(bad), false);
});

test('toFoundryNegotiation: saves only found entries still on the list, with the authority rename', () => {
  const u = toFoundryNegotiation({
    interest: 3, patience: 2, impression: 1, shown: true,
    motivations: ['power', 'higher-authority', 'greed'], pitfalls: ['peace', 'justice'],
    found: { motivations: ['higher-authority', 'greed', 'revelry'], pitfalls: ['justice'] },
  });
  assert.deepEqual(u, {
    'system.negotiation.motivations': ['authority', 'greed'],
    'system.negotiation.pitfalls': ['justice'],
    'flags.chronicle-sync.negotiationShown': true,
    'system.negotiation.interest': 3,
    'system.negotiation.patience': 2,
  });
});

test('toFoundryNegotiation: says whether the meters are shown, so players never read starting values', () => {
  assert.equal(toFoundryNegotiation({ interest: 3, motivations: [] })[SHOWN_PATH], false);
  assert.equal(toFoundryNegotiation({ interest: 3, shown: true, motivations: [] })[SHOWN_PATH], true);
  assert.equal(SHOWN_PATH, 'flags.chronicle-sync.negotiationShown');
});

test('toFoundryNegotiation: an unfound motivation or pitfall never reaches the actor', () => {
  const u = toFoundryNegotiation({ interest: 3, patience: 2, motivations: ['greed', 'legacy'], pitfalls: ['justice'], found: { motivations: ['greed'] } });
  assert.deepEqual(u['system.negotiation.motivations'], ['greed']);
  assert.deepEqual(u['system.negotiation.pitfalls'], []);
  const none = toFoundryNegotiation({ interest: 3, motivations: ['greed'], pitfalls: ['peace'] });
  // Empty lists, not absent ones, so lists an older mirror saved are replaced.
  assert.deepEqual(none['system.negotiation.motivations'], []);
  assert.deepEqual(none['system.negotiation.pitfalls'], []);
  assert.equal(JSON.stringify(none).includes('peace'), false);
});

test('toFoundryNegotiation: meters only once shown, impression never', () => {
  const hidden = toFoundryNegotiation({ interest: 3, patience: 2, impression: 4, motivations: [] });
  assert.equal('system.negotiation.interest' in hidden, false);
  assert.equal('system.negotiation.patience' in hidden, false);
  assert.equal('system.negotiation.impression' in hidden, false);
  const shown = toFoundryNegotiation({ interest: 9, patience: -4, impression: 4, shown: true });
  assert.equal(shown['system.negotiation.interest'], 5);
  assert.equal(shown['system.negotiation.patience'], 0);
  assert.equal('system.negotiation.impression' in shown, false);
  assert.equal('system.negotiation.interest' in toFoundryNegotiation({ interest: 3, shown: 'yes' }), false);
});

test('toFoundryNegotiation: drops unknown slugs and duplicates, tolerates bad shapes', () => {
  const u = toFoundryNegotiation({ motivations: ['nope', 'justice', 'justice'], pitfalls: 'x', found: { motivations: ['nope', 'justice', 'justice'], pitfalls: 'x' } });
  assert.deepEqual(u['system.negotiation.motivations'], ['justice']);
  assert.deepEqual(u['system.negotiation.pitfalls'], []);
  assert.deepEqual(toFoundryNegotiation({ interest: 1, found: 'x' })['system.negotiation.motivations'], []);
});

test('toFoundryNegotiation: empty or invalid gm gives null', () => {
  for (const v of [null, undefined, {}, [], 'x', 4]) assert.equal(toFoundryNegotiation(v), null);
});

const actors = [
  { id: 'a1', name: 'Captain Varra', type: 'npc' },
  { id: 'a2', name: 'Other', type: 'npc', linkedEntityId: 'e1' },
  { id: 'a3', name: 'Captain Varra', type: 'hero', pageId: 'e7' },
];

test('pickNegotiationActors: explicit link wins over a name match', () => {
  assert.deepEqual(pickNegotiationActors({ entityId: 'e1', pageName: 'Captain Varra', actors }), ['a2']);
});

test('pickNegotiationActors: an NPC actor made from the page by character sync is the page\'s', () => {
  const synced = [...actors, { id: 'a5', name: 'Orsen Vey', type: 'npc', pageId: 'e5' }];
  assert.deepEqual(pickNegotiationActors({ entityId: 'e5', pageName: 'Somebody else', actors: synced }), ['a5']);
  // Another page's synced NPC is never taken by its name.
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: 'Orsen Vey', actors: synced }), []);
});

test('pickNegotiationActors: unique NPC name match when nothing is linked', () => {
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: ' captain  VARRA ', actors }), ['a1']);
});

test('pickNegotiationActors: ties, heroes, non-NPCs and other pages links are left alone', () => {
  const dup = [...actors, { id: 'a4', name: 'Captain Varra', type: 'npc' }];
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: 'Captain Varra', actors: dup }), []);
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: 'Other', actors }), []);
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: '', actors }), []);
  assert.deepEqual(pickNegotiationActors({ entityId: 'e7', pageName: 'Captain Varra', actors: [actors[2]] }), []);
});

test('negotiationChanges: only differing fields, Sets compare as sets, same gives null', () => {
  const u = toFoundryNegotiation({ interest: 2, patience: 3, shown: true, motivations: ['greed', 'power'], pitfalls: [], found: { motivations: ['greed', 'power'] } });
  const same = { interest: 2, patience: 3, impression: 1, motivations: new Set(['power', 'greed']), pitfalls: new Set() };
  assert.equal(negotiationChanges(u, same, true), null);
  assert.deepEqual(negotiationChanges(u, { ...same, patience: 1, motivations: new Set(['greed']) }, true), {
    'system.negotiation.patience': 3,
    'system.negotiation.motivations': ['greed', 'power'],
  });
  assert.deepEqual(negotiationChanges(u, same, undefined), { 'flags.chronicle-sync.negotiationShown': true });
  assert.ok(negotiationChanges(u, undefined));
  assert.equal(negotiationChanges(null, same), null);
});

test('glue: Draw Steel only, active GM only, 404 quiet, no player notices, no write back', () => {
  assert.match(glue, /game\.system\?\.id === SYSTEM_ID/);
  assert.match(glue, /SYSTEM_ID = 'draw-steel'/);
  assert.match(glue, /activeGM\?\.isSelf/);
  assert.match(glue, /status === 404/);
  assert.doesNotMatch(glue, /ui\.notifications/);
  assert.doesNotMatch(glue, /api\.(put|post|delete)/i);
});
