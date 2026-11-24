#!/usr/bin/env node
/**
 * A campaign entry's stored text (Markdown from the AI tools, or HTML) becomes
 * item HTML with no raw markup left. No Foundry needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryTextHTML, mentionLookup } from '../scripts/_entry-text.mjs';

const lookup = mentionLookup([
  { name: 'The Dragon Knights', entityId: 'ent-7' },
  { name: 'No id' },
  { name: 'the dragon knights', entityId: 'ent-dup' },
]);

test('names resolve case-insensitively; the first journal wins; unknown is null', () => {
  assert.equal(lookup('the DRAGON knights'), 'ent-7');
  assert.equal(lookup('No id'), null);
  assert.equal(lookup('Elsewhere'), null);
});

test('Markdown becomes block HTML', () => {
  const cases = [
    ['**bold** and *soft* and `code`', '<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>'],
    ['one\nline\n\ntwo', '<p>one line</p><p>two</p>'],
    ['text ---', '<p>text</p>'],
    ['---\nabove\n***\nbelow\n---', '<p>above</p><p>below</p>'],
    ['- a\n- **b**\n  more\n\n1. x\n2. y', '<ul><li>a</li><li><strong>b</strong> more</li></ul><ol><li>x</li><li>y</li></ol>'],
    ['## Lore\nwords', '<h4>Lore</h4><p>words</p>'],
    ['5 * 3 * 2 stays', '<p>5 * 3 * 2 stays</p>'],
    ['{@condition taunted|taunts} and {@action Charge}', '<p>taunts and Charge</p>'],
  ];
  for (const [md, html] of cases) assert.equal(entryTextHTML(md), html, md);
});

test('plain text is escaped, never trusted as markup', () => {
  assert.equal(entryTextHTML('a < b & "c"'), '<p>a &lt; b &amp; &quot;c&quot;</p>');
  assert.equal(entryTextHTML('@[<img src=x>]'), '<p>&lt;img src=x&gt;</p>');
});

test('mentions link to a synced journal, else stay as words, never restyled', () => {
  assert.equal(entryTextHTML('for @[The Dragon Knights]', { mentionId: lookup }),
    '<p>for <a data-mention-id="ent-7">The Dragon Knights</a></p>');
  assert.equal(entryTextHTML('@[The Dragon Knights|the order]', { mentionId: lookup }),
    '<p><a data-mention-id="ent-7">the order</a></p>');
  assert.equal(entryTextHTML('see @[Lost Page] and @[**x**]'), '<p>see Lost Page and **x**</p>');
});

test('HTML keeps its markup; mentions and rule paragraphs are converted', () => {
  assert.equal(entryTextHTML('<p>for @[The Dragon Knights]</p><p>---</p>', { mentionId: lookup }),
    '<p>for <a data-mention-id="ent-7">The Dragon Knights</a></p>');
  assert.equal(entryTextHTML('<p>Born of the <em>wild</em>.</p>'), '<p>Born of the <em>wild</em>.</p>');
});

test('empty input gives nothing', () => {
  for (const v of ['', '  \n ', null, undefined]) assert.equal(entryTextHTML(v), '');
});
