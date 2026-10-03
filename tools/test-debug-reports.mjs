import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REPORTS, MAX_TEXT, acceptReport, appendReport, checkRateLimit, cleanReportText,
  isDebugMessage, markDone, mergeLegacyReports, normalizeReports, relativeAge, splitReports, unreadCount,
} from '../scripts/_debug-reports.mjs';

const ctx = (over = {}) => ({
  senderId: 'u1', senderName: 'Ari', senderOwns: (id) => id === 'c1', stamps: {}, now: 1000, makeId: () => 'r1', ...over,
});
const msg = (over = {}) => ({ type: 'debug:report', requestId: 'q', characterId: 'c1', text: 'gold is wrong', ...over });

test('accepts a report and takes the reporter from the sender only', () => {
  const r = acceptReport(msg({ fromUserId: 'evil', fromName: 'Mallory', userId: 'evil', snapshot: { x: 1 } }), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.report.fromUserId, 'u1');
  assert.equal(r.report.fromName, 'Ari');
  assert.equal(r.report.snapshot, null);
  assert.equal(r.report.status, 'new');
  assert.equal(r.report.at, 1000);
});

test('rejects malformed, ownerless and empty reports', () => {
  assert.equal(acceptReport(null, ctx()).code, 'bad_request');
  assert.equal(acceptReport(msg(), ctx({ senderId: '' })).code, 'no_sender');
  assert.equal(acceptReport(msg({ text: '   ' }), ctx()).code, 'bad_request');
  assert.equal(acceptReport(msg({ text: 5 }), ctx()).code, 'bad_request');
  assert.equal(acceptReport(msg({ characterId: '' }), ctx()).code, 'bad_request');
  assert.equal(acceptReport(msg({ characterId: 'c2' }), ctx()).code, 'not_owner');
});

test('text is capped and control characters removed', () => {
  assert.equal(cleanReportText('a'.repeat(MAX_TEXT + 50)).length, MAX_TEXT);
  assert.equal(cleanReportText('hi\u0000 there\u0007'), 'hi there');
  assert.equal(cleanReportText('line1\nline2'), 'line1\nline2');
});

test('rate limit: 5 per 10 minutes per sender', () => {
  let stamps = {};
  for (let i = 0; i < 5; i++) {
    const r = acceptReport(msg(), ctx({ stamps, now: 1000 + i }));
    assert.equal(r.ok, true);
    stamps = r.stamps;
  }
  assert.equal(acceptReport(msg(), ctx({ stamps, now: 2000 })).code, 'rate_limited');
  // Another sender is unaffected.
  assert.equal(acceptReport(msg(), ctx({ stamps, senderId: 'u2', now: 2000 })).ok, true);
  // The window slides.
  assert.equal(acceptReport(msg(), ctx({ stamps, now: 1000 + 10 * 60 * 1000 + 10 })).ok, true);
});

test('a rejected report does not use up the allowance', () => {
  const r = checkRateLimit([1, 2, 3, 4, 5], 6);
  assert.equal(r.allowed, false);
  assert.deepEqual(r.stamps, [1, 2, 3, 4, 5]);
});

test('cap drops the oldest done report first, then the oldest overall', () => {
  const mk = (id, at, status) => ({ id, at, status });
  let list = [mk('a', 1, 'new'), mk('b', 2, 'done'), mk('c', 3, 'done'), mk('d', 4, 'new')];
  list = appendReport(list, mk('e', 5, 'new'), 4);
  assert.deepEqual(list.map((r) => r.id), ['a', 'c', 'd', 'e']);
  list = appendReport(list, mk('f', 6, 'new'), 4);
  assert.deepEqual(list.map((r) => r.id), ['a', 'd', 'e', 'f']);
  list = appendReport(list, mk('g', 7, 'new'), 4);
  assert.deepEqual(list.map((r) => r.id), ['d', 'e', 'f', 'g']);
  assert.equal(MAX_REPORTS, 200);
});

test('append returns a new list', () => {
  const a = [];
  const b = appendReport(a, { id: 'x', at: 1, status: 'new' });
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
});

test('mark done, unread count and split', () => {
  const list = [
    { id: 'a', at: 1, status: 'new' }, { id: 'b', at: 3, status: 'new' }, { id: 'c', at: 2, status: 'done' },
  ];
  assert.equal(unreadCount(list), 2);
  const after = markDone(list, 'a');
  assert.equal(unreadCount(after), 1);
  assert.equal(list[0].status, 'new');
  const { open, done } = splitReports(after);
  assert.deepEqual(open.map((r) => r.id), ['b']);
  assert.deepEqual(done.map((r) => r.id), ['c', 'a']);
});

test('normalizeReports drops malformed entries', () => {
  assert.deepEqual(normalizeReports(null), []);
  const out = normalizeReports([null, { id: 1 }, { id: 'a', text: 'x', status: 'weird', at: '5' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'new');
  assert.equal(out[0].at, 5);
});

test('relativeAge and message type', () => {
  assert.deepEqual(relativeAge(0, 30000), { unit: 'now', n: 0 });
  assert.deepEqual(relativeAge(0, 5 * 60000), { unit: 'minutes', n: 5 });
  assert.deepEqual(relativeAge(0, 3 * 3600000), { unit: 'hours', n: 3 });
  assert.deepEqual(relativeAge(0, 2 * 86400000), { unit: 'days', n: 2 });
  assert.equal(isDebugMessage({ type: 'debug:report' }), true);
  assert.equal(isDebugMessage({ type: 'stash:request' }), false);
  assert.equal(isDebugMessage(null), false);
});

test('legacy reports fold into the store: store wins on ids, cap applies', () => {
  const stored = [{ id: 'a', at: 5, status: 'done', text: 'x' }];
  const legacy = [{ id: 'a', at: 1, text: 'old a' }, { id: 'b', at: 2, text: 'b' }, 'junk'];
  const out = mergeLegacyReports(stored, legacy);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  assert.equal(out[0].status, 'done');
  assert.deepEqual(mergeLegacyReports([], null), []);
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, at: i, text: 't', status: 'done' }));
  assert.equal(mergeLegacyReports([], many, 3).length, 3);
});
