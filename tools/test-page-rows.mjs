/**
 * Tests for the Pages list: its rules (scripts/_page-rows.mjs), the pane's
 * markup and the controls that drive it. The rules are pure, so these run
 * without Foundry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CATCH_UP_LIMIT, catchUpPlan, groupStats, matchesSearch, pageDetails, pageMenu, pageStatus,
  pageTrouble, rowAction, rowHasMenu, rowState, sendAgainPlan, stateLabelKey, typeMenu,
} from '../scripts/_page-rows.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const lang = JSON.parse(read('lang/en.json')).CHRONICLE.Dashboard.Pages;

const V1 = '2026-11-19T19:00:00Z';
const V2 = '2026-11-19T19:30:00Z';

test('a page with no journal is only in Chronicle, or an actor', () => {
  assert.equal(pageStatus({ linked: false, updatedAt: V1 }), 'chronicle-only');
  assert.equal(pageStatus({ linked: false, isActor: true, updatedAt: V1 }), 'actor');
});

test('the version the journal holds decides whether Chronicle changed', () => {
  assert.equal(pageStatus({ linked: true, recordedVersion: V1, updatedAt: V1 }), 'synced');
  assert.equal(pageStatus({ linked: true, recordedVersion: V1, updatedAt: V2 }), 'modified');
  // The journal is ahead of a list read earlier: nothing to fetch.
  assert.equal(pageStatus({ linked: true, recordedVersion: V2, updatedAt: V1 }), 'synced');
  // Chronicle's versions are whole seconds; a finer stamp of the same second is the same version.
  assert.equal(pageStatus({ linked: true, recordedVersion: V1, updatedAt: '2026-11-19T19:00:00.640Z' }), 'synced');
  // This computer's clock is not consulted while a version is recorded.
  assert.equal(pageStatus({ linked: true, recordedVersion: V1, lastSync: '2020-01-01T00:00:00Z', updatedAt: V1 }), 'synced');
});

test('a journal from before versions were recorded falls back to its last sync, with slack', () => {
  assert.equal(pageStatus({ linked: true, lastSync: '2026-11-19T19:00:03Z', updatedAt: '2026-11-19T19:00:06Z' }), 'synced');
  assert.equal(pageStatus({ linked: true, lastSync: '2026-11-19T19:00:03Z', updatedAt: V2 }), 'modified');
  assert.equal(pageStatus({ linked: true, updatedAt: V2 }), 'synced');
  assert.equal(pageStatus({ linked: true, recordedVersion: V1, updatedAt: 'not a date' }), 'synced');
});

test('a queued change is waiting, and only for its own page', () => {
  const waiting = [{ method: 'PUT', path: '/entities/12' }];
  assert.deepEqual(pageTrouble({ entityId: '12', waiting }), { kind: 'waiting' });
  assert.deepEqual(pageTrouble({ entityId: '12', waiting: [{ method: 'PUT', path: '/entities/12/permissions' }] }), { kind: 'waiting' });
  assert.equal(pageTrouble({ entityId: '1', waiting }), null);
  assert.equal(pageTrouble({ entityId: '120', waiting }), null);
});

test('a failure counts only while nothing has made it good', () => {
  const at = Date.parse('2026-11-19T19:10:00Z');
  const errors = [
    { level: 'warn', method: 'PUT', path: '/entities/7', time: at + 5, message: 'only a warning' },
    { level: 'error', method: 'PUT', path: '/entities/7', time: at, message: 'Network error' },
  ];
  assert.deepEqual(pageTrouble({ entityId: '7', lastSync: V1, errors }),
    { kind: 'failed', direction: 'out', message: 'Network error', at });
  // The journal synced after the failure.
  assert.equal(pageTrouble({ entityId: '7', lastSync: V2, errors }), null);
  // The queued change went through on a later try.
  assert.equal(pageTrouble({ entityId: '7', lastSync: V1, sentAt: at + 1000, errors }), null);
  // A failed fetch is a failure to bring Chronicle's copy in.
  assert.equal(pageTrouble({ entityId: '7', errors: [{ ...errors[1], method: 'GET' }] }).direction, 'in');
  // A fix tried from the list that failed is shown until one works.
  assert.deepEqual(pageTrouble({ entityId: '7', lastSync: V2, local: { message: 'No answer', at: 5 } }),
    { kind: 'failed', direction: 'in', message: 'No answer', at: 5 });
});

test('a row shows one state, and trouble outranks standing', () => {
  assert.equal(rowState('synced'), 'synced');
  assert.equal(rowState('modified'), 'modified');
  assert.equal(rowState('modified', { trouble: { kind: 'waiting' } }), 'waiting');
  assert.equal(rowState('synced', { trouble: { kind: 'failed' } }), 'failed');
  assert.equal(rowState('synced', { excluded: true, trouble: { kind: 'failed' } }), 'off');
  // A page with no journal still offers Bring in, even with sync off for its type.
  assert.equal(rowState('chronicle-only', { excluded: true }), 'chronicle-only');
  assert.equal(rowState('actor', { excluded: true, catchingUp: true }), 'actor');
  assert.equal(rowState('modified', { catchingUp: true }), 'catching-up');
});

test('every state has a word, and every word and menu label exists', () => {
  const states = ['synced', 'modified', 'chronicle-only', 'actor', 'off', 'catching-up', 'waiting', 'failed'];
  for (const state of states) assert.ok(lang[stateLabelKey(state)], `no word for ${state}`);
  for (const state of states) {
    const action = rowAction(state);
    if (action) assert.ok(lang[action.labelKey], `no label ${action.labelKey}`);
  }
  const menus = [
    ...pageMenu({ state: 'synced', isPrivate: false, pageExcluded: false, typeExcluded: false }),
    ...pageMenu({ state: 'off', isPrivate: true, pageExcluded: true, typeExcluded: false }),
    ...typeMenu({ typeExcluded: false, collapsed: false }),
    ...typeMenu({ typeExcluded: true, collapsed: true }),
  ];
  for (const item of menus) assert.ok(lang[item.labelKey], `no label ${item.labelKey}`);
  for (const part of [...groupStats([{ state: 'synced' }, { state: 'chronicle-only' }, { state: 'modified' }, { state: 'failed' }, { state: 'off' }]),
    ...groupStats([{}], { typeExcluded: true }), ...groupStats([{}, {}], { typeExcluded: true })]) {
    assert.ok(lang[part.key], `no words for ${part.key}`);
  }
});

test('a row has at most one button, and only rows with a journal have a menu', () => {
  assert.deepEqual(rowAction('chronicle-only'), { action: 'pull-entity', labelKey: 'BringIn' });
  assert.deepEqual(rowAction('failed'), { action: 'pages-retry', labelKey: 'TryAgain' });
  assert.deepEqual(rowAction('waiting'), { action: 'pages-send-waiting', labelKey: 'SendNow' });
  for (const state of ['synced', 'modified', 'off', 'actor', 'catching-up']) assert.equal(rowAction(state), null);
  assert.equal(rowHasMenu('synced'), true);
  assert.equal(rowHasMenu('failed'), true);
  for (const state of ['chronicle-only', 'actor', 'catching-up']) assert.equal(rowHasMenu(state), false);
});

test('the page menu follows the page', () => {
  const actions = (row) => pageMenu(row).map((item) => item.action);
  assert.deepEqual(actions({ state: 'synced', isPrivate: false, pageExcluded: false, typeExcluded: false }),
    ['pages-sync-one', 'toggle-visibility', 'pages-toggle-sync', 'pages-copy-details']);
  // Sync off: nothing to sync again, and the switch turns it back on.
  const off = pageMenu({ state: 'off', isPrivate: true, pageExcluded: true, typeExcluded: false });
  assert.deepEqual(off.map((item) => item.action), ['toggle-visibility', 'pages-toggle-sync', 'pages-copy-details']);
  assert.deepEqual(off[0], { action: 'toggle-visibility', labelKey: 'MenuShow', data: { isPrivate: 'true' } });
  assert.deepEqual(off[1], { action: 'pages-toggle-sync', labelKey: 'MenuSyncOn', data: { enable: 'true' } });
  // A page whose whole type is off has no switch of its own.
  assert.deepEqual(actions({ state: 'off', isPrivate: false, pageExcluded: false, typeExcluded: true }),
    ['toggle-visibility', 'pages-copy-details']);
});

test('the small print beside a type leaves out what is empty', () => {
  const rows = [{ state: 'synced' }, { state: 'actor' }, { state: 'chronicle-only' }, { state: 'catching-up' }, { state: 'waiting' }, { state: 'failed' }, { state: 'off' }];
  assert.deepEqual(groupStats(rows), [
    { key: 'StatInSync', count: 2 }, { key: 'StatOnlyChronicle', count: 1 }, { key: 'StatChanged', count: 1 },
    { key: 'StatTrouble', count: 2 }, { key: 'StatOff', count: 1 },
  ]);
  assert.deepEqual(groupStats([{ state: 'synced' }]), [{ key: 'StatInSync', count: 1 }]);
  assert.deepEqual(groupStats(rows, { typeExcluded: true }), [{ key: 'StatTypeOff', count: 7 }]);
  assert.deepEqual(groupStats([{ state: 'off' }], { typeExcluded: true }), [{ key: 'StatTypeOffOne', count: 1 }]);
});

test('the list catches up pages Chronicle changed, once each and a few at a time', () => {
  const row = (id, status, state, trouble = null) => ({ id, status, state, trouble });
  const rows = [
    row('a', 'modified', 'modified'),
    row('b', 'synced', 'synced'),
    row('c', 'modified', 'off'),
    row('d', 'modified', 'waiting', { kind: 'waiting' }),
    row('e', 'modified', 'failed', { kind: 'failed', direction: 'in' }),
    // The GM's own change was never sent: Chronicle's copy must not replace it unasked.
    row('f', 'modified', 'failed', { kind: 'failed', direction: 'out' }),
    row('g', 'chronicle-only', 'chronicle-only'),
    row('h', 'modified', 'modified'),
  ];
  assert.deepEqual(catchUpPlan({ rows, tried: new Set() }), ['a', 'e', 'h']);
  assert.deepEqual(catchUpPlan({ rows, tried: new Set(['a', 'e']) }), ['h']);
  assert.deepEqual(catchUpPlan({ rows, tried: new Set(), limit: 1 }), ['a']);
  const many = Array.from({ length: 60 }, (_, i) => row(`p${i}`, 'modified', 'modified'));
  assert.equal(catchUpPlan({ rows: many, tried: new Set() }).length, CATCH_UP_LIMIT);
});

test('waiting changes are sent again once each, and only while connected', () => {
  const waiting = [{ method: 'PUT', path: '/entities/1' }, { method: 'POST', path: '/maps/2/markers' }];
  assert.deepEqual(sendAgainPlan({ connected: true, waiting, tried: new Set() }), ['PUT /entities/1', 'POST /maps/2/markers']);
  assert.deepEqual(sendAgainPlan({ connected: true, waiting, tried: new Set(['PUT /entities/1']) }), ['POST /maps/2/markers']);
  // The queue drops a change after a few failed tries, so nothing is tried while Chronicle is away.
  assert.deepEqual(sendAgainPlan({ connected: false, waiting, tried: new Set() }), []);
});

test('the search ignores case and outer spaces, and empty matches everything', () => {
  assert.equal(matchesSearch('Old Marrow', ' marr '), true);
  assert.equal(matchesSearch('Old Marrow', 'ford'), false);
  assert.equal(matchesSearch('Old Marrow', ''), true);
  assert.equal(matchesSearch(undefined, 'x'), false);
});

test('copied details name the page and its trouble, and nothing secret', () => {
  const row = {
    id: '88', name: 'Old Marrow', journalId: 'jX', state: 'failed', updatedAt: V2, recordedVersion: V1,
    lastSync: V1, isPrivate: true, pageExcluded: false, typeExcluded: false,
    entry: '<p>The secret text of the page</p>',
  };
  const text = pageDetails({
    row,
    typeName: 'People',
    trouble: { kind: 'failed', direction: 'out', message: 'conflict' },
    versions: { 'Chronicle Sync': '0.9.4', Foundry: '13.351', Empty: '' },
    errors: [
      { timeFormatted: '19:40', method: 'PUT', path: '/entities/88', status: 409, message: 'conflict' },
      { timeFormatted: '19:41', method: 'PUT', path: '/entities/9', status: 500, message: 'another page' },
    ],
  });
  assert.match(text, /^Page: Old Marrow$/m);
  assert.match(text, /^Type: People$/m);
  assert.match(text, /^Chronicle page id: 88$/m);
  assert.match(text, /^Foundry journal id: jX$/m);
  assert.match(text, /^Changed in Chronicle: 2026-11-19T19:30:00Z$/m);
  assert.match(text, /^Version the journal holds: 2026-11-19T19:00:00Z$/m);
  assert.match(text, /^Hidden from players: yes$/m);
  assert.match(text, /^Trouble: conflict$/m);
  assert.match(text, /^Chronicle Sync: 0\.9\.4$/m);
  assert.match(text, /^- 19:40 PUT \/entities\/88 \(409\): conflict$/m);
  assert.doesNotMatch(text, /another page|secret text|Empty/);
});

// ---- the pane and its wiring ----

const hbs = read('templates/sync-dashboard.hbs');
const pane = hbs.slice(hbs.indexOf('data-subpane="linked:pages"'), hbs.indexOf('data-subpane="linked:shops"'));
const dash = read('scripts/sync-dashboard.mjs');
const list = read('scripts/pages-list.mjs');

test('the list is quiet: a search box, words, small-caps headings and one button a row', () => {
  assert.match(pane, /<input type="search" name="pagesSearch"[^>]*data-pages-search/);
  // The list's commands are quiet words, not bordered buttons.
  assert.doesNotMatch(pane, /dashboard-btn/);
  for (const action of ['pull-all', 'push-all', 'resync-all-journals', 'create-entity-type', 'pages-select']) {
    assert.match(pane, new RegExp(`class="cs-quiet[^"]*" data-action="${action}"`), `${action} is a quiet word`);
  }
  // A heading folds its rows and says so to a screen reader.
  assert.match(pane, /class="cs-pages-fold" data-action="pages-fold"[^>]*aria-expanded=/);
  // A row: state word, at most one button, and a labelled "more" button.
  assert.match(pane, /class="cs-page-state"[^>]*>\{\{stateLabel\}\}/);
  assert.match(pane, /\{\{#if action\}\}\s*<button type="button" class="cs-page-btn" data-action="\{\{action\.action\}\}"/);
  assert.match(pane, /data-action="pages-menu"[^>]*\s+aria-haspopup="menu"[^>]*aria-label="\{\{menuLabel\}\}"/);
  // The lock shows on hidden pages only, and is named.
  assert.match(pane, /\{\{#if isPrivate\}\}\s*<i class="fa-solid fa-lock cs-page-lock" role="img"[^>]*aria-label=/);
  // No inline colours: the tokens decide.
  assert.doesNotMatch(pane, /style="/);
});

test('rows the search hides stay in the page, so the box filters without a redraw', () => {
  assert.match(pane, /data-page-row data-page-id="\{\{id\}\}" data-page-name="\{\{name\}\}" \{\{#if hidden\}\}hidden\{\{\/if\}\}/);
  assert.match(pane, /data-pages-nomatch \{\{#unless pages\.noMatch\}\}hidden\{\{\/unless\}\}/);
  assert.match(list, /search\.addEventListener\('input', \(\) => \{\s*host\.setSearch\(search\.value\);\s*applyPagesSearch\(root, search\.value\);/);
  assert.doesNotMatch(list, /\.render\(/);
  // The flex rows would ignore the hidden attribute without this.
  assert.match(read('styles/chronicle-sync.css'), /\.cs-page-row\[hidden\][^{]*\{ display: none; \}/);
});

test('a list that stops short says so', () => {
  assert.match(pane, /\{\{#if pages\.truncatedText\}\}\s*<p class="cs-pages-note">\{\{pages\.truncatedText\}\}<\/p>/);
  assert.match(dash, /truncatedText: this\._cache\.entitiesTruncated/);
});

test('every list action in the markup and the menus is one the window handles', () => {
  const inPane = [...pane.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
  const inMenus = [
    ...pageMenu({ state: 'synced', isPrivate: false, pageExcluded: false, typeExcluded: false }),
    ...typeMenu({ typeExcluded: false, collapsed: false }),
    rowAction('chronicle-only'), rowAction('failed'), rowAction('waiting'),
  ].map((item) => item.action);
  for (const action of new Set([...inPane, ...inMenus])) {
    assert.match(dash, new RegExp(`\\n\\s+'?${action}'?: SyncDashboard\\.#on`), `no handler for ${action}`);
  }
});

test('the menu is built without innerHTML and closes on Escape', () => {
  assert.doesNotMatch(list, /innerHTML|insertAdjacentHTML/);
  assert.match(list, /setAttribute\('role', 'menu'\)/);
  assert.match(list, /event\.key === 'Escape'/);
  assert.match(list, /button\.textContent = item\.label/);
});

test('the list fixes by itself only within bounds', () => {
  // Chronicle's copy is applied by the path a live change takes.
  assert.match(dash, /await journalSync\._onEntityUpdated\(entity\);/);
  // Nothing is tried while Chronicle is away, and one pass is made per loaded list.
  const fix = dash.slice(dash.indexOf('  _fixPagesByItself() {'), dash.indexOf('  async _retryPage('));
  assert.match(fix, /if \(this\.api\?\.state !== 'connected'\) return;/);
  assert.match(fix, /this\._catchUpList === this\._cache\.entities\) return;/);
  assert.match(fix, /getSetting\('syncJournals'\)/);
  assert.doesNotMatch(fix, /setInterval|setTimeout/);
  // A change of the GM's own that was not sent goes back through the push path.
  assert.match(dash, /trouble\?\.direction === 'out' && journal && journalSync\) \{[\s\S]*?await journalSync\._pushJournalUpdate\(journal, entityId\);/);
});

test('a queued write that goes through later is remembered, so its old error stops counting', () => {
  const api = read('scripts/api-client.mjs');
  assert.equal((api.match(/this\._replayedAt\.set\(`\$\{item\.method\} \$\{item\.path\}`, Date\.now\(\)\);/g) ?? []).length, 2);
  assert.match(api, /getReplayedAt\(method, path\) \{\s*return this\._replayedAt\.get\(`\$\{method\} \$\{path\}`\) \?\? 0;/);
  assert.match(dash, /sentAt: this\.api\.getReplayedAt\?\.\('PUT', `\/entities\/\$\{entity\.id\}`\) \?\? 0,/);
});
