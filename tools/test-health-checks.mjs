/**
 * Tests for the Health pane's checklist (scripts/_health-checks.mjs) and the
 * pane's markup. The builder is pure, so these run without Foundry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildHealthChecks, describeWaiting } from '../scripts/_health-checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const healthy = {
  connectionState: 'connected',
  since: '19:30',
  reconnects: 2,
  lastAnswer: '19:42',
  waiting: 0,
  errorCount: 0,
  newestError: null,
  dice: { state: 'ok', stateLabel: 'Dice So Nice is on', rows: [{ level: 'ok', text: 'fine', fix: '' }] },
  systemMatched: true,
  matchedSystem: 'Draw Steel',
  foundrySystem: 'draw-steel',
  syncCharacters: true,
  capability: { available: true, summary: { synced: 38, totalDeclared: 38 }, source: { actorName: 'Kessa Vane' } },
};
const build = (over = {}) => buildHealthChecks({ ...healthy, ...over });
const byId = (rows, id) => rows.find((r) => r.id === id);

test('a healthy world is all ok rows with no actions', () => {
  const rows = build();
  assert.deepEqual(rows.map((r) => r.id), ['connection', 'dice-ok', 'system', 'fields']);
  assert.ok(rows.every((r) => r.level === 'ok'));
  assert.ok(rows.every((r) => !r.action));
});

test('problems come first: bad, then warn, then ok', () => {
  const rows = build({
    connectionState: 'disconnected',
    waiting: 3,
    newestError: { time: '19:40', message: 'conflict' },
    dice: { state: 'warn', rows: [{ level: 'warn', text: 'one face is missing', fix: 'reinstall' }] },
  });
  const order = { bad: 0, warn: 1, ok: 2 };
  const levels = rows.map((r) => order[r.level]);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.equal(rows[0].id, 'connection');
  assert.equal(rows[0].level, 'bad');
});

test('connection rows', () => {
  const cases = [
    ['connected', 'ok', 'Connected to Chronicle', undefined],
    ['connecting', 'warn', 'Reconnecting to Chronicle', 'Reconnect now'],
    ['reconnecting', 'warn', 'Reconnecting to Chronicle', 'Reconnect now'],
    ['disconnected', 'bad', 'Not connected to Chronicle', 'Reconnect'],
    ['', 'bad', 'Not connected to Chronicle', 'Reconnect'],
  ];
  for (const [state, level, title, label] of cases) {
    const row = byId(build({ connectionState: state }), 'connection');
    assert.equal(row.level, level, state);
    assert.equal(row.title, title, state);
    assert.equal(row.action?.label, label, state);
    if (label) assert.equal(row.action.kind, 'reconnect');
  }
});

test('connected detail leaves out what is unknown and words the reconnect count', () => {
  const detail = (over) => byId(build(over), 'connection').detail;
  assert.equal(detail({}), 'Since 19:30, with 2 reconnects. Last answer at 19:42.');
  assert.equal(detail({ reconnects: 0 }), 'Since 19:30, with no reconnects. Last answer at 19:42.');
  assert.equal(detail({ reconnects: 1 }), 'Since 19:30, with 1 reconnect. Last answer at 19:42.');
  assert.equal(detail({ lastAnswer: '' }), 'Since 19:30, with 2 reconnects.');
  assert.equal(detail({ since: '' }), 'With 2 reconnects. Last answer at 19:42.');
  assert.equal(detail({ since: null, reconnects: null }), 'Last answer at 19:42.');
  assert.equal(detail({ since: '', reconnects: null, lastAnswer: '' }), '');
  assert.equal(detail({ reconnects: null }), 'Since 19:30. Last answer at 19:42.');
});

test('waiting changes: singular, plural, last failure, action', () => {
  const one = byId(build({ waiting: 1 }), 'waiting');
  assert.equal(one.title, '1 change is waiting to be sent to Chronicle');
  assert.equal(one.level, 'warn');
  assert.equal(one.detail, 'They are sent again by themselves when Chronicle is reachable.');
  assert.deepEqual(one.action, { kind: 'toggle-waiting', label: 'Show them' });

  const many = byId(build({ waiting: 3, newestError: { time: '19:40', message: 'the page was changed.' } }), 'waiting');
  assert.equal(many.title, '3 changes are waiting to be sent to Chronicle');
  assert.match(many.detail, /The last one failed at 19:40: the page was changed\.$/);
  assert.ok(!/\.\./.test(many.detail));

  assert.equal(byId(build({ waiting: 0 }), 'waiting'), undefined);
});

test('recent errors show only when nothing is waiting', () => {
  const err = { time: '19:40', message: 'boom' };
  const one = byId(build({ errorCount: 1, newestError: err }), 'errors');
  assert.equal(one.title, '1 recent sync error');
  assert.equal(one.detail, 'The latest, at 19:40: boom');
  assert.deepEqual(one.action, { kind: 'open-drawer', label: 'Show them' });
  assert.equal(byId(build({ errorCount: 4, newestError: err }), 'errors').title, '4 recent sync errors');
  assert.equal(byId(build({ errorCount: 4, waiting: 2, newestError: err }), 'errors'), undefined);
  assert.equal(byId(build({ errorCount: 0 }), 'errors'), undefined);
});

test('dice rows', () => {
  const warn = build({
    dice: { state: 'warn', stateLabel: 'x', rows: [
      { level: 'ok', text: 'fine' },
      { level: 'warn', text: 'one face picture is missing', fix: 'reinstall the module' },
      { level: 'error', text: 'no files found', fix: '' },
    ] },
  });
  const w = byId(warn, 'dice-0');
  assert.equal(w.level, 'warn');
  assert.equal(w.title, 'Dice: one face picture is missing');
  assert.equal(w.detail, 'Fix: reinstall the module');
  assert.deepEqual(w.action, { kind: 'check-dice', label: 'Check dice files' });
  const e = byId(warn, 'dice-1');
  assert.equal(e.level, 'bad');
  assert.equal(e.detail, '');
  assert.equal(byId(warn, 'dice-ok'), undefined);

  const ok = byId(build(), 'dice-ok');
  assert.equal(ok.title, 'Dice So Nice is on');
  assert.equal(ok.action, undefined);

  const off = build({ dice: { state: 'off', rows: [] } });
  assert.ok(!off.some((r) => r.id.startsWith('dice')));
  assert.ok(!build({ dice: null }).some((r) => r.id.startsWith('dice')));
});

test('game system rows', () => {
  const on = byId(build(), 'system');
  assert.equal(on.title, 'Game system matched: Draw Steel');
  assert.equal(on.detail, 'Character sync is on.');
  assert.equal(on.action, undefined);

  const off = byId(build({ syncCharacters: false }), 'system');
  assert.equal(off.level, 'ok');
  assert.equal(off.detail, 'Character sync is off. Turn it on in Settings.');
  assert.deepEqual(off.action, { kind: 'open-settings', label: 'Open settings' });

  const none = byId(build({ systemMatched: false, matchedSystem: null }), 'system');
  assert.equal(none.level, 'warn');
  assert.equal(none.title, 'No game system in Chronicle matches this world');
  assert.match(none.detail, /a system for draw-steel\.$/);
  assert.match(byId(build({ systemMatched: false, foundrySystem: null }), 'system').detail, /a matching system\.$/);
});

test('sheet fields row', () => {
  const full = byId(build(), 'fields');
  assert.equal(full.level, 'ok');
  assert.equal(full.title, '38 of 38 sheet fields come across');
  assert.equal(full.action, undefined);

  const gap = byId(build({ capability: { available: true, summary: { synced: 31, totalDeclared: 38 }, source: { actorName: 'Kessa Vane' } } }), 'fields');
  assert.equal(gap.level, 'warn');
  assert.equal(gap.title, '31 of 38 sheet fields come across');
  assert.equal(gap.detail, 'Checked on Kessa Vane.');
  assert.deepEqual(gap.action, { kind: 'open-drawer', label: 'Which don’t?' });

  for (const capability of [null, undefined, { available: false }, { available: true }]) {
    assert.equal(byId(build({ capability }), 'fields'), undefined);
  }
  const noActor = byId(build({ capability: { available: true, summary: { synced: 1, totalDeclared: 2 } } }), 'fields');
  assert.equal(noActor.detail, '');
});

test('describeWaiting turns method and path into plain words', () => {
  const cases = [
    [{ method: 'PUT', path: '/entities/88', retries: 0 }, 'A page’s changes', ''],
    [{ method: 'POST', path: '/entities', retries: 1 }, 'A new page', 'tried 1 time'],
    [{ method: 'DELETE', path: '/entities/88', retries: 2 }, 'A page removal', 'tried 2 times'],
    [{ method: 'PUT', path: '/maps/4/markers', retries: 0 }, 'A map change', ''],
    [{ method: 'POST', path: '/calendar/events', retries: 0 }, 'A calendar change', ''],
    [{ method: 'PATCH', path: '/shops/2', retries: 0 }, 'A change', ''],
    [{ method: 'PUT', path: '/entities-other/1' }, 'A change', ''],
    [{}, 'A change', ''],
  ];
  for (const [item, text, tried] of cases) {
    assert.deepEqual(describeWaiting(item), { text, tried }, JSON.stringify(item));
  }
});

test('no row or waiting text carries a request body or key', () => {
  const item = { method: 'PUT', path: '/entities/88', retries: 1, body: '{"secret":"SECRET-BODY"}', apiKey: 'KEY-123' };
  const words = describeWaiting(item);
  const rows = build({ waiting: 1, newestError: { time: '19:40', message: 'conflict' } });
  const all = JSON.stringify([words, rows]);
  assert.ok(!all.includes('SECRET-BODY'));
  assert.ok(!all.includes('KEY-123'));
  assert.ok(!all.includes('/entities/88'), 'paths are put into words, not shown');
});

test('rows read t() so a translation reaches every string', () => {
  const t = (key) => `<<${key.split('.').pop()}>>`;
  const rows = buildHealthChecks({ ...healthy, connectionState: 'disconnected', t });
  assert.equal(rows[0].title, '<<NotConnectedTitle>>');
  assert.equal(rows[0].action.label, '<<Reconnect>>');
});

test('the pure module has no DOM, game or foundry reference', () => {
  const src = read('scripts/_health-checks.mjs').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\b(game|foundry|document|window|ui)\./.test(src));
});

test('every key the module reads exists in lang/en.json', () => {
  const lang = JSON.parse(read('lang/en.json'));
  const block = lang.CHRONICLE.Dashboard.HealthChecks;
  const src = read('scripts/_health-checks.mjs');
  const keys = [...src.matchAll(/tr\('(\w+)'/g)].map((m) => m[1])
    .concat([...src.matchAll(/'(\w+)'/g)].map((m) => m[1]).filter((k) => /^(Reconnects|Wait|Tried)/.test(k)));
  for (const k of keys) assert.ok(k in block, `HealthChecks.${k}`);
});

test('the Health pane is a checklist, one copy button and a closed drawer', () => {
  const hbs = read('templates/sync-dashboard.hbs');
  const start = hbs.indexOf('data-subpane="problems:health"');
  const end = hbs.indexOf('data-subpane="problems:reports"');
  const pane = hbs.slice(start, end);
  assert.match(pane, /\{\{#each health\.rows\}\}/);
  assert.match(pane, /<b>\{\{title\}\}<\/b>/);
  assert.ok(!/\{\{\{/.test(pane), 'row text is escaped');
  assert.match(pane, /data-action="copy-diagnostic-bundle"/);
  assert.match(pane, /fa-clipboard-check/);
  const drawerAt = pane.indexOf('<details class="cs-health-drawer"');
  assert.ok(drawerAt > pane.indexOf('copy-diagnostic-bundle'), 'the button sits above the drawer');
  assert.match(pane, /\{\{#if health\.drawerOpen\}\} open\{\{\/if\}\}/);
  const drawer = pane.slice(drawerAt);
  for (const needle of ['capability-actor-select', 'error-log', 'data-action="copy-debug"', 'copy-capability', 'check-dice-files',
    'diagnostics-grid', 'fieldMappingInfo', 'dice-check-rows']) {
    assert.ok(drawer.includes(needle), `the drawer keeps ${needle}`);
  }
  assert.ok(!pane.slice(0, drawerAt).includes('capability-actor-select'));
});

test('the dashboard keeps the drawer state and wires the row actions', () => {
  const js = read('scripts/sync-dashboard.mjs');
  assert.match(js, /this\._healthDrawerOpen = false/);
  assert.match(js, /'health-row': SyncDashboard\.#onHealthRowAction/);
  assert.match(js, /'health-send-waiting': SyncDashboard\.#onHealthSendWaitingAction/);
  assert.match(js, /addEventListener\('toggle'/);
  assert.match(js, /processRetryQueue\(\)/);
  const api = read('scripts/api-client.mjs');
  const m = api.match(/getRetryQueue\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'getRetryQueue exists');
  assert.ok(!/body/.test(m[0]), 'the waiting list never carries the body');
});
