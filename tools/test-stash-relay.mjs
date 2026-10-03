#!/usr/bin/env node
/**
 * Tests for scripts/_stash-relay.mjs: the decisions the GM client makes when a
 * player's Stashes window asks it to call Chronicle on their behalf.
 *
 * Run: `node --test tools/test-stash-relay.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PendingRequests,
  STASH_ACTION,
  chronicleUserFor,
  isAnsweringGM,
  isStashMessage,
  planDirect,
  planRelay,
  relayErrorFrom,
} from '../scripts/_stash-relay.mjs';
import { buildMovePayload } from '../scripts/_stash-model.mjs';

const MAPPINGS = { 'chron-aria': 'f-aria', 'chron-bram': 'f-bram' };
const owns = (...ids) => (id) => ids.includes(id);

function plan(msg, over = {}) {
  return planRelay(msg, {
    senderId: 'f-aria',
    mappings: MAPPINGS,
    senderOwns: owns('c-aria'),
    buildMove: buildMovePayload,
    ...over,
  });
}

test('chronicleUserFor: reverse lookup of userMappings', () => {
  assert.equal(chronicleUserFor(MAPPINGS, 'f-bram'), 'chron-bram');
  assert.equal(chronicleUserFor(MAPPINGS, 'f-nobody'), null);
  assert.equal(chronicleUserFor(null, 'f-bram'), null);
  assert.equal(chronicleUserFor(MAPPINGS, ''), null);
});

test('view: acts as the member mapped to the SENDER, ignoring any user id in the payload', () => {
  const r = plan({ action: STASH_ACTION.VIEW, characterId: 'c-aria', actingUserId: 'chron-bram', userId: 'f-bram' });
  assert.equal(r.ok, true);
  assert.equal(r.call.method, 'GET');
  assert.equal(r.call.path, '/stashes/view?characterId=c-aria&actingUserId=chron-aria');
  assert.equal(r.call.path.includes('chron-bram'), false);
});

test('unmapped sender gets a no_mapping error', () => {
  const r = plan({ action: 'view', characterId: 'c-aria' }, { senderId: 'f-stranger' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_mapping');
});

test('missing or non-string sender is refused', () => {
  assert.equal(plan({ action: 'view', characterId: 'c-aria' }, { senderId: undefined }).error.code, 'no_sender');
  assert.equal(plan({ action: 'view', characterId: 'c-aria' }, { senderId: 5 }).error.code, 'no_sender');
});

test('view of a character the sender does not own is refused', () => {
  const r = plan({ action: 'view', characterId: 'c-bram' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_owner');
});

test('view as a peek at another character is allowed from a window the sender owns', () => {
  const r = plan({ action: 'view', characterId: 'c-bram', contextCharacterId: 'c-aria' });
  assert.equal(r.ok, true);
  assert.match(r.call.path, /characterId=c-bram&actingUserId=chron-aria$/);
});

test('peek is refused when the context character is not owned either', () => {
  const r = plan({ action: 'view', characterId: 'c-bram', contextCharacterId: 'c-zed' });
  assert.equal(r.error.code, 'not_owner');
});

test('history needs ownership and carries the sender member id', () => {
  assert.equal(plan({ action: 'history', characterId: 'c-bram' }).error.code, 'not_owner');
  const r = plan({ action: 'history', characterId: 'c-aria' });
  assert.equal(r.call.path, '/stashes/history?characterId=c-aria&actingUserId=chron-aria');
});

test('move: rebuilt with the sender member id; a forged actingUserId in the payload is dropped', () => {
  const r = plan({
    action: 'move',
    characterId: 'c-aria',
    move: {
      kind: 'item', itemId: 'i1', quantity: 2, actingUserId: 'chron-bram',
      from: { kind: 'character', id: 'c-aria' }, to: { kind: 'stash', id: '7' },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.call.method, 'POST');
  assert.equal(r.call.path, '/stashes/moves');
  assert.equal(r.call.body.actingUserId, 'chron-aria');
  assert.equal(r.call.body.quantity, 2);
});

test('move: from a character the sender does not own is refused even if the window character is theirs', () => {
  const r = plan({
    action: 'move',
    characterId: 'c-aria',
    move: { kind: 'money', amount: 1, from: { kind: 'character', id: 'c-bram' }, to: { kind: 'stash', id: '7' } },
  });
  assert.equal(r.error.code, 'not_owner');
});

test('move: window character not owned is refused', () => {
  const r = plan({
    action: 'move',
    characterId: 'c-bram',
    move: { kind: 'money', amount: 1, from: { kind: 'stash', id: '7' }, to: { kind: 'character', id: 'c-bram' } },
  });
  assert.equal(r.error.code, 'not_owner');
});

test('move: invalid body and unknown action are bad_request', () => {
  assert.equal(plan({ action: 'move', characterId: 'c-aria', move: { kind: 'item', from: {}, to: {} } }).error.code, 'bad_request');
  assert.equal(plan({ action: 'move', characterId: 'c-aria' }).error.code, 'bad_request');
  assert.equal(plan({ action: 'approve', characterId: 'c-aria' }).error.code, 'bad_request');
  assert.equal(plan({ action: 'view' }).error.code, 'bad_request');
  assert.equal(plan(null).error.code, 'bad_request');
});

test('a player cannot relay approval or downtime changes: no such action exists', () => {
  for (const action of ['approve', 'decline', 'downtime', 'requests', 'setDowntime']) {
    assert.equal(plan({ action, characterId: 'c-aria' }).ok, false, action);
  }
});

test('ids with special characters are URL-encoded', () => {
  const r = plan({ action: 'view', characterId: 'a&b=c' }, { senderOwns: owns('a&b=c') });
  assert.equal(r.call.path, '/stashes/view?characterId=a%26b%3Dc&actingUserId=chron-aria');
});

test('isStashMessage: only stash: types', () => {
  assert.equal(isStashMessage({ type: 'stash:request' }), true);
  assert.equal(isStashMessage({ type: 'map-viewer' }), false);
  assert.equal(isStashMessage(null), false);
  assert.equal(isStashMessage({ type: 5 }), false);
});

test('isAnsweringGM: only the active GM answers', () => {
  assert.equal(isAnsweringGM({ isGM: true, id: 'g1' }, { id: 'g1' }), true);
  assert.equal(isAnsweringGM({ isGM: true, id: 'g2' }, { id: 'g1' }), false);
  assert.equal(isAnsweringGM({ isGM: false, id: 'p' }, { id: 'p' }), false);
  assert.equal(isAnsweringGM({ isGM: true, id: 'g1' }, null), false);
});

test('relayErrorFrom: classifies by status without leaking the raw body', () => {
  assert.equal(relayErrorFrom({ status: 404, serverMessage: 'nope' }).code, 'not_found');
  assert.equal(relayErrorFrom({ status: 403 }).code, 'forbidden');
  assert.equal(relayErrorFrom({ status: 409, data: { message: 'not enough' } }).message, 'not enough');
  assert.equal(relayErrorFrom({ status: 400 }).code, 'bad_request');
  const e = relayErrorFrom({ status: 500, message: 'Chronicle API error 500: <html>secret</html>' });
  assert.equal(e.code, 'api_error');
  assert.equal(e.message.includes('secret'), false);
  assert.equal(relayErrorFrom(new Error('x')).code, 'api_error');
});

function fakeTimers() {
  const timers = new Map();
  let n = 0;
  return {
    setTimer: (fn) => { const id = ++n; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    count: () => timers.size,
  };
}

test('PendingRequests: a reply settles the request and clears its timer', async () => {
  const t = fakeTimers();
  const p = new PendingRequests({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { id, promise } = p.create();
  assert.equal(p.size, 1);
  assert.equal(p.settle(id, { ok: true, data: 1 }), true);
  assert.deepEqual(await promise, { ok: true, data: 1 });
  assert.equal(p.size, 0);
  assert.equal(t.count(), 0);
});

test('PendingRequests: no reply in time resolves with a timeout error', async () => {
  const t = fakeTimers();
  const p = new PendingRequests({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { promise } = p.create();
  t.fire();
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
  assert.equal(p.size, 0);
});

test('PendingRequests: late or unknown replies are ignored; ids are unique', () => {
  const p = new PendingRequests();
  const a = p.create();
  const b = p.create();
  assert.notEqual(a.id, b.id);
  assert.equal(p.settle('nope', {}), false);
  p.cancelAll();
  assert.equal(p.settle(a.id, {}), false);
});

test('PendingRequests: cancelAll resolves everything waiting', async () => {
  const p = new PendingRequests();
  const { promise } = p.create();
  p.cancelAll();
  assert.equal((await promise).error.code, 'cancelled');
});

test('planDirect: the GM window names no acting member', () => {
  const v = planDirect({ action: 'view', characterId: 'c1' }, { buildMove: buildMovePayload });
  assert.equal(v.call.path, '/stashes/view?characterId=c1');
  const h = planDirect({ action: 'history', characterId: 'c1' }, { buildMove: buildMovePayload });
  assert.equal(h.call.path, '/stashes/history?characterId=c1');
  const m = planDirect({
    action: 'move', characterId: 'c1',
    move: { kind: 'money', amount: 2, actingUserId: 'forged', from: { kind: 'character', id: 'c1' }, to: { kind: 'stash', id: '7' } },
  }, { buildMove: buildMovePayload });
  assert.equal(m.ok, true);
  assert.equal('actingUserId' in m.call.body, false);
});

test('planDirect: bad requests are refused', () => {
  const ctx = { buildMove: buildMovePayload };
  assert.equal(planDirect({ action: 'view' }, ctx).error.code, 'bad_request');
  assert.equal(planDirect({ action: 'move', characterId: 'c1' }, ctx).error.code, 'bad_request');
  assert.equal(planDirect({ action: 'move', characterId: 'c1', move: { kind: 'item' } }, ctx).error.code, 'bad_request');
  assert.equal(planDirect({ action: 'nope', characterId: 'c1' }, ctx).error.code, 'bad_request');
});
