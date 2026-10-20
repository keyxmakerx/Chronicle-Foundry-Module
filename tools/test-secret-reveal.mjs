#!/usr/bin/env node
/**
 * Foundry's Reveal on a synced page (scripts/_gm-secrets.mjs): the
 * placeholder tag is one Reveal can find, a revealed placeholder holds its
 * content for players and goes back to the label when hidden, a pull keeps
 * the reveal, and a push sends the content once, never doubled.
 *
 * Run: node --test tools/test-secret-reveal.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toFoundrySecrets, hideSecrets, restoreSecrets, applyReveals, carryReveals, revealableSecrets,
  DEFAULT_PLACEHOLDER_TEXT,
} from '../scripts/_gm-secrets.mjs';

const keyOf = async (c) => `h${c.length}`;
const CHRONICLE = '<p>Shared text. <span data-secret="true">Lastwell is a dungeon break.</span></p>';

async function pulled() {
  return hideSecrets(toFoundrySecrets(CHRONICLE), DEFAULT_PLACEHOLDER_TEXT, keyOf);
}

// The regex Foundry's HTMLSecret uses to find the block it toggles, and the
// swap it makes on the match.
function foundryReveal(html, id) {
  return html.replace(new RegExp(`<section[^i]+id="${id}"[^>]*>`), (m) => m.replace('secret', 'secret revealed'));
}
function foundryHide(html, id) {
  return html.replace(new RegExp(`<section[^i]+id="${id}"[^>]*>`), (m) => m.replace('secret revealed', 'secret'));
}

test('Foundry\'s Reveal finds and flips every placeholder sync writes', async () => {
  const { html, pieces } = await pulled();
  assert.ok(pieces.size >= 1);
  for (const id of pieces.keys()) {
    const after = foundryReveal(html, id);
    assert.notEqual(after, html, `Reveal could not find ${id}`);
    assert.match(after, new RegExp(`class="secret revealed" id="${id}"`));
  }
});

test('an old tag order is put right, and a right one left alone', async () => {
  const { html, pieces } = await pulled();
  const id = [...pieces.keys()][0];
  const old = html.replace(new RegExp(`<section class="secret" id="${id}"([^>]*)>`), `<section class="secret"$1 id="${id}">`);
  assert.notEqual(old, html);
  assert.equal(revealableSecrets(old), html);
  assert.equal(revealableSecrets(html), null);
});

test('revealed shows the content, hidden shows the label again', async () => {
  const { html, pieces } = await pulled();
  const id = [...pieces.keys()][0];
  const shown = applyReveals(foundryReveal(html, id), pieces, DEFAULT_PLACEHOLDER_TEXT);
  assert.ok(shown.includes('Lastwell is a dungeon break.'));
  assert.ok(!shown.includes(DEFAULT_PLACEHOLDER_TEXT));
  const hidden = applyReveals(foundryHide(shown, id), pieces, DEFAULT_PLACEHOLDER_TEXT);
  assert.equal(hidden, html);
  assert.equal(applyReveals(html, pieces, DEFAULT_PLACEHOLDER_TEXT), null);
});

test('a block whose content is unknown is left as it is', async () => {
  const { html, pieces } = await pulled();
  const id = [...pieces.keys()][0];
  assert.equal(applyReveals(foundryReveal(html, id), new Map(), DEFAULT_PLACEHOLDER_TEXT), null);
});

test('a pull keeps the reveal', async () => {
  const { html, pieces } = await pulled();
  const id = [...pieces.keys()][0];
  const before = applyReveals(foundryReveal(html, id), pieces, DEFAULT_PLACEHOLDER_TEXT);
  const kept = carryReveals(before, html);
  assert.match(kept, /class="secret revealed"/);
  assert.ok(applyReveals(kept, pieces, DEFAULT_PLACEHOLDER_TEXT).includes('Lastwell is a dungeon break.'));
  assert.equal(carryReveals(html, html), html);
});

test('a push of a revealed page sends the secret once, still secret', async () => {
  const { html, pieces } = await pulled();
  const id = [...pieces.keys()][0];
  const shown = applyReveals(foundryReveal(html, id), pieces, DEFAULT_PLACEHOLDER_TEXT);
  const fromHidden = restoreSecrets(html, pieces, DEFAULT_PLACEHOLDER_TEXT);
  const fromShown = restoreSecrets(shown, pieces, DEFAULT_PLACEHOLDER_TEXT);
  assert.deepEqual(fromShown.missing, []);
  assert.equal(fromShown.gmMade, false);
  assert.equal(fromShown.html.split('Lastwell is a dungeon break.').length, 2);
  assert.equal(fromShown.html.replace(' revealed', ''), fromHidden.html);
});
