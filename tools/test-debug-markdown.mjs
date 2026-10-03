import test from 'node:test';
import assert from 'node:assert/strict';
import { reportToMarkdown } from '../scripts/_debug-markdown.mjs';
import { buildModuleInfo, buildSyncLog, hostOnly, redactText, sanitizeSnapshot } from '../scripts/_debug-snapshot.mjs';

const KEY = 'chr_live_AbCdEf0123456789AbCdEf0123456789XYZ';

test('redactText strips tokens, URLs, emails and long opaque strings', () => {
  assert.equal(redactText('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [redacted]');
  assert.equal(redactText('see https://chron.example.com/campaigns/1/x?token=abc#frag now'), 'see https://chron.example.com now');
  assert.equal(redactText('https://user:pw@chron.example.com:8443/a'), 'https://chron.example.com:8443');
  assert.equal(redactText('GET /entities?key=SECRET&page=2'), 'GET /entities?key=[redacted]&page=2');
  assert.equal(redactText('mail me at a.b@example.org ok'), 'mail me at [email] ok');
  assert.ok(!redactText(`key ${KEY}`).includes(KEY));
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(redactText(`entity ${uuid}`), `entity ${uuid}`);
});

test('hostOnly and module info', () => {
  assert.equal(hostOnly('https://u:p@chron.example.com:8443/api/v1/campaigns/1?token=x'), 'chron.example.com:8443');
  assert.equal(hostOnly('not a url'), '');
  const info = buildModuleInfo({ moduleVersion: '1.2.3', chronicleUrl: 'https://c.example/api/v1?x=1', systemId: 'dnd5e', moneyField: 'Gold (system.gp)' });
  assert.equal(info.chronicleHost, 'c.example');
  assert.equal(info.moneyField, 'Gold (system.gp)');
});

test('buildSyncLog merges, filters, sorts newest first and drops query strings', () => {
  const log = buildSyncLog({
    apiErrors: [{ time: 10, method: 'GET', path: '/entities/1?token=zzz', status: 500, message: 'boom', count: 3 }],
    logRing: [
      { t: 20, level: 'warn', msg: 'skipped one' },
      { t: 30, level: 'info', msg: 'noise' },
      { t: 5, level: 'error', msg: `leak ${KEY}` },
    ],
    limit: 10,
  });
  assert.deepEqual(log.map((e) => e.at), [20, 10, 5]);
  assert.equal(log[1].text, 'GET /entities/1 (500): boom ×3');
  assert.ok(!JSON.stringify(log).includes(KEY));
  assert.equal(buildSyncLog({ apiErrors: Array.from({ length: 80 }, (_, i) => ({ time: i, message: 'x' })) }).length, 50);
});

test('sanitizeSnapshot keeps a fixed shape and scrubs every string', () => {
  const s = sanitizeSnapshot({
    characterName: 'Brin', apiKey: KEY, extra: { x: 1 },
    compare: { moneyLine: `from ${KEY}`, rows: [{ kind: 'item', thing: 'Rope', chronicle: '1', foundry: '', status: 'missing', secret: KEY }] },
    log: [{ at: 1, level: 'error', text: 'a@b.co failed' }],
    info: { moduleVersion: '1', chronicleHost: 'c.example', apiKey: KEY },
  });
  const json = JSON.stringify(s);
  assert.ok(!json.includes(KEY));
  assert.ok(!json.includes('a@b.co'));
  assert.ok(!('apiKey' in s) && !('extra' in s) && !('apiKey' in s.info));
  assert.deepEqual(Object.keys(s), ['characterName', 'compare', 'log', 'info']);
  assert.deepEqual(sanitizeSnapshot(null).compare.rows, []);
});

test('markdown export holds the report and no secrets', () => {
  const report = {
    id: 'r1', fromUserId: 'u1', fromName: 'Ari', characterId: 'c1', at: Date.UTC(2026, 9, 3),
    text: `My gold is wrong. Mail ari@example.com, key ${KEY}, see https://chron.example.com/x?token=abc`,
    status: 'new',
    snapshot: sanitizeSnapshot({
      characterName: 'Brin',
      compare: { moneyLine: 'Money is read from "Gold" in Chronicle and system.gp in this game system\'s Foundry sheet.', rows: [
        { kind: 'money', thing: 'Gold', chronicle: '12', foundry: '11', status: 'different' },
        { kind: 'item', thing: 'Rope | hemp', chronicle: '1', foundry: '', status: 'missing' },
      ] },
      log: [{ at: 1, level: 'error', text: `GET /x failed with Bearer ${KEY}` }],
      info: { moduleVersion: '1.2.3', foundryVersion: '14', systemId: 'dnd5e', systemVersion: '5.0', chronicleHost: 'chron.example.com', moneyField: 'Gold' },
    }),
  };
  const md = reportToMarkdown(report, { statusLabels: { different: 'different count', missing: 'not in Foundry' } });
  assert.ok(md.includes('> My gold is wrong.'));
  assert.ok(md.includes('| Gold | 12 | 11 | different count |'));
  assert.ok(md.includes('Rope \\| hemp'));
  assert.ok(md.includes('not in Foundry'));
  assert.ok(md.includes('Chronicle host: chron.example.com'));
  for (const bad of [KEY, 'ari@example.com', 'token=abc', '/x?']) assert.ok(!md.includes(bad), `leaked ${bad}`);
  assert.ok(!md.includes('u1'));
});

test('markdown export tolerates an empty report', () => {
  const md = reportToMarkdown({});
  assert.ok(md.startsWith('## Problem reported from Foundry'));
});
