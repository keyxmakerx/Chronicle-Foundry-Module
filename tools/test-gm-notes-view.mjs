#!/usr/bin/env node
/**
 * The GM's notes shown in the sheet's GM-only box come from Chronicle on the
 * GM's client and are never saved on the actor.
 *
 * Run: `node --test tools/test-gm-notes-view.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  gmNotesBoxes, gmNotesText, holdsOwnText, pageReader, notesHtml, notesPlainText, stripFormParts, FORM_PARTS,
} = await import('../scripts/_gm-notes-view.mjs');

const FIELDS = [
  { key: 'backstory', owner_only: true, foundry_path: 'system.biography.value' },
  { key: 'gm_notes', label: 'GM Notes', gm_only: true, foundry_clear_path: 'system.biography.director' },
  { key: 'odd', gm_only: true, foundry_clear_path: 'flags.x.y' },
  { key: 'mapped', gm_only: true, foundry_path: 'system.secret' },
];

test('a box for each GM-only field the system maps onto the actor', () => {
  assert.deepEqual(gmNotesBoxes(FIELDS), [
    { key: 'gm_notes', path: 'system.biography.director', schemaPath: 'biography.director' },
  ]);
  assert.deepEqual(gmNotesBoxes(null), []);
});

test('the notes are the page field as Chronicle stores it', () => {
  assert.equal(gmNotesText({ fields_data: { gm_notes: '  <p>Secret</p> ' } }, 'gm_notes'), '<p>Secret</p>');
  assert.equal(gmNotesText({ fields_data: {} }, 'gm_notes'), '');
  assert.equal(gmNotesText({ fields_data: { gm_notes: 3 } }, 'gm_notes'), '');
  assert.equal(gmNotesText(null, 'gm_notes'), '');
});

test('text typed in Foundry counts as the actor\'s own; empty markup does not', () => {
  const actor = (v) => ({ system: { biography: { director: v } } });
  assert.equal(holdsOwnText(actor('<p>Mine</p>'), 'system.biography.director'), true);
  assert.equal(holdsOwnText(actor('<p> </p>'), 'system.biography.director'), false);
  assert.equal(holdsOwnText(actor(''), 'system.biography.director'), false);
  assert.equal(holdsOwnText({ system: {} }, 'system.biography.director'), false);
});

test('a sheet that draws several times reads Chronicle once, and a failure is not kept', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const reader = pageReader(async (id) => {
    calls += 1;
    if (fail) throw new Error('down');
    return { id };
  }, { ttlMs: 1000, now: () => clock });
  await reader.get('e1');
  await reader.get('e1');
  assert.equal(calls, 1);
  reader.forget('e1');
  await reader.get('e1');
  assert.equal(calls, 2);
  clock = 5000;
  fail = true;
  await assert.rejects(reader.get('e1'));
  fail = false;
  await reader.get('e1');
  assert.equal(calls, 4, 'a failed read is read again, not served from the cache');
});

test('notes that carry form parts lose every one before joining the sheet', () => {
  for (const part of ['input', 'select', 'textarea', 'button', 'form', 'option', 'output', 'fieldset', 'prose-mirror']) {
    assert.ok(FORM_PARTS.split(',').map((p) => p.trim()).includes(part), `FORM_PARTS must cover ${part}`);
  }
  // Notes as Foundry might parse them: controls the form would collect, and
  // elements whose attributes would join the form or that Foundry acts on.
  const removed = [];
  const parts = ['input', 'select', 'prose-mirror'].map((tag) => ({ tag, remove() { removed.push(tag); } }));
  const attrs = (names) => {
    const el = { left: new Set(names) };
    el.attributes = names.map((name) => ({ name }));
    el.removeAttribute = (name) => el.left.delete(name);
    return el;
  };
  const div = attrs(['class', 'data-edit', 'name', 'form', 'contenteditable', 'onclick', 'is']);
  const img = attrs(['src', 'alt', 'data-edit']);
  const link = attrs(['href', 'title', 'data-action', 'data-uuid', 'ONMOUSEOVER']);
  const gone = [];
  const tpl = { remove() { gone.push('template'); } };
  const embed = { localName: 'document-embed', childNodes: ['words'], replaceWith(...kids) { gone.push(`embed:${kids.join()}`); } };
  const root = {
    querySelectorAll(sel) {
      if (sel === FORM_PARTS) return parts;
      if (sel === 'template') return [tpl];
      return sel === '*' ? [div, img, link, embed] : [];
    },
  };
  assert.equal(stripFormParts(root), 3);
  assert.deepEqual(gone, ['template', 'embed:words'], 'templates go; a custom element leaves its children');
  assert.deepEqual(removed, ['input', 'select', 'prose-mirror']);
  assert.deepEqual([...div.left], ['class']);
  assert.deepEqual([...img.left], ['src', 'alt']);
  assert.deepEqual([...link.left], ['href', 'title']);
});

test('a missing or failing sanitizer shows the notes as text, never as HTML', () => {
  const raw = '<p>Secret <img src=x onerror=alert(1)></p><script>x()</script>';
  assert.equal(notesHtml(raw, null), null);
  assert.equal(notesHtml(raw, undefined), null);
  assert.equal(notesHtml(raw, () => { throw new Error('boom'); }), null);
  assert.equal(notesHtml(raw, () => 42), null);
  assert.equal(notesHtml(raw, (h) => h.replace(/<script>.*<\/script>/, '')), '<p>Secret <img src=x onerror=alert(1)></p>');
  assert.equal(notesPlainText('<p>One &amp; two</p><ul><li>A</li><li>B</li></ul>'), 'One & two\nA\nB');
});

const VIEW = readFileSync(new URL('../scripts/gm-notes-view.mjs', import.meta.url), 'utf8');
const CODE = VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SYNC = readFileSync(new URL('../scripts/actor-sync.mjs', import.meta.url), 'utf8');

test('the view never writes to the actor or into the sheet\'s form', () => {
  for (const write of ['.update(', 'setFlag(', 'unsetFlag(', 'updateSource(', '.submit(', 'ChatMessage']) {
    assert.ok(!CODE.includes(write), `gm-notes-view.mjs must not call ${write}`);
  }
  // No form control of its own: a named input or a value would be saved
  // with the sheet's form.
  assert.ok(!/createElement\(\s*['"](input|textarea|select|prose-mirror)['"]/.test(CODE));
  assert.ok(!/\.name\s*=|setAttribute\(\s*['"]name['"]/.test(CODE));
  assert.ok(!/\.value\s*=/.test(CODE));
});

test('only a GM client draws the notes, and the HTML is sanitized', () => {
  assert.match(CODE, /register\(\) \{\s*if \(!this\.active \|\| !game\.user\?\.isGM\) return;/);
  assert.match(CODE, /_onRender\(app, html\) \{\s*if \(!game\.user\?\.isGM\) return;/);
  // The notes are parsed in an inert template, stripped, then moved in;
  // the only other innerHTML is the escaped link label.
  const html = CODE.match(/\.innerHTML = [^;]+;/g) ?? [];
  assert.deepEqual(html.map((l) => l.replace(/\s+/g, ' ')).sort(), [
    '.innerHTML = `${escapeHtml(t(\'Edit\'))} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>`;',
    '.innerHTML = clean;',
  ].sort());
  assert.match(CODE, /const clean = notesHtml\(html, _resolveCleanHTML\(\)\);\s*if \(clean === null\) \{\s*body\.textContent = notesPlainText\(html\);/);
  assert.match(CODE, /tpl\.innerHTML = clean;\s*stripFormParts\(tpl\.content\);\s*body\.replaceChildren\(tpl\.content\);/);
  assert.ok(!CODE.includes('_sanitizeIncomingHTML'), 'the fail-open sanitizer is not used for live DOM');
});

test('actor sync builds the view with its GM-only fields and drops a read on each update', () => {
  assert.match(SYNC, /new GmNotesView\(\{\s*api, fields: this\._adapter\.gmClearFields,/);
  assert.match(SYNC, /this\._gmNotes\.register\(\);/);
  assert.match(SYNC, /this\._gmNotes\?\.destroy\(\);/);
  assert.match(SYNC, /case 'entity\.updated':\s*this\._gmNotes\?\.forget\(entity\.id\);/);
});
