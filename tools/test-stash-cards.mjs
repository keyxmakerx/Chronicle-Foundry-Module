#!/usr/bin/env node
/**
 * Tests for scripts/_stash-cards.mjs: the GM request card model, its HTML and
 * the dedupe of cards.
 *
 * Run: `node --test tools/test-stash-cards.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_STATE,
  cardFlag,
  cardHtml,
  cardsToPost,
  collectCardMoveIds,
  findCardMessage,
  isGmAuthored,
  trustedCardMoveId,
  escapeHtml,
  modelFromFlag,
  requestCardModel,
  settleCardModel,
  stateForStatus,
} from '../scripts/_stash-cards.mjs';

const LABELS = {
  Title: 'Stash request', Who: 'Who', What: 'What', Where: 'Where to', Money: 'Money',
  Approve: 'Approve', Decline: 'Turn down',
};

const ITEM_LINE = {
  id: '12', kind: 'item', status: 'pending', quantity: 2, itemName: 'Rope',
  fromName: 'Aria', toName: 'Camp', requesterName: 'Aria P.',
};
const MONEY_LINE = { id: '13', kind: 'money', status: 'pending', amount: 2.5, fromName: 'Aria', toName: 'Bram', requesterName: 'Aria P.' };

test('requestCardModel: item request says who, what and where', () => {
  const m = requestCardModel(ITEM_LINE);
  assert.equal(m.moveId, '12');
  assert.equal(m.who, 'Aria P.');
  assert.equal(m.what, '2 × Rope');
  assert.equal(m.where, 'Aria → Camp');
  assert.equal(m.state, CARD_STATE.PENDING);
});

test('requestCardModel: money request carries an amount and is flagged', () => {
  const m = requestCardModel(MONEY_LINE);
  assert.equal(m.isMoney, true);
  assert.equal(m.what, '2.50');
});

test('stateForStatus: server statuses map to card states', () => {
  assert.equal(stateForStatus('pending'), 'pending');
  assert.equal(stateForStatus('applied'), 'approved');
  assert.equal(stateForStatus('declined'), 'declined');
  assert.equal(stateForStatus('failed'), 'failed');
  assert.equal(stateForStatus('weird'), null);
});

test('settleCardModel: pending becomes approved/declined with who answered', () => {
  const m = requestCardModel(ITEM_LINE);
  const a = settleCardModel(m, 'applied', 'Dana');
  assert.equal(a.state, 'approved');
  assert.equal(a.by, 'Dana');
  assert.equal(settleCardModel(m, 'declined', 'Dana').state, 'declined');
  assert.equal(m.state, 'pending', 'input is not mutated');
});

test('settleCardModel: a second event never rewrites who answered', () => {
  const a = settleCardModel(requestCardModel(ITEM_LINE), 'applied', 'Dana');
  const again = settleCardModel(a, 'declined', 'Eve');
  assert.equal(again.state, 'approved');
  assert.equal(again.by, 'Dana');
});

test('settleCardModel: pending or unknown status leaves the card alone', () => {
  const m = requestCardModel(ITEM_LINE);
  assert.equal(settleCardModel(m, 'pending', 'x'), m);
  assert.equal(settleCardModel(m, 'weird', 'x'), m);
});

test('cardHtml: pending card has Approve and Turn down buttons keyed by move id', () => {
  const html = cardHtml(requestCardModel(ITEM_LINE), LABELS);
  assert.match(html, /data-stash-action="approve" data-move-id="12"/);
  assert.match(html, /data-stash-action="decline" data-move-id="12"/);
  assert.match(html, />Turn down</);
});

test('cardHtml: settled card has no buttons and shows the answered line', () => {
  const m = settleCardModel(requestCardModel(ITEM_LINE), 'applied', 'Dana');
  const html = cardHtml(m, LABELS, 'Approved by Dana');
  assert.equal(html.includes('<button'), false);
  assert.equal(html.includes('data-stash-action'), false);
  assert.match(html, /Approved by Dana/);
  assert.match(html, /data-state="approved"/);
});

test('cardHtml: money is labelled', () => {
  assert.match(cardHtml(requestCardModel(MONEY_LINE), LABELS), /Money 2\.50/);
});

test('cardHtml: every server-supplied string is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = requestCardModel({ ...ITEM_LINE, requesterName: evil, itemName: evil, fromName: evil, toName: '"><script>' });
  const html = cardHtml(m, LABELS);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script'), false);
  assert.match(html, /&lt;img/);
  const settled = cardHtml(settleCardModel(m, 'applied', evil), LABELS, `Approved by ${evil}`);
  assert.equal(settled.includes('<img'), false);
});

test('escapeHtml: handles null and quotes', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
});

test('cardsToPost: skips moves that already have a card or are being posted', () => {
  const lines = [ITEM_LINE, MONEY_LINE];
  assert.deepEqual(cardsToPost(lines, []).map((l) => l.id), ['12', '13']);
  assert.deepEqual(cardsToPost(lines, ['12']).map((l) => l.id), ['13']);
  assert.deepEqual(cardsToPost(lines, new Set(['12']), ['13']), []);
});

test('cardsToPost: numeric and string ids compare equal; duplicates in the list post once', () => {
  assert.deepEqual(cardsToPost([ITEM_LINE, { ...ITEM_LINE }], [12]).length, 0);
  assert.equal(cardsToPost([ITEM_LINE, { ...ITEM_LINE }], []).length, 1);
});

test('cardsToPost: only pending requests get a card', () => {
  assert.deepEqual(cardsToPost([{ ...ITEM_LINE, status: 'applied' }, { ...ITEM_LINE, id: '99', status: 'declined' }], []), []);
});

test('card flag round-trips; a foreign flag reads as not a card', () => {
  const m = settleCardModel(requestCardModel(MONEY_LINE), 'declined', 'Dana');
  const back = modelFromFlag(cardFlag(m));
  assert.deepEqual(back, m);
  assert.equal(modelFromFlag(null), null);
  assert.equal(modelFromFlag({}), null);
  assert.equal(modelFromFlag({ model: {} }), null);
  assert.equal(modelFromFlag({ model: { moveId: '1' }, state: 'bogus' }).state, 'pending');
});

const flagOf = (m) => m.flag;
const gmCard = (id) => ({ author: { isGM: true }, flag: { moveId: id } });
const playerCard = (id) => ({ author: { isGM: false }, flag: { moveId: id } });

test('isGmAuthored: v13 author, v12 user, and nothing else', () => {
  assert.equal(isGmAuthored({ author: { isGM: true } }), true);
  assert.equal(isGmAuthored({ user: { isGM: true } }), true);
  assert.equal(isGmAuthored({ author: { isGM: false } }), false);
  assert.equal(isGmAuthored({ user: { isGM: false } }), false);
  assert.equal(isGmAuthored({}), false);
  assert.equal(isGmAuthored(null), false);
});

test('a player-authored card is ignored for wiring', () => {
  assert.equal(trustedCardMoveId(playerCard('12'), flagOf), null);
  assert.equal(trustedCardMoveId(gmCard('12'), flagOf), '12');
  assert.equal(trustedCardMoveId(gmCard(12), flagOf), '12');
  assert.equal(trustedCardMoveId({ author: { isGM: true }, flag: {} }, flagOf), null);
});

test('a player-authored card neither counts as existing nor hides the real one', () => {
  const messages = [playerCard('12'), gmCard('13')];
  assert.deepEqual(collectCardMoveIds(messages, flagOf), ['13']);
  // The forged card does not stop the real request 12 from getting its card.
  assert.deepEqual(cardsToPost([ITEM_LINE], collectCardMoveIds(messages, flagOf)).map((l) => l.id), ['12']);
  assert.equal(findCardMessage(messages, '12', flagOf), null);
  assert.equal(findCardMessage(messages, 13, flagOf), messages[1]);
});

test('when both a forged and a real card exist, the real one is found', () => {
  const forged = playerCard('12');
  const real = gmCard('12');
  assert.equal(findCardMessage([forged, real], '12', flagOf), real);
});
