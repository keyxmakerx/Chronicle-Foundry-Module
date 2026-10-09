#!/usr/bin/env node
/** Pins the Quest Board's view models and the reward hand-out (scripts/_quest-view.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unwrapList, daysText, homeOptions, parseHomeKey, boardModel, imageURL,
  sheetModel, shareHundredths, fmtShare, handOutPlan, payReason, stepsWith, setQuestWords,
} from '../scripts/_quest-view.mjs';

test('lists unwrap bare or enveloped', () => {
  assert.deepEqual(unwrapList([1]), [1]);
  assert.deepEqual(unwrapList({ data: [2], total: 1 }), [2]);
  assert.deepEqual(unwrapList(null), []);
});

test('days left reads as Chronicle words it', () => {
  for (const [n, want] of [[0, 'Due today'], [1, '1 day left'], [4, '4 days left'], [-1, '1 day late'], [-3, '3 days late'], [null, ''], [NaN, '']]) {
    assert.equal(daysText(n), want);
  }
});

test('homes are named from the type list, and bad ones dropped', () => {
  const out = homeOptions(
    [{ kind: 'category', id: '3' }, { kind: 'page', id: 'e1', name: 'The Rusty Anchor' }, { kind: 'category', id: '9' }, { kind: 'weird', id: 'x' }, { kind: 'page', id: '' }],
    { data: [{ id: 3, name: 'Town', name_plural: 'Towns' }] },
  );
  assert.deepEqual(out.map((o) => o.label), ['Towns (category)', 'The Rusty Anchor', 'Category (category)']);
  assert.equal(out[1].key, 'page:e1');
});

test('home keys parse only to safe values', () => {
  assert.deepEqual(parseHomeKey('category:12'), { kind: 'category', id: '12' });
  assert.deepEqual(parseHomeKey('page:abc-1'), { kind: 'page', id: 'abc-1' });
  for (const bad of ['category:abc', 'page:a/b', 'page:', 'other:1', '', null, 'page:../x']) assert.equal(parseHomeKey(bad), null, bad);
});

test('a board keeps strings only between pins this viewer got', () => {
  const b = boardModel({
    id: 'b1', name: 'Docks',
    items: [
      { id: 'n1', kind: 'notice', questId: 'q1', title: 'Rats', status: 'active', daysLeft: 1, x: 10, y: 10, w: 20, r: 3 },
      { id: 'n2', kind: 'note', text: 'hi', ownerName: 'Ana', hidden: true },
      { id: 's1', kind: 'string', from: 'n1', to: 'n2' },
      { id: 's2', kind: 'string', from: 'n1', to: 'gone' },
    ],
  }, { isGM: false });
  assert.deepEqual(b.strings, [{ from: 'n1', to: 'n2' }]);
  assert.equal(b.pins[0].days, '1 day left');
  assert.equal(b.pins[0].soon, true);
  assert.equal(b.pins[1].hidden, false, 'players never see the hidden mark');
  assert.match(b.pins[0].style, /left:10%;top:10%;width:20%;--r:3deg/);
});

test('settled notices show a stamp and no countdown', () => {
  const b = boardModel({ items: [{ id: 'n', kind: 'notice', status: 'done', daysLeft: -4 }] }, { isGM: true });
  assert.equal(b.pins[0].stamp, 'Done');
  assert.equal(b.pins[0].days, '');
  assert.equal(b.pins[0].late, false);
});

test('positions are clamped so a bad value cannot fling a pin off the cork', () => {
  const b = boardModel({ items: [{ id: 'n', kind: 'note', x: 900, y: -50, w: 1, r: 99 }] }, { isGM: true });
  assert.equal(b.pins[0].style, 'left:100%;top:-10%;width:4%;--r:30deg');
});

test('a concealed page shows no name', () => {
  const b = boardModel({ items: [{ id: 'p', kind: 'page', name: 'Secret Duke', concealed: true }] }, { isGM: false });
  assert.equal(b.pins[0].name, 'Someone');
  assert.equal(b.pins[0].initial, '?');
});

test('picture links: http(s) kept, site-relative joined, others dropped', () => {
  assert.equal(imageURL('/media/a.png', 'https://c.example/'), 'https://c.example/media/a.png');
  assert.equal(imageURL('https://x/y.png', ''), 'https://x/y.png');
  for (const bad of ['javascript:alert(1)', '//evil/x', 'data:image/png;base64,AA', '']) assert.equal(imageURL(bad, 'https://c'), '', bad);
  assert.equal(imageURL('/media/a.png', ''), '');
});

test('the player sheet has no ledger fields', () => {
  const s = sheetModel({ notice: { title: 'Rats' }, steps: [{ text: 'a', done: true }], hiddenSteps: true, rewards: [{ id: 'r' }], version: 3 }, { isGM: false });
  assert.equal(s.hiddenSteps, true);
  assert.equal(s.rewards, undefined);
  assert.equal(s.version, undefined);
});

test('the GM sheet carries version, status and rewards', () => {
  const s = sheetModel({
    status: 'bogus', version: 7, due: { label: 'Day 3', daysLeft: -2 },
    rewards: [{ id: 'r1', kind: 'money', text: '80 gp', amount: 80 }, { id: 'r2', kind: 'item', name: 'Sword', entityId: 'i1' }],
  }, { isGM: true });
  assert.equal(s.version, 7);
  assert.equal(s.statusValue, 'active');
  assert.deepEqual(s.due, { label: 'Day 3', left: '2 days late', late: true });
  assert.deepEqual(s.rewards[1], { id: 'r2', kind: 'item', text: 'Sword', amount: null, itemId: 'i1' });
});

test('shares floor like Chronicle and format without stray zeros', () => {
  assert.equal(shareHundredths(100, 3), 3333);
  assert.equal(shareHundredths(0.1, 3), 3);
  assert.equal(shareHundredths(10, 0), 0);
  assert.equal(shareHundredths(-5, 2), 0);
  assert.equal(fmtShare(4000), '40');
  assert.equal(fmtShare(4050), '40.50');
});

test('the hand-out plan pays shares, then gives items, and marks done steps', () => {
  const party = [{ id: 'c1', name: 'Ana' }, { id: 'c2', name: 'Bo' }];
  const rewards = [
    { id: 'm', kind: 'money', amount: 81, text: '81 gp' },
    { id: 'i', kind: 'item', itemId: 'it', text: 'Sword' },
    { id: 'j', kind: 'item', itemId: 'it2', text: 'Shield' },
  ];
  const steps = handOutPlan({ rewards, party, coinTo: new Set(['c1', 'c2']), itemTo: { i: 'c2', j: '' }, done: new Set(['pay:m:c1']), reason: payReason('Rats') });
  assert.deepEqual(steps.map((s) => [s.key, s.done]), [['pay:m:c1', true], ['pay:m:c2', false], ['give:i:c2', false]]);
  assert.equal(steps[0].amount, 40.5);
  assert.equal(steps[0].label, '40.50 to Ana');
  assert.equal(steps[0].reason, 'as a reward for Rats');
});

test('nobody picked for coins means no pay steps', () => {
  const steps = handOutPlan({ rewards: [{ id: 'm', kind: 'money', amount: 5 }], party: [{ id: 'c', name: 'A' }], coinTo: [], reason: '' });
  assert.deepEqual(steps, []);
});

test('a step change sends every step whole, with only wire fields', () => {
  const raw = [{ id: 'a', text: 'x', done: false, shown: true, extra: 1 }, { id: 'b', text: 'y', done: true, shown: false }];
  assert.deepEqual(stepsWith(raw, 1, 'shown', true), [
    { id: 'a', text: 'x', done: false, shown: true },
    { id: 'b', text: 'y', done: true, shown: true },
  ]);
  assert.deepEqual(stepsWith(raw, 0, 'text', 'evil')[0].text, 'x');
});

test('a player whose notice is hidden sees a neutral title', () => {
  assert.equal(sheetModel({ notice: null }, { isGM: false }).title, 'A quest');
  assert.equal(sheetModel({ notice: { title: '' } }, { isGM: false }).title, 'Untitled quest');
});

test('shown words come from the lookup Foundry supplies', () => {
  setQuestWords((key, data) => `<${key}${data ? ':' + data.n : ''}>`);
  try {
    assert.equal(daysText(3), '<DaysLeft:3>');
    assert.equal(daysText(-1), '<DayLate:1>');
    assert.equal(boardModel({ items: [{ id: 'n', kind: 'notice', status: 'failed' }] }, { isGM: true }).pins[0].stamp, '<StatusFailed>');
  } finally {
    setQuestWords(null);
  }
  assert.equal(daysText(3), '3 days left');
});
