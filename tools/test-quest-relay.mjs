#!/usr/bin/env node
/** Pins the players' quest relay: what a player may ask, and that the GM always reads the players view (scripts/_quest-relay.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEST_MESSAGE, sanitizeQuestRequest, questRequestPath, relayStatus, isQuestId, makeAskLimiter } from '../scripts/_quest-relay.mjs';

const ask = (o) => ({ type: QUEST_MESSAGE, action: 'ask', requestId: 'abcd1234', ...o });

test('good requests pass through checked', () => {
  assert.deepEqual(sanitizeQuestRequest(ask({ what: 'homes', id: 'ignored' })), { requestId: 'abcd1234', what: 'homes' });
  assert.deepEqual(sanitizeQuestRequest(ask({ what: 'quest', id: 'q-1' })), { requestId: 'abcd1234', what: 'quest', id: 'q-1' });
  assert.deepEqual(sanitizeQuestRequest(ask({ what: 'boards', kind: 'category', id: '4' })), { requestId: 'abcd1234', what: 'boards', kind: 'category', id: '4' });
  assert.deepEqual(sanitizeQuestRequest(ask({ what: 'boards', kind: 'page', id: 'e1' })), { requestId: 'abcd1234', what: 'boards', kind: 'page', id: 'e1' });
});

test('bad requests are dropped', () => {
  const bad = [
    null, {}, { ...ask({ what: 'homes' }), type: 'other' }, { ...ask({ what: 'homes' }), action: 'answer' },
    ask({ what: 'homes', requestId: 'short' }), ask({ what: 'homes', requestId: 'has space 123' }),
    ask({ what: 'quest', id: '../x' }), ask({ what: 'quest', id: 'a&audience=gm' }), ask({ what: 'quest' }),
    ask({ what: 'boards', kind: 'category', id: 'abc' }), ask({ what: 'boards', kind: 'other', id: '1' }),
    ask({ what: 'pay', id: 'x' }), ask({ what: 'quest', id: 'x'.repeat(65) }),
  ];
  for (const b of bad) assert.equal(sanitizeQuestRequest(b), null, JSON.stringify(b));
});

test('the GM always asks Chronicle for the players view', () => {
  for (const req of [{ what: 'homes' }, { what: 'boards', kind: 'page', id: 'e1' }, { what: 'boards', kind: 'category', id: '4' }, { what: 'quest', id: 'q1' }]) {
    assert.match(questRequestPath(req), /[?&]audience=players$/);
  }
  assert.equal(questRequestPath({ what: 'boards', kind: 'category', id: '4' }), '/quests/boards?category=4&audience=players');
  assert.equal(questRequestPath({ what: 'pay' }), null);
});

test('only not-found and forbidden pass through; anything else is a plain failure', () => {
  assert.equal(relayStatus({ status: 404 }), 404);
  assert.equal(relayStatus({ status: 403 }), 403);
  assert.equal(relayStatus({ status: 500, message: 'db down at 10.0.0.3' }), 502);
  assert.equal(relayStatus(new Error('x')), 502);
});

test('route names are never read as a quest, so a player cannot reach the DM-only party list', () => {
  for (const id of ['party', 'PARTY', 'homes', 'boards', 'pay', 'give']) {
    assert.equal(isQuestId(id), false, id);
    assert.equal(sanitizeQuestRequest(ask({ what: 'quest', id })), null, id);
  }
  assert.equal(isQuestId('3f2a9c1e-0b7d-4c55-9a1e-2b3c4d5e6f70'), true);
});

test('each player gets a bounded number of questions per window', () => {
  let now = 0;
  const allow = makeAskLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.deepEqual([allow('p1'), allow('p1'), allow('p1'), allow('p2')], [true, true, false, true]);
  now = 1001;
  assert.equal(allow('p1'), true);
});
