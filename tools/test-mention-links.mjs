#!/usr/bin/env node
/** Pins how Chronicle mentions are drawn in Foundry (scripts/_mention-links.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chronicleMentionUrl, mentionLabel, mentionTarget } from '../scripts/_mention-links.mjs';

const SITE = 'https://chronicle.example.com';
const journals = new Map([
  ['cyril', { id: 'J1', canRead: true }],
  ['hidden', { id: 'J2', canRead: false }],
]);
const journalFor = (id) => journals.get(id) ?? null;
const href = (id) => `/campaigns/c1/entities/${id}`;

test('the name drops the @ Chronicle writes in front of it', () => {
  assert.equal(mentionLabel('@Cyril'), 'Cyril');
  assert.equal(mentionLabel('  @The  First Father '), 'The First Father');
  assert.equal(mentionLabel('the sailor'), 'the sailor');
  assert.equal(mentionLabel('@'), '@');
});

test('a mention of a page with a readable journal links to that journal', () => {
  for (const isGM of [true, false]) {
    assert.deepEqual(
      mentionTarget({ id: 'cyril', text: '@Cyril', href: href('cyril') }, { journalFor, isGM, siteBase: SITE }),
      { kind: 'journal', label: 'Cyril', journalId: 'J1' },
    );
  }
});

test('a player never gets a link to a journal they cannot read, nor a Chronicle link', () => {
  for (const id of ['hidden', 'missing']) {
    assert.deepEqual(
      mentionTarget({ id, text: '@Aðr', href: href(id) }, { journalFor, isGM: false, siteBase: SITE }),
      { kind: 'text', label: 'Aðr' },
    );
  }
});

test('the GM gets a Chronicle link for a page with no journal here', () => {
  assert.deepEqual(
    mentionTarget({ id: 'missing', text: '@Sekhar', href: href('missing') }, { journalFor, isGM: true, siteBase: `${SITE}/` }),
    { kind: 'chronicle', label: 'Sekhar', url: `${SITE}/campaigns/c1/entities/missing` },
  );
});

test('a Chronicle link only ever points at the Chronicle site', () => {
  assert.equal(chronicleMentionUrl(href('x'), `${SITE}/sub`), `${SITE}/sub/campaigns/c1/entities/x`);
  assert.equal(chronicleMentionUrl(`${SITE}/campaigns/c1/entities/x`, SITE), `${SITE}/campaigns/c1/entities/x`);
  for (const bad of ['//evil.example/x', 'https://evil.example/campaigns/x', 'javascript:alert(1)', '', null]) {
    assert.equal(chronicleMentionUrl(bad, SITE), null, String(bad));
  }
  assert.equal(chronicleMentionUrl(href('x'), ''), null);
  assert.equal(chronicleMentionUrl(href('x'), 'not a url'), null);
  assert.equal(chronicleMentionUrl(href('x'), 'ftp://chronicle.example.com'), null);
});

test('the GM with no usable Chronicle address gets plain text', () => {
  assert.deepEqual(
    mentionTarget({ id: 'missing', text: '@Memoria', href: '//evil.example/x' }, { journalFor, isGM: true, siteBase: SITE }),
    { kind: 'text', label: 'Memoria' },
  );
  assert.deepEqual(
    mentionTarget({ id: '', text: '@Memoria', href: href('m') }, { journalFor, isGM: false, siteBase: SITE }),
    { kind: 'text', label: 'Memoria' },
  );
});
