#!/usr/bin/env node
/**
 * Static pins for the Stashes wiring that the pure-helper tests cannot see:
 * the sender identity comes from the socket layer, request cards are
 * whispers, and every CHRONICLE.Stashes.* string the code asks for exists.
 *
 * Run: `node --test tools/test-stash-wiring.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const sync = read('scripts/stash-sync.mjs');
const client = read('scripts/stash-client.mjs');
const window_ = read('scripts/stash-window.mjs');
const template = read('templates/stash-window.hbs');
const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Stashes;

function body(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced');
}

test('socket listener takes the sender from the second argument and hands it on', () => {
  assert.match(client, /game\.socket\.on\(SOCKET_CHANNEL,\s*\(data,\s*senderId\)/);
  assert.match(client, /handleRequest\(data,\s*senderId\)/);
});

test('handleRequest never reads a user id out of the message', () => {
  const src = body(sync, 'async handleRequest(msg, senderId)');
  assert.equal(/msg\??\.(userId|actingUserId|user)\b/.test(src), false);
  assert.match(src, /senderId,/);
});

test('the window request carries no user id', () => {
  const src = body(client, 'export async function stashRequest(msg, owner = null)');
  assert.equal(/userId/i.test(src.replace(/toUserId/g, '')), false);
});

test('request cards are whispered to GM users', () => {
  const src = body(sync, 'async _postCard(model)');
  assert.match(src, /getWhisperRecipients\('GM'\)/);
  assert.match(src, /whisper:\s*gmIds/);
});

test('only the active GM answers, posts cards and refreshes', () => {
  assert.match(body(sync, 'async handleRequest(msg, senderId)'), /_isActive\(\)/);
  assert.match(body(sync, 'async _syncCards()'), /_isActive\(\)/);
  assert.match(body(sync, 'refreshCharacters(entityIds, removal = null)'), /_isActive\(\)/);
  assert.match(client, /isAnsweringGM\(game\.user,\s*game\.users\.activeGM\)/);
});

test('answering a request is GM-only on the client too', () => {
  assert.match(body(sync, 'async answer(moveId, action)'), /game\.user\.isGM/);
});

test('every lang key the code and template ask for exists', () => {
  const keys = new Set();
  for (const [src, re] of [
    [sync, /\bt\('([A-Za-z.]+)'/g],
    [window_, /\bt\('([A-Za-z.]+)'/g],
    [template, /CHRONICLE\.Stashes\.([A-Za-z.]+)/g],
    [client, /CHRONICLE\.Stashes\.([A-Za-z.]+)/g],
  ]) {
    let m;
    while ((m = re.exec(src)) !== null) if (!m[1].endsWith('.')) keys.add(m[1]);
  }
  // Keys built from a variable name in a helper.
  for (const k of ['DowntimeOpen', 'DowntimeClosed', 'HintNow', 'HintAsk', 'HintGM', 'Move', 'Ask']) keys.add(k);
  for (const k of ['NoGM', 'Timeout', 'NoMapping', 'NotOwner', 'Forbidden', 'NotFound', 'Conflict', 'BadRequest', 'Generic', 'Cancelled', 'GMNotReady']) keys.add(`Error.${k}`);
  const missing = [];
  for (const key of keys) {
    const val = key.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), lang);
    if (typeof val !== 'string') missing.push(key);
  }
  assert.deepEqual(missing, []);
});

test('framing keys returned by moveFraming exist', async () => {
  const { moveFraming } = await import('../scripts/_stash-model.mjs');
  for (const isGM of [true, false]) {
    for (const downtimeOpen of [true, false]) {
      const f = moveFraming({ downtimeOpen, isGM });
      assert.equal(typeof lang[f.hintKey], 'string', f.hintKey);
      assert.equal(typeof lang[f.buttonKey], 'string', f.buttonKey);
    }
  }
});

test('the downtime pill and hint wording match the signed design', () => {
  assert.equal(lang.DowntimeOpen, 'Downtime is open');
  assert.equal(lang.DowntimeClosed, 'Not in downtime');
  assert.equal(lang.HintNow, 'This happens now.');
  assert.equal(lang.HintAsk, 'Your GM has to approve this; it stays with you until then.');
  assert.equal(lang.Ask, 'Ask the GM');
});
