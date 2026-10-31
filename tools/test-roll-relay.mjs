#!/usr/bin/env node
/**
 * Shared rolls (scripts/_roll-relay.mjs): what an incoming Chronicle roll
 * becomes in chat, who may read it, and what a Foundry chat roll sends to
 * Chronicle. Also pins the wiring that the pure rules cannot see.
 *
 * Run: node --test tools/test-roll-relay.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SeenRolls, buildChatData, buildRollData, hasRollMessage, isRouteMissing,
  judgeIncoming, modeOf, postBodies,
} from '../scripts/_roll-relay.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const payload = (over = {}) => ({
  id: 'r1', origin: 'chronicle', source: 'table', rollerId: 'cu1', rollerName: 'Mara',
  label: 'Brutal Slam', formula: '2d10+2', dice: [{ sides: 10, value: 7 }, { sides: 10, value: 9 }],
  modifier: 2, total: 20, outcome: 'Tier 3', mode: 'public', ...over,
});
const GMS = ['gm1', 'gm2'];

test('chat data keeps the dice, modifier, total, speaker, flavor and flag', () => {
  const data = buildChatData(payload(), { gmIds: GMS });
  const [roll] = data.rolls;
  assert.equal(roll.total, 20);
  assert.equal(roll.evaluated, true);
  assert.equal(roll.formula, '2d10 + 2');
  assert.deepEqual(roll.terms[0].results.map((r) => r.result), [7, 9]);
  assert.equal(roll.terms[0].faces, 10);
  assert.deepEqual(roll.terms.slice(1).map((t) => t.operator ?? t.number), ['+', 2]);
  assert.equal(data.speaker.alias, 'Mara');
  assert.equal(data.flavor, 'Brutal Slam (Tier 3)');
  assert.deepEqual(data.flags['chronicle-sync'].roll, { id: 'r1', origin: 'chronicle' });
  assert.equal(data.whisper, undefined);
  assert.equal(data.blind, undefined);
});

test('mixed dice make separate terms; a negative modifier subtracts', () => {
  const r = buildRollData(payload({
    dice: [{ sides: 20, value: 14 }, { sides: 6, value: 3 }, { sides: 6, value: 4 }], modifier: -1, total: 20,
  }));
  assert.equal(r.formula, '1d20 + 2d6 - 1');
  assert.equal(r.terms.filter((t) => t.class === 'Die').length, 2);
});

test('modes: gm whispers to GMs and the linked roller, blind to GMs only', () => {
  const gm = buildChatData(payload({ mode: 'gm' }), { gmIds: GMS, rollerFoundryId: 'p1' });
  assert.deepEqual(gm.whisper.sort(), ['gm1', 'gm2', 'p1']);
  assert.notEqual(gm.blind, true);
  assert.deepEqual(buildChatData(payload({ mode: 'gm' }), { gmIds: GMS }).whisper, GMS);
  const blind = buildChatData(payload({ mode: 'blind' }), { gmIds: GMS, rollerFoundryId: 'p1' });
  assert.deepEqual(blind.whisper, GMS);
  assert.equal(blind.blind, true);
});

test('a missing roller name falls back; a gm or blind roll is never public', () => {
  assert.equal(buildChatData(payload({ rollerName: '' }), { fallbackAlias: 'Someone' }).speaker.alias, 'Someone');
  for (const mode of ['gm', 'blind']) {
    assert.ok(buildChatData(payload({ mode }), { gmIds: GMS }).whisper.length);
  }
});

test('hidden, self, foundry-origin and diceless rolls are not posted', () => {
  assert.equal(judgeIncoming(payload()).ok, true);
  assert.equal(judgeIncoming(payload({ hidden: true })).reason, 'hidden');
  assert.equal(judgeIncoming(payload({ mode: 'self' })).reason, 'mode');
  assert.equal(judgeIncoming(payload({ origin: 'foundry' })).reason, 'foreign-origin');
  assert.equal(judgeIncoming(payload({ dice: [] })).reason, 'dice');
  assert.equal(judgeIncoming(payload({ dice: [{ sides: 6, value: 7 }] })).reason, 'dice');
  assert.equal(judgeIncoming(payload({ total: 1.5 })).reason, 'total');
  assert.equal(judgeIncoming(null).ok, false);
});

test('a roll id is accepted once, memory is bounded, and a flagged message counts', () => {
  const seen = new SeenRolls(2);
  assert.equal(seen.add('a'), true);
  assert.equal(seen.add('a'), false);
  seen.add('b'); seen.add('c');
  assert.equal(seen.has('a'), false);
  const msgs = [{ flags: {} }, { flags: { 'chronicle-sync': { roll: { id: 'r1' } } } }];
  assert.equal(hasRollMessage(msgs, 'r1'), true);
  assert.equal(hasRollMessage(msgs, 'r2'), false);
});

const die = (faces, results) => ({ faces, results });
const msg = (over = {}) => ({
  id: 'm1', author: { id: 'u1' }, speaker: { alias: 'Kara' }, flavor: '<b>Attack</b>', whisper: [], blind: false,
  rolls: [{ formula: '1d20 + 3', total: 17, dice: [die(20, [{ result: 14, active: true }])] }], ...over,
});
const ctx = { isGM: (id) => id.startsWith('gm'), foundryUserId: 'u1', userName: 'Kara Player' };

test('a public Foundry roll becomes one body', () => {
  assert.deepEqual(postBodies(msg(), ctx), [{
    originId: 'm1', foundryUserId: 'u1', rollerName: 'Kara', label: 'Attack', formula: '1d20 + 3',
    dice: [{ sides: 20, value: 14 }], total: 17, mode: 'public',
  }]);
});

test('several rolls suffix the origin id after the first', () => {
  const r = msg().rolls[0];
  const ids = postBodies(msg({ rolls: [r, r, r] }), ctx).map((b) => b.originId);
  assert.deepEqual(ids, ['m1', 'm1:1', 'm1:2']);
});

test('discarded, rerolled and inactive dice are left out', () => {
  const roll = {
    formula: '2d20kh1', total: 15,
    dice: [die(20, [{ result: 15, active: true }, { result: 4, active: false, discarded: true }, { result: 2, active: false, rerolled: true }])],
  };
  assert.deepEqual(postBodies(msg({ rolls: [roll] }), ctx)[0].dice, [{ sides: 20, value: 15 }]);
});

test('modes from the message; self and non-GM whispers stay in Foundry', () => {
  assert.equal(postBodies(msg({ blind: true, whisper: ['gm1'] }), ctx)[0].mode, 'blind');
  assert.equal(postBodies(msg({ whisper: ['gm1', 'u1'] }), ctx)[0].mode, 'gm');
  assert.equal(modeOf(msg({ whisper: ['u1'] }), ctx.isGM), null);
  assert.deepEqual(postBodies(msg({ whisper: ['u1'] }), ctx), []);
  assert.deepEqual(postBodies(msg({ whisper: ['u2'] }), ctx), []);
});

test('chronicle-flagged, roll-less and unsendable messages send nothing', () => {
  const flagged = msg({ flags: { 'chronicle-sync': { roll: { id: 'r1', origin: 'chronicle' } } } });
  assert.deepEqual(postBodies(flagged, ctx), []);
  assert.deepEqual(postBodies(msg({ rolls: [] }), ctx), []);
  const fate = { formula: '4dF', total: 1, dice: [die(3, [{ result: -1, active: true }])] };
  assert.deepEqual(postBodies(msg({ rolls: [fate] }), ctx), []);
  const flat = { formula: '5', total: 5, dice: [] };
  assert.deepEqual(postBodies(msg({ rolls: [flat] }), ctx), []);
  const many = { formula: '101d6', total: 300, dice: [die(6, Array.from({ length: 101 }, () => ({ result: 3, active: true })))] };
  assert.deepEqual(postBodies(msg({ rolls: [many] }), ctx), []);
});

test('only a 404 stops sending for the session', () => {
  assert.equal(isRouteMissing({ status: 404 }), true);
  assert.equal(isRouteMissing({ status: 400 }), false);
  assert.equal(isRouteMissing(new Error('network')), false);
});

test('wiring: roll. is allowed, the relay is registered, and gated to the active GM', () => {
  assert.match(read('scripts/api-client.mjs'), /'roll\.',/);
  assert.match(read('scripts/module.mjs'), /registerModule\(rollRelay\)/);
  const src = read('scripts/roll-relay.mjs');
  assert.match(src, /activeGM\?\.isSelf/);
  assert.match(src, /this\._syncing/);
  assert.match(src, /_routeMissing/);
  assert.ok(JSON.parse(read('lang/en.json')).CHRONICLE.Rolls.FallbackName);
});
