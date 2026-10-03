#!/usr/bin/env node
/** Pins `parseConnectLine` (scripts/_connect-line.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectLine } from '../scripts/_connect-line.mjs';

const ID = 'abc12345-6789-4abc-def0-123456789abc';

const OK = [
  ['https', `chronicle://chronicle.example.net/c/${ID}?key=k1`,
    { baseUrl: 'https://chronicle.example.net', campaignId: ID, apiKey: 'k1' }],
  ['http with port and sub-path', `chronicle+http://192.168.1.5:8080/sub/c/${ID}?key=k2`,
    { baseUrl: 'http://192.168.1.5:8080/sub', campaignId: ID, apiKey: 'k2' }],
  ['trailing whitespace/newline', `  chronicle://h.test/c/${ID}?key=k3 \n`,
    { baseUrl: 'https://h.test', campaignId: ID, apiKey: 'k3' }],
  ['encoded key', `chronicle://h.test/c/${ID}?key=a%2Bb%26c%3D%20d`,
    { baseUrl: 'https://h.test', campaignId: ID, apiKey: 'a+b&c= d' }],
  ['nested sub-path', `chronicle://h.test:8443/a/b/c/${ID}?key=k`,
    { baseUrl: 'https://h.test:8443/a/b', campaignId: ID, apiKey: 'k' }],
  ['sub-path containing a /c/ segment uses the final one', `chronicle://h.test/x/c/y/c/${ID}?key=k`,
    { baseUrl: 'https://h.test/x/c/y', campaignId: ID, apiKey: 'k' }],
];

for (const [name, line, want] of OK) {
  test(`accepts: ${name}`, () => {
    assert.deepEqual(parseConnectLine(line), { ok: true, ...want });
  });
}

const BAD = [
  ['https scheme', `https://h.test/c/${ID}?key=k`],
  ['http scheme', `http://h.test/c/${ID}?key=k`],
  ['other scheme', `chronicle+ftp://h.test/c/${ID}?key=k`],
  ['missing key', `chronicle://h.test/c/${ID}`],
  ['empty key', `chronicle://h.test/c/${ID}?key=`],
  ['missing /c/ segment', 'chronicle://h.test/?key=k'],
  ['missing campaign id', 'chronicle://h.test/c/?key=k'],
  ['userinfo', `chronicle://user:pw@h.test/c/${ID}?key=k`],
  ['userinfo without password', `chronicle://user@h.test/c/${ID}?key=k`],
  ['empty', '   '],
  ['non-string', null],
  ['garbage', 'not a url'],
];

for (const [name, line] of BAD) {
  test(`rejects: ${name}`, () => {
    const r = parseConnectLine(line);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.ok(!JSON.stringify(r).includes('?key='), 'reason must not echo the line');
  });
}

// Source pins for the settings wiring (settings.mjs needs Foundry globals).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const settingsSrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/settings.mjs'), 'utf8');

test('connectLine setting is client-scoped and clears itself', () => {
  const reg = settingsSrc.slice(settingsSrc.indexOf("register(MODULE_ID, 'connectLine'"));
  assert.match(reg.slice(0, 500), /scope: 'client'/);
  assert.match(settingsSrc, /game\.settings\.set\(MODULE_ID, 'connectLine', ''\)/);
});

test('applyConnectLine is GM-gated and writes the key to the client-scoped setting only', () => {
  const fn = settingsSrc.slice(settingsSrc.indexOf('export async function applyConnectLine'));
  assert.ok(fn.indexOf('isGM') < fn.indexOf("'apiUrl'"));
  assert.match(fn, /set\(MODULE_ID, 'apiKey', parsed\.apiKey\)/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}\n')), /console\.(log|info|debug)/);
});
