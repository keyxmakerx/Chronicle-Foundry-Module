#!/usr/bin/env node
/**
 * Negotiation mirror rules (scripts/_negotiation-mirror.mjs): which message
 * counts, how the tracker maps onto the Draw Steel system's fields, which
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
  isNegotiationMessage, toFoundryNegotiation, pickNegotiationActors, negotiationChanges,
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

test('toFoundryNegotiation: maps fields, authority rename, sorted arrays, impression', () => {
  const u = toFoundryNegotiation({
    interest: 3, patience: 2, impression: 1,
    motivations: ['power', 'higher-authority', 'greed'], pitfalls: ['peace'],
  });
  assert.deepEqual(u, {
    'system.negotiation.interest': 3,
    'system.negotiation.patience': 2,
    'system.negotiation.motivations': ['authority', 'greed', 'power'],
    'system.negotiation.pitfalls': ['peace'],
    'system.negotiation.impression': 1,
  });
});

test('toFoundryNegotiation: clamps points, drops unknown slugs, skips null impression', () => {
  const u = toFoundryNegotiation({
    interest: 9, patience: -4, impression: null, motivations: ['nope', 'justice', 'justice'], pitfalls: 'x',
  });
  assert.equal(u['system.negotiation.interest'], 5);
  assert.equal(u['system.negotiation.patience'], 0);
  assert.deepEqual(u['system.negotiation.motivations'], ['justice']);
  assert.deepEqual(u['system.negotiation.pitfalls'], []);
  assert.equal('system.negotiation.impression' in u, false);
  assert.equal('system.negotiation.impression' in toFoundryNegotiation({ interest: 1, impression: 1.5 }), false);
});

test('toFoundryNegotiation: empty or invalid gm gives null', () => {
  for (const v of [null, undefined, {}, [], 'x', 4]) assert.equal(toFoundryNegotiation(v), null);
});

const actors = [
  { id: 'a1', name: 'Captain Varra', type: 'npc' },
  { id: 'a2', name: 'Other', type: 'npc', linkedEntityId: 'e1' },
  { id: 'a3', name: 'Captain Varra', type: 'character', isHero: true },
];

test('pickNegotiationActors: explicit link wins over a name match', () => {
  assert.deepEqual(pickNegotiationActors({ entityId: 'e1', pageName: 'Captain Varra', actors }), ['a2']);
});

test('pickNegotiationActors: unique NPC name match when nothing is linked', () => {
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: ' captain  VARRA ', actors }), ['a1']);
});

test('pickNegotiationActors: ties, heroes, non-NPCs and other pages links are left alone', () => {
  const dup = [...actors, { id: 'a4', name: 'Captain Varra', type: 'npc' }];
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: 'Captain Varra', actors: dup }), []);
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: 'Other', actors }), []);
  assert.deepEqual(pickNegotiationActors({ entityId: 'e9', pageName: '', actors }), []);
  assert.deepEqual(pickNegotiationActors({
    entityId: 'e9', pageName: 'Hero', actors: [{ id: 'h', name: 'Hero', type: 'npc', isHero: true }],
  }), []);
});

test('negotiationChanges: only differing fields, Sets compare as sets, same gives null', () => {
  const u = toFoundryNegotiation({ interest: 2, patience: 3, impression: 1, motivations: ['greed', 'power'], pitfalls: [] });
  const same = { interest: 2, patience: 3, impression: 1, motivations: new Set(['power', 'greed']), pitfalls: new Set() };
  assert.equal(negotiationChanges(u, same), null);
  assert.deepEqual(negotiationChanges(u, { ...same, patience: 1, motivations: new Set(['greed']) }), {
    'system.negotiation.patience': 3,
    'system.negotiation.motivations': ['greed', 'power'],
  });
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
