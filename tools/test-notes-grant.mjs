#!/usr/bin/env node
/** Pins the player notebook's grant checks (scripts/_notes-grant.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowUrl,
  checkGrantMessage,
  chronicleOrigin,
  embedUrl,
  frameMessage,
  PageTracker,
  usableGrant,
  withGrant,
} from '../scripts/_notes-grant.mjs';

const CID = 'abc12345-6789-4abc-def0-123456789abc';
const ctx = {
  apiOrigin: 'https://chronicle.example',
  campaignId: CID,
  foundryUserId: 'fUser1',
  mappings: { 'chr-ana': 'fUser1', 'chr-bo': 'fUser2' },
};
const grantMsg = (over = {}) => ({
  origin: 'https://chronicle.example',
  data: { type: 'chronicle:notes-grant', token: 'cnt_abc', userId: 'chr-ana', campaignId: CID, ...over },
});

test('chronicleOrigin', () => {
  assert.equal(chronicleOrigin('https://chronicle.example/sub/'), 'https://chronicle.example');
  assert.equal(chronicleOrigin('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
  assert.equal(chronicleOrigin('javascript:alert(1)'), '');
  assert.equal(chronicleOrigin(''), '');
});

test('addresses keep a sub-path and encode the origin', () => {
  assert.equal(
    allowUrl('https://c.example/sub/', CID, 'https://foundry.example:30000'),
    `https://c.example/sub/campaigns/${CID}/notes/allow-app?origin=https%3A%2F%2Ffoundry.example%3A30000`,
  );
  assert.equal(embedUrl('https://c.example', CID, 'jots'), `https://c.example/embed/campaigns/${CID}/notes/jots`);
});

const CASES = [
  ['a matched grant is kept', grantMsg(), 'grant'],
  ['another origin is ignored', { ...grantMsg(), origin: 'https://evil.example' }, 'ignore'],
  ['another message type is ignored', grantMsg({ type: 'other' }), 'ignore'],
  ['a token without the prefix is ignored', grantMsg({ token: 'sk_live' }), 'ignore'],
  ['a missing user is ignored', grantMsg({ userId: '' }), 'ignore'],
  ['another campaign is refused', grantMsg({ campaignId: 'other' }), 'refused:campaign'],
  ['someone else\'s Chronicle account is refused', grantMsg({ userId: 'chr-bo' }), 'refused:mismatch'],
  ['an unknown Chronicle account is refused', grantMsg({ userId: 'chr-zed' }), 'refused:mismatch'],
  ['declined', { origin: 'https://chronicle.example', data: { type: 'chronicle:notes-grant-declined' } }, 'declined'],
  ['no data', { origin: 'https://chronicle.example', data: null }, 'ignore'],
];

for (const [name, event, want] of CASES) {
  test(`checkGrantMessage: ${name}`, () => {
    const r = checkGrantMessage(event, ctx);
    assert.equal(r.kind === 'refused' ? `refused:${r.reason}` : r.kind, want);
  });
}

test('checkGrantMessage: a Foundry user the GM never matched is told so', () => {
  const r = checkGrantMessage(grantMsg(), { ...ctx, foundryUserId: 'fUser9' });
  assert.deepEqual(r, { kind: 'refused', reason: 'unmapped' });
});

test('stored grants are per Foundry user and re-checked against the matching', () => {
  const g = { token: 'cnt_abc', userId: 'chr-ana', campaignId: CID };
  let stored = withGrant('{}', 'fUser1', ctx.apiOrigin, g);
  assert.deepEqual(usableGrant(stored, ctx), g);
  // Another Foundry login on the same browser doesn't get it.
  assert.equal(usableGrant(stored, { ...ctx, foundryUserId: 'fUser2' }), null);
  // The GM re-matched this login to someone else.
  assert.equal(usableGrant(stored, { ...ctx, mappings: { 'chr-ana': 'fUser2' } }), null);
  // The world now points at another Chronicle or campaign.
  assert.equal(usableGrant(stored, { ...ctx, apiOrigin: 'https://other.example' }), null);
  assert.equal(usableGrant(stored, { ...ctx, campaignId: 'other' }), null);
  stored = withGrant(stored, 'fUser1', ctx.apiOrigin, null);
  assert.equal(usableGrant(stored, ctx), null);
  assert.equal(usableGrant('not json', ctx), null);
});

test('frameMessage accepts only the frame itself at Chronicle', () => {
  const frame = {};
  const ok = { source: frame, origin: ctx.apiOrigin, data: { type: 'chronicle:embed-ready' } };
  assert.deepEqual(frameMessage(ok, frame, ctx.apiOrigin), ok.data);
  assert.equal(frameMessage({ ...ok, source: {} }, frame, ctx.apiOrigin), null);
  assert.equal(frameMessage({ ...ok, origin: 'https://evil.example' }, frame, ctx.apiOrigin), null);
  assert.equal(frameMessage({ ...ok, data: 'x' }, frame, ctx.apiOrigin), null);
  assert.equal(frameMessage(ok, null, ctx.apiOrigin), null);
});

test('PageTracker follows the newest open Chronicle page', () => {
  const p = new PageTracker();
  assert.equal(p.current(), '');
  p.opened('a', 'e1');
  p.opened('b', 'e2');
  assert.equal(p.current(), 'e2');
  p.opened('a', 'e1');
  assert.equal(p.current(), 'e1');
  p.closed('a');
  assert.equal(p.current(), 'e2');
  p.opened('b', '');
  assert.equal(p.current(), '');
});
