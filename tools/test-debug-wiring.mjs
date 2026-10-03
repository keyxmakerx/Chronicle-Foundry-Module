#!/usr/bin/env node
/**
 * Static pins for the Debug tab and problem-report wiring that the pure
 * helpers cannot see: the reporter comes from the socket layer, the GM client
 * builds the snapshot, only the GM writes the reports, the side by side never
 * writes, and every CHRONICLE.Debug.* string the code or templates ask for
 * exists.
 *
 * Run: `node --test tools/test-debug-wiring.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const hub = read('scripts/debug-hub.mjs');
const dashboard = read('scripts/sync-dashboard.mjs');
const stashWindow = read('scripts/stash-window.mjs');
const dashHbs = read('templates/sync-dashboard.hbs');
const stashHbs = read('templates/stash-window.hbs');
const settings = read('scripts/settings.mjs');
const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Debug;

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

test('the socket listener passes the sender id on and reads no identity from the payload', () => {
  assert.match(hub, /game\.socket\.on\(SOCKET_CHANNEL,\s*\(data,\s*senderId\)/);
  assert.match(hub, /receiveReport\(data,\s*senderId\)/);
  const src = body(hub, 'export async function receiveReport');
  assert.equal(/msg\??\.(userId|fromUserId|fromName|user|snapshot)\b/.test(src), false);
  assert.match(src, /game\.users\.get\(senderId\)/);
});

test('only the active GM takes reports, and only a GM may acknowledge', () => {
  assert.match(hub, /isAnsweringGM\(game\.user,\s*game\.users\.activeGM\)/);
  assert.match(hub, /fromGM/);
  assert.match(hub, /data\.toUserId !== game\.user\.id/);
});

test('the snapshot is built on the GM client from live data', () => {
  const src = body(hub, 'export async function receiveReport');
  assert.match(src, /gatherSideBySide\(actor\)/);
  assert.match(src, /snapshotFrom\(/);
});

test('reports are written by the GM only', () => {
  assert.match(body(hub, 'export async function markReportDone'), /game\.user\.isGM/);
  assert.match(body(hub, 'export async function receiveReport'), /!game\.user\.isGM/);
});

test('reports live in a journal entry nobody but GMs can see, found by flag', () => {
  const find = body(hub, 'export function findStore');
  assert.match(find, /getFlag\(FLAG_SCOPE,\s*REPORT_STORE_FLAG\)/);
  assert.equal(/\.name\b/.test(find), false);
  const ensure = body(hub, 'export function ensureStore');
  assert.match(ensure, /ownership:\s*\{\s*default:\s*CONST\.DOCUMENT_OWNERSHIP_LEVELS\.NONE\s*\}/);
  assert.match(ensure, /isAnsweringGM\(game\.user,\s*game\.users\.activeGM\)/);
  assert.match(ensure, /SYNC_OPTIONS/);
  // Nothing writes the old world setting except to clear it.
  const setCalls = [...hub.matchAll(/setSetting\('problemReports',\s*([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(setCalls, ['[]']);
  assert.match(hub, /renderJournalDirectory/);
  assert.match(dashboard, /REPORT_STORE_FLAG/);
  assert.match(read('scripts/import-wizard.mjs'), /REPORT_STORE_FLAG/);
});

test('the side by side only reads', () => {
  const src = body(hub, 'export async function gatherSideBySide');
  assert.equal(/\.(post|put|patch|delete)\(/.test(src), false);
  assert.equal(/\.(update|create|delete)\w*\(/.test(src), false);
  assert.equal(/action:\s*'(move|history)'/.test(src), false);
});

test('the Stashes window sends through submitReport and caps the box', () => {
  assert.match(stashWindow, /submitReport\(\{ characterId: this\.characterId/);
  assert.match(stashHbs, /maxlength="\{\{report\.max\}\}"/);
});

test('every Debug string the code and templates use exists', () => {
  const sources = [hub, dashboard, stashWindow, dashHbs, stashHbs].join('\n');
  const used = new Set();
  for (const m of sources.matchAll(/CHRONICLE\.Debug\.([A-Za-z.]+)/g)) used.add(m[1].replace(/\.$/, ''));
  // Keys built from a variable.
  for (const k of ['Time.Now', 'Time.Minutes', 'Time.Hours', 'Time.Days', 'Status.Match', 'Status.Different', 'Status.Missing',
    'Status.FoundryOnly', 'Report.NoGM', 'Report.RateLimited', 'Report.Failed', 'Unlinked', 'ChronicleError', 'InfoModule',
    'InfoFoundry', 'InfoSystem', 'InfoHost', 'InfoMoney', 'InfoUnknown', 'InfoMoneyPending']) used.add(k);
  assert.ok(used.size > 20);
  for (const key of used) {
    const value = key.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), lang);
    // A bare group name is the prefix of a variable-built key, listed above.
    if (value && typeof value === 'object') continue;
    assert.equal(typeof value, 'string', `missing CHRONICLE.Debug.${key}`);
  }
});

test('the required wording is present', () => {
  assert.equal(lang.Report.Prompt, 'What went wrong?');
  assert.equal(lang.Report.Hint, 'Your GM gets this with a snapshot of this character.');
  assert.equal(lang.Report.Send, 'Send to GM');
  assert.equal(lang.Report.Sent, 'Sent to your GM');
  assert.equal(lang.Report.NoGM, 'No GM is connected; try again later.');
  assert.equal(lang.MoneyLine, 'Money is read from "{label}" in Chronicle and {path} in this game system\'s Foundry sheet.');
  assert.equal(lang.ReportedNotice, '{name} reported a problem');
});
