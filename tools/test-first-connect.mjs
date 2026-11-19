#!/usr/bin/env node
/**
 * The first-run connect screen: the pure decisions in _first-connect.mjs, and
 * the shape of the screen and its wiring, read as text (no Foundry here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { connectValues, checksPass } from '../scripts/_first-connect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(resolve(root, p), 'utf8');
const LINE = 'chronicle://chronicle.example.com/c/camp-1?key=secret-key';

test('connectValues: a good line gives its parts', () => {
  assert.deepEqual(connectValues({ line: ` ${LINE} ` }), {
    ok: true, baseUrl: 'https://chronicle.example.com', apiKey: 'secret-key', campaignId: 'camp-1', from: 'line',
  });
});

test('connectValues: the line wins over by-hand fields', () => {
  const got = connectValues({ line: LINE, apiUrl: 'https://other.example', apiKey: 'k', campaignId: 'c' });
  assert.equal(got.from, 'line');
  assert.equal(got.campaignId, 'camp-1');
});

test('connectValues: a line that does not parse is BadLine, with no reason and no key', () => {
  for (const line of ['hello', 'chronicle://host/no-campaign?key=abc', 'chronicle://host/c/x', 'https://host/c/x?key=k']) {
    const got = connectValues({ line, apiUrl: 'https://a.example', apiKey: 'k', campaignId: 'c' });
    assert.deepEqual(got, { ok: false, code: 'BadLine' });
  }
});

test('connectValues: by-hand values need all three, else Incomplete; none is Empty', () => {
  assert.deepEqual(connectValues({ apiUrl: ' https://a.example ', apiKey: ' k ', campaignId: ' c ' }),
    { ok: true, baseUrl: 'https://a.example', apiKey: 'k', campaignId: 'c', from: 'hand' });
  assert.deepEqual(connectValues({ apiUrl: 'https://a.example', apiKey: '', campaignId: 'c' }), { ok: false, code: 'Incomplete' });
  assert.deepEqual(connectValues({ apiKey: 'k' }), { ok: false, code: 'Incomplete' });
  assert.deepEqual(connectValues({ line: '  ', apiUrl: ' ' }), { ok: false, code: 'Empty' });
  assert.deepEqual(connectValues(), { ok: false, code: 'Empty' });
});

test('checksPass: needs CampaignOk and no cross; a warning does not block', () => {
  const ok = [{ icon: 'check', code: 'Reachable' }, { icon: 'check', code: 'AuthOk' }, { icon: 'check', code: 'CampaignOk' }];
  assert.equal(checksPass(ok), true);
  assert.equal(checksPass([...ok, { icon: 'check', code: 'SystemMatched' }]), true);
  assert.equal(checksPass([...ok, { icon: 'warn', code: 'SystemNoMatch' }]), true);
  assert.equal(checksPass([...ok, { icon: 'xmark', code: 'Forbidden' }]), false);
  assert.equal(checksPass(ok.slice(0, 2)), false);
  assert.equal(checksPass([{ icon: 'xmark', code: 'Missing' }]), false);
  assert.equal(checksPass([]), false);
  assert.equal(checksPass(undefined), false);
});

test('the unconfigured screen has no settings tabs, reset, submit or test button', async () => {
  const hbs = await read('templates/first-connect.hbs');
  assert.doesNotMatch(hbs, /data-subtab|role="tab"|type="reset"|type="submit"|data-action="testConnection"|data-settings-form/);
  assert.match(hbs, /<details class="cs-by-hand/);
  assert.match(hbs, /<button type="button" class="cs-connect-go" data-connect-go disabled>/);
  assert.match(hbs, /id="cs-first-line" data-field="line" type="password"/);
  assert.match(hbs, /data-field="apiKey" type="password"/);
});

test('the connect line and the key never reach a notice, the page or the console', async () => {
  const src = await read('scripts/first-connect.mjs');
  assert.doesNotMatch(src, /\.reason\b/);
  assert.doesNotMatch(src, /(notifications\.\w+|console\.\w+|innerHTML|textContent|format)\([^;]*(values\.apiKey|\bline\b|\.apiKey)/);
  assert.doesNotMatch(src, /settings\.set\([^)]*apiKey/);
});

test('typed by hand, the key is sent nowhere until the GM leaves a field or presses the button', async () => {
  const src = await read('scripts/first-connect.mjs');
  assert.doesNotMatch(src, /innerHTML/);
  // While typing, a complete by-hand set only enables the button; no check is scheduled.
  const onEdit = src.slice(src.indexOf('const onEdit = () => {'), src.indexOf("for (const name of FIELDS) field[name]?.addEventListener('input', onEdit);"));
  assert.match(onEdit, /if \(values\.ok && values\.from === 'hand'\) \{\s*button\.disabled = false;\s*idle\(\);\s*return;\s*\}\s*button\.disabled = true;\s*timer = setTimeout\(checkQuietly, DEBOUNCE_MS\);/);
  assert.match(src, /for \(const name of \['apiUrl', 'apiKey', 'campaignId'\]\) \{\s*field\[name\]\?\.addEventListener\('change',/);
  // The button checks first when no check has passed yet, and connects only on a pass.
  assert.match(src, /if \(!ready\) await checkQuietly\(\);\s*const values = ready;\s*if \(!values\) return;/);
});

test('connecting sets the setup to open, picks the connection up, and falls back to a reload notice', async () => {
  const src = await read('scripts/first-connect.mjs');
  assert.match(src, /setSetting\('firstRunPending', true\)/);
  assert.match(src, /applyConnection/);
  assert.match(src, /outcome === 'started' \|\| outcome === 'reconnected'/);
  assert.match(src, /FirstConnect\.Connected/);
  const dash = await read('scripts/sync-dashboard.mjs');
  assert.match(dash, /wireFirstConnect\(el, \{ onConnected: \(\) => this\.startFirstRun\(\) \}\)/);
  assert.match(dash, /first-connect\.hbs'/);
});
