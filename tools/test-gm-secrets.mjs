#!/usr/bin/env node
/**
 * GM-only text (Chronicle `<span data-secret>`) must reach Foundry only
 * inside Foundry secret blocks, and must leave Foundry still marked GM only,
 * including text the GM put in a secret block themselves.
 * scripts/_gm-secrets.mjs; wiring pinned against scripts/journal-sync.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  toFoundrySecrets, toChronicleSecrets, secretBlockRanges, PART_ATTR,
} from '../scripts/_gm-secrets.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (t) => `<span data-secret="true">${t}</span>`;

// What a player can read: the page with every secret block removed, the
// way Foundry renders it for a non-owner.
function playerView(html) {
  let out = html;
  let prev;
  do {
    prev = out;
    out = out.replace(/<section\b[^>]*\bclass="[^"]*\bsecret\b[^"]*"[^>]*>(?:(?!<section\b)[\s\S])*?<\/section>/gi, '');
  } while (out !== prev);
  return out;
}

// Chronicle's own player strip (internal/sanitize StripSecretsHTML).
const chroniclePlayerView = (html) => html.replace(/<span[^>]*\bdata-secret\b[^>]*>[\s\S]*?<\/span>/g, '');

const cases = [
  ['inline secret mid-paragraph', `<p>The king is ${S('a lich')} and old.</p>`],
  ['secret at paragraph start', `<p>${S('Hidden')} then shown.</p>`],
  ['secret at paragraph end', `<p>Shown then ${S('hidden')}</p>`],
  ['whole paragraph secret', `<p>${S('All hidden')}</p>`],
  ['two secrets, space between', `<p>A ${S('x')} ${S('y')} B</p>`],
  ['secret in heading', `<h2>Title ${S('Real name')}</h2><p>Body</p>`],
  ['secret in list item', `<ul><li><p>One ${S('two')}</p></li><li><p>three</p></li></ul>`],
  ['secret with link', `<p>See ${S('<a href="/x">the vault</a>')} now</p>`],
  ['attributes kept', `<p style="text-align: center">Left ${S('mid')} right</p>`],
];

for (const [name, html] of cases) {
  test(`pull hides GM text from players: ${name}`, () => {
    const out = toFoundrySecrets(html);
    assert.doesNotMatch(out, /data-secret/, 'no Chronicle secret span survives');
    const secretWords = [...html.matchAll(/<span data-secret="true">([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, ''));
    const visible = playerView(out).replace(/<[^>]*>/g, '');
    for (const w of secretWords) assert.ok(!visible.includes(w), `"${w}" is not in the player view: ${out}`);
  });

  test(`round trip leaves Chronicle unchanged: ${name}`, () => {
    assert.equal(toChronicleSecrets(toFoundrySecrets(html)), html);
  });
}

test('a secret inside bold comes back as the same words, still bold and secret', () => {
  const out = toChronicleSecrets(toFoundrySecrets(`<p><strong>Bold ${S('secret')} bold</strong> tail</p>`));
  // The bold run may come back as three bold runs; Chronicle's editor reads
  // that as the same text with the same marks.
  assert.equal(out, `<p><strong>Bold </strong>${S('<strong>secret</strong>')}<strong> bold</strong> tail</p>`);
  assert.equal(chroniclePlayerView(out).replace(/<[^>]*>/g, ''), 'Bold  bold tail');
});

test('HTML without secrets passes through untouched both ways', () => {
  const html = '<h2>Intro</h2><p>Plain <em>text</em>.</p><figure class="ce-img"><img src="/media/x"></figure>';
  assert.equal(toFoundrySecrets(html), html);
  assert.equal(toChronicleSecrets(html), html);
});

test('pull output is a Foundry secret block with an id', () => {
  const out = toFoundrySecrets(`<p>a ${S('b')}</p>`);
  assert.match(out, /<section class="secret" id="secret-chrtxt1" data-chronicle-part="1"><p data-chronicle-part="1">b<\/p><\/section>/);
  assert.match(out, /<p data-chronicle-part="1">a <\/p>/, 'edge space survives Foundry trimming');
});

test('a secret block the GM wrote in Foundry goes to Chronicle as GM-only text', () => {
  const html = '<p>Open</p><section class="secret" id="secret-abc"><p>GM <strong>only</strong> words</p><ul><li><p>list item</p></li></ul></section>';
  const out = toChronicleSecrets(html);
  assert.doesNotMatch(out, /<section/);
  const seen = chroniclePlayerView(out).replace(/<[^>]*>/g, '');
  assert.equal(seen.replace(/\s+/g, ''), 'Open');
});

test('a revealed secret block still goes back GM only', () => {
  const out = toChronicleSecrets('<section class="secret revealed" id="secret-1"><p>still secret</p></section>');
  assert.equal(chroniclePlayerView(out).replace(/<[^>]*>/g, ''), '');
});

test('push never nests a span inside a secret span', () => {
  const out = toChronicleSecrets('<section class="secret" id="s"><p><span style="color:red">red</span> <a href="/y">link</a></p></section>');
  assert.equal(chroniclePlayerView(out).replace(/<[^>]*>/g, '').trim(), '');
  assert.doesNotMatch(chroniclePlayerView(out), /href/, 'a secret link target is not left behind');
});

test('GM edits inside a split paragraph are kept and joined', () => {
  const pulled = toFoundrySecrets(`<p>The king is ${S('a lich')} and old.</p>`);
  const edited = pulled.replace('a lich', 'a very old lich').replace('and old.', 'and tired.');
  assert.equal(toChronicleSecrets(edited), `<p>The king is ${S('a very old lich')} and tired.</p>`);
});

test('pieces stay separate but still secret when Foundry drops the part numbers', () => {
  const pulled = toFoundrySecrets(`<p>a ${S('b')} c</p>`).replaceAll(/ data-chronicle-part="\d+"/g, '');
  const out = toChronicleSecrets(pulled);
  assert.ok(!chroniclePlayerView(out).includes('b'));
  assert.doesNotMatch(out, new RegExp(PART_ATTR));
});

test('pull leaves existing secret blocks (GM pictures) alone', () => {
  const html = `<section class="secret chronicle-gm-picture" id="secret-chr1"><figure class="ce-img ce-img--gm"><img src="/media/a"></figure></section><p>x ${S('y')}</p>`;
  const out = toFoundrySecrets(html);
  assert.ok(out.startsWith('<section class="secret chronicle-gm-picture" id="secret-chr1"><figure class="ce-img ce-img--gm"><img src="/media/a"></figure></section>'));
});

test('a GM-only picture goes into a secret block whole, and comes back unchanged', () => {
  const fig = '<figure class="ce-img ce-img--w40 ce-img--gm"><img src="/media/a"><figcaption>the lair</figcaption></figure>';
  const html = `<p>x</p>${fig}`;
  const out = toFoundrySecrets(html);
  assert.equal(playerView(out), '<p>x</p>');
  assert.equal(toChronicleSecrets(out), html);
});

test('a picture the GM moves into a secret block goes back GM only, caption untouched', () => {
  const out = toChronicleSecrets('<section class="secret" id="s"><figure class="ce-img"><img src="/media/a"><figcaption>cap</figcaption></figure><p>t</p></section>');
  assert.ok(out.includes('<figure class="ce-img ce-img--gm"><img src="/media/a"><figcaption>cap</figcaption></figure>'));
  assert.ok(out.includes(S('t')));
});

test('a stray closing span inside secret text never leaves part of it visible', () => {
  const out = toChronicleSecrets('<section class="secret" id="s"><p><em>a</span>b</em></p></section>');
  assert.doesNotMatch(chroniclePlayerView(out).replace(/<[^>]*>/g, ''), /[ab]/);
});

test('secret block ranges cover nested blocks', () => {
  const html = `<ul><li>${toFoundrySecrets(`<h2>${S('Secret title')}</h2>`)}</li></ul>`;
  const [[start, end]] = secretBlockRanges(html);
  assert.ok(html.slice(start, end).startsWith('<section class="secret"'));
  assert.ok(html.slice(start, end).endsWith('</section>'));
});

test('journal-sync wires the helper on every pull and push path', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/journal-sync.mjs'), 'utf8');
  const pulls = src.match(/_sanitizeIncomingHTML\(entity\.(?:entry_html|player_notes_html)\b[^)]*\)/g) || [];
  assert.deepEqual(pulls, [], 'every entity HTML pull goes through toFoundrySecrets first');
  assert.equal((src.match(/_sanitizeIncomingHTML\(toFoundrySecrets\(entity\./g) || []).length, 4);
  // The pictures pass runs inside (first), so pictures in a secret block
  // are already marked GM-only when the secret pass sees them.
  assert.match(src, /_collectTextPages\(journal\) \{\s*(?:\/\/[^\n]*\n\s*)*return toChronicleSecrets\(toChroniclePictures\(/);
  assert.match(src, /return toChronicleSecrets\(toChroniclePictures\(playerNotesPage\.text\?\.content \|\| '', getSetting\('apiUrl'\)\)\);/);
  assert.match(src, /secretBlockRanges\(html\)/, 'page breaks skip headings inside secret blocks');
  assert.doesNotMatch(src, /fields:\s*entity\.fields_data/, 'field values (GM-only ones included) are never stored in journal flags');
});

test('a heading that starts GM-only stays one page and comes back with no extra heading', async () => {
  await import('./_journal-test-env.mjs');
  const { JournalSync } = await import('../scripts/journal-sync.mjs');
  const js = Object.create(JournalSync.prototype);
  const html = `<h2>${S('True name:')} Bob</h2><p>body</p><h2>Later</h2><p>z</p>`;
  const sections = js._splitByHeadings(toFoundrySecrets(html));
  assert.deepEqual(sections.map((p) => p.title), ['\u00a0Bob'.trim(), 'Later']);
  assert.ok(!sections.some((p) => /True name/.test(p.title)));
  let n = 0;
  const pages = sections.map((p) => ({
    name: p.title, type: 'text', sort: n++, text: { content: p.content }, getFlag: () => undefined,
  }));
  const back = js._collectTextPages({ pages });
  assert.equal(back, `<h2>${S('True name:')} Bob</h2><p>body</p>\n<h2>Later</h2><p>z</p>`);
});
