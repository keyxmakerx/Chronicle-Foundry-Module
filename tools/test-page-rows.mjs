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
  CATCH_UP_LIMIT, bringInPlan, catchUpPlan, groupStats, journalAction, journalDetails, journalLabelKey,
  journalMenu, journalState, linkKeeps, matchesSearch, nameClashes, nameKey, pageDetails, pageMenu,
  pageStatus, pageTrouble, rowAction, rowHasMenu, rowState, sendAgainPlan, sendPlan, stateLabelKey, typeMenu,
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
  assert.equal(rowState('actor', { excluded: true, catchingUp: true }), 'actor');
  assert.equal(rowState('modified', { catchingUp: true }), 'catching-up');
});

test('a page with no journal says why it is not brought in by itself', () => {
  assert.equal(rowState('chronicle-only'), 'chronicle-only');
  assert.equal(rowState('chronicle-only', { catchingUp: true }), 'bringing-in');
  assert.equal(rowState('chronicle-only', { excluded: true }), 'chronicle-only-off');
  assert.equal(rowState('chronicle-only', { clash: true }), 'clash');
  assert.equal(rowState('chronicle-only', { character: true }), 'character');
  assert.equal(rowState('chronicle-only', { trouble: { kind: 'failed' } }), 'failed');
  // Sync off outranks a clash: the page is not coming in either way.
  assert.equal(rowState('chronicle-only', { excluded: true, clash: true }), 'chronicle-only-off');
  // Only the plain state is brought in, each page once, within the limit.
  const rows = ['chronicle-only', 'chronicle-only-off', 'clash', 'character', 'failed', 'bringing-in', 'chronicle-only']
    .map((state, i) => ({ id: String(i), state }));
  assert.deepEqual(bringInPlan({ rows, tried: new Set() }), ['0', '6']);
  assert.deepEqual(bringInPlan({ rows, tried: new Set(['0']) }), ['6']);
  assert.deepEqual(bringInPlan({ rows, tried: new Set(), limit: 1 }), ['0']);
  assert.deepEqual(bringInPlan({ rows, tried: new Set(), limit: 0 }), []);
});

test('a page and a journal of one name are held, and only a clean pair can be linked', () => {
  assert.equal(nameKey('  The  Brass\tLantern '), 'the brass lantern');
  const page = (id, name, extra = {}) => ({ id, name, status: 'chronicle-only', ...extra });
  // One unlinked page, one unlinked journal: a pair.
  let got = nameClashes({ rows: [page('p1', 'Brass Lantern'), page('p2', 'Other')], journals: [{ id: 'j1', name: 'brass  lantern' }, { id: 'j2', name: 'Loose notes' }] });
  assert.deepEqual([...got.pages], [['p1', 'j1']]);
  assert.deepEqual([...got.journals], [['j1', { entityId: 'p1' }]]);
  // The page already has a journal: the second journal is held, with no pair.
  got = nameClashes({ rows: [{ id: 'p1', name: 'Low Harbor', status: 'synced' }], journals: [{ id: 'j1', name: 'Low Harbor' }] });
  assert.deepEqual([...got.journals], [['j1', { entityId: null }]]);
  assert.equal(got.pages.size, 0);
  // A journal linked since the list was read counts too.
  got = nameClashes({ rows: [], journals: [{ id: 'j1', name: 'Low Harbor' }], linkedNames: ['low harbor'] });
  assert.deepEqual([...got.journals], [['j1', { entityId: null }]]);
  // Two journals of the name, or a page with sync off: held, never paired.
  got = nameClashes({ rows: [page('p1', 'Tavern')], journals: [{ id: 'j1', name: 'Tavern' }, { id: 'j2', name: 'Tavern' }] });
  assert.deepEqual([...got.pages], [['p1', null]]);
  assert.deepEqual([...got.journals.values()], [{ entityId: null }, { entityId: null }]);
  got = nameClashes({ rows: [page('p1', 'Tavern', { excluded: true })], journals: [{ id: 'j1', name: 'Tavern' }] });
  assert.deepEqual([...got.journals], [['j1', { entityId: null }]]);
  // Two journals of one name with nothing of that name in Chronicle are not a clash.
  got = nameClashes({ rows: [page('p1', 'Other')], journals: [{ id: 'j1', name: 'Notes' }, { id: 'j2', name: 'Notes' }] });
  assert.equal(got.journals.size, 0);
  assert.deepEqual(rowAction('clash', { paired: true }), { action: 'pages-link', labelKey: 'Link' });
  assert.deepEqual(rowAction('clash'), { action: 'pull-entity', labelKey: 'BringIn' });
});

test('a journal with no page is sent by itself only in its plain state', () => {
  assert.equal(journalState(), 'foundry-only');
  assert.equal(journalState({ setAside: true, clash: {}, failure: {} }), 'set-aside');
  assert.equal(journalState({ keepLocal: true, clash: {} }), 'off');
  assert.equal(journalState({ clash: { entityId: null }, failure: {} }), 'clash');
  assert.equal(journalState({ failure: { message: 'x' } }), 'failed');
  assert.equal(journalState({ sending: true, setAside: true }), 'sending');
  const journals = ['foundry-only', 'set-aside', 'off', 'clash', 'failed', 'sending', 'foundry-only'].map((state, i) => ({ id: `j${i}`, state }));
  assert.deepEqual(sendPlan({ journals, tried: new Set() }), ['j0', 'j6']);
  assert.deepEqual(sendPlan({ journals, tried: new Set(['j0']) }), ['j6']);
  assert.deepEqual(sendPlan({ journals, tried: new Set(), limit: 1 }), ['j0']);
  // The one button, and the menu.
  assert.deepEqual(journalAction('foundry-only'), { action: 'push-journal', labelKey: 'Send' });
  assert.deepEqual(journalAction('set-aside'), { action: 'push-journal', labelKey: 'Send' });
  assert.deepEqual(journalAction('failed'), { action: 'push-journal', labelKey: 'TryAgain' });
  assert.deepEqual(journalAction('clash', { paired: true }), { action: 'pages-link', labelKey: 'Link' });
  assert.deepEqual(journalAction('clash'), { action: 'push-journal', labelKey: 'Send' });
  assert.equal(journalAction('off'), null);
  assert.equal(journalAction('sending'), null);
  const actions = (row) => journalMenu(row).map((item) => item.action);
  assert.deepEqual(actions({ state: 'foundry-only' }), ['pages-journal-sync', 'pages-copy-journal']);
  assert.deepEqual(actions({ state: 'clash', paired: true }), ['push-journal', 'pages-journal-sync', 'pages-copy-journal']);
  assert.deepEqual(actions({ state: 'clash' }), ['pages-journal-sync', 'pages-copy-journal']);
  assert.deepEqual(actions({ state: 'set-aside' }), ['pages-copy-journal']);
  assert.deepEqual(journalMenu({ state: 'off', keepLocal: true })[0], { action: 'pages-journal-sync', labelKey: 'MenuJournalOn', data: { enable: 'true' } });
  for (const state of ['foundry-only', 'set-aside', 'off', 'clash', 'failed', 'sending']) assert.ok(lang[journalLabelKey(state)], `no word for ${state}`);
  for (const item of [...journalMenu({ state: 'clash', paired: true }), ...journalMenu({ state: 'off', keepLocal: true }), journalAction('failed'), journalAction('clash', { paired: true }), journalAction('foundry-only')]) {
    assert.ok(lang[item.labelKey], `no label ${item.labelKey}`);
  }
});

test('linking keeps the text the conflict setting picks', () => {
  const page = '2026-11-19T19:00:00Z';
  assert.equal(linkKeeps({ strategy: 'chronicle', journalChangedAt: Date.parse(page) + 9e6, pageUpdatedAt: page }), 'chronicle');
  assert.equal(linkKeeps({ strategy: 'foundry', pageUpdatedAt: page }), 'foundry');
  assert.equal(linkKeeps({ strategy: 'newest', journalChangedAt: Date.parse(page) + 1, pageUpdatedAt: page }), 'foundry');
  assert.equal(linkKeeps({ strategy: 'newest', journalChangedAt: Date.parse(page) - 1, pageUpdatedAt: page }), 'chronicle');
  // When it cannot be told which is newer, Chronicle's is kept.
  assert.equal(linkKeeps({ strategy: 'newest', pageUpdatedAt: page }), 'chronicle');
  assert.equal(linkKeeps({ strategy: 'newest', journalChangedAt: 5, pageUpdatedAt: '' }), 'chronicle');
  assert.equal(linkKeeps({ strategy: undefined }), 'chronicle');
});

test('a journal\'s copied details say where it stands and never carry its text', () => {
  const text = journalDetails({
    journal: { id: 'j1', name: 'Loose notes', state: 'clash', pageCount: 2, text: '<p>secret</p>' },
    clash: { entityId: 'p9' },
    failure: { message: 'Chronicle answered 500', at: 1 },
    versions: { Foundry: '14.1', Connection: 'connected', Empty: '' },
  });
  assert.match(text, /Journal: Loose notes/);
  assert.match(text, /Same name as a Chronicle page: yes, page p9, not linked/);
  assert.match(text, /Trouble: Chronicle answered 500/);
  assert.match(text, /Foundry: 14\.1/);
  assert.doesNotMatch(text, /secret|Empty/);
});

test('every state has a word, and every word and menu label exists', () => {
  const states = ['synced', 'modified', 'chronicle-only', 'chronicle-only-off', 'bringing-in', 'clash', 'character', 'actor', 'off', 'catching-up', 'waiting', 'failed'];
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
  for (const part of [...groupStats([{ state: 'synced' }, { state: 'chronicle-only' }, { state: 'bringing-in' }, { state: 'modified' }, { state: 'failed' }, { state: 'off' }]),
    ...groupStats([{}], { typeExcluded: true }), ...groupStats([{}, {}], { typeExcluded: true })]) {
    assert.ok(lang[part.key], `no words for ${part.key}`);
  }
});

test('a row has at most one button, and a row being worked on has no menu', () => {
  assert.deepEqual(rowAction('chronicle-only'), { action: 'pull-entity', labelKey: 'BringIn' });
  assert.deepEqual(rowAction('chronicle-only-off'), { action: 'pull-entity', labelKey: 'BringIn' });
  assert.deepEqual(rowAction('failed'), { action: 'pages-retry', labelKey: 'TryAgain' });
  assert.deepEqual(rowAction('waiting'), { action: 'pages-send-waiting', labelKey: 'SendNow' });
  for (const state of ['synced', 'modified', 'off', 'actor', 'character', 'catching-up', 'bringing-in']) assert.equal(rowAction(state), null);
  for (const state of ['synced', 'failed', 'chronicle-only', 'chronicle-only-off', 'clash']) assert.equal(rowHasMenu(state), true);
  for (const state of ['actor', 'character', 'catching-up', 'bringing-in']) assert.equal(rowHasMenu(state), false);
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
  // A page with no journal has nothing to sync again or hide here: the switch is how it is kept out.
  assert.deepEqual(actions({ state: 'chronicle-only', isPrivate: false, pageExcluded: false, typeExcluded: false, journalId: null }),
    ['pages-toggle-sync', 'pages-copy-details']);
  // A page whose whole type is off has no switch of its own.
  assert.deepEqual(actions({ state: 'off', isPrivate: false, pageExcluded: false, typeExcluded: true }),
    ['toggle-visibility', 'pages-copy-details']);
});

test('the small print beside a type leaves out what is empty', () => {
  const rows = [{ state: 'synced' }, { state: 'actor' }, { state: 'chronicle-only' }, { state: 'clash' }, { state: 'bringing-in' }, { state: 'catching-up' },
    { state: 'waiting' }, { state: 'failed' }, { state: 'off' }, { state: 'chronicle-only-off' }];
  assert.deepEqual(groupStats(rows), [
    { key: 'StatInSync', count: 2 }, { key: 'StatOnlyChronicle', count: 2 }, { key: 'StatBringingIn', count: 1 }, { key: 'StatChanged', count: 1 },
    { key: 'StatTrouble', count: 2 }, { key: 'StatOff', count: 2 },
  ]);
  assert.deepEqual(groupStats([{ state: 'synced' }]), [{ key: 'StatInSync', count: 1 }]);
  assert.deepEqual(groupStats(rows, { typeExcluded: true }), [{ key: 'StatTypeOff', count: 10 }]);
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
const css = read('styles/chronicle-sync.css');

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
  // A heading keeps its icon, in the heading's own colour; a worded button or menu row has none.
  assert.match(pane, /class="cs-pages-fold"[^>]*>\s*<i class="\{\{typeIcon\}\}" aria-hidden="true"><\/i>/);
  assert.match(pane, /<span class="cs-pages-fold"><i class="fa-solid fa-file-pen" aria-hidden="true"><\/i>/);
  assert.match(css, /\.cs-pages-fold > i \{[^}]*color: inherit/);
  assert.doesNotMatch(pane, /class="cs-(quiet|page-btn)[^"]*"[^>]*>\s*<i /);
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
    rowAction('chronicle-only'), rowAction('failed'), rowAction('waiting'), rowAction('clash', { paired: true }),
    ...journalMenu({ state: 'clash', paired: true }), journalAction('foundry-only'),
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
  // Nothing is tried while Chronicle is away, page sync is off or the first-run setup is still open.
  const fix = dash.slice(dash.indexOf('  _fixPagesByItself() {'), dash.indexOf('  async _sendJournal('));
  assert.match(fix, /if \(this\.api\?\.state !== 'connected'\) return;/);
  assert.match(fix, /if \(this\._catchUpRunning\) return;/);
  assert.match(fix, /getSetting\('syncJournals'\)/);
  assert.match(fix, /if \(getSetting\('firstRunPending'\)\) return;/);
  assert.doesNotMatch(fix, /setInterval|setTimeout/);
  // Everything tried is remembered before the work starts, so a redraw cannot start it twice.
  assert.match(fix, /for \(const id of ids\) this\._catchUpTried\.add\(id\);\s*for \(const id of journals\) this\._sendTried\.add\(id\);\s*this\._catchUpRunning = true;/);
  // A list cut short sends nothing unasked: a page of the same name may lie past the cut.
  assert.match(fix, /const journals = !may\.out \|\| this\._cache\.entitiesTruncated \? \[\] : sendPlan\(/);
  // The direction for pages and "Sync changes as they happen" are respected.
  assert.match(fix, /const rows = may\.in \? \[\.\.\.this\._pageRows\.values\(\)\] : \[\];/);
  // One way to make a page from a journal, for the list and for a new journal alike.
  assert.match(dash, /await journalSync\._sendJournalAsPage\(journal\);/);
  assert.doesNotMatch(dash, /entity_type_id: 0/);
  assert.equal((read('scripts/journal-sync.mjs').match(/this\._api\.post\('\/entities'/g) ?? []).length, 1);
  // A change of the GM's own that was not sent goes back through the push path.
  assert.match(dash, /trouble\?\.direction === 'out' && journal && journalSync\) \{[\s\S]*?await journalSync\._pushJournalUpdate\(journal, entityId\);/);
});

test('a queued write that goes through later is remembered, so its old error stops counting', () => {
  const api = read('scripts/api-client.mjs');
  assert.equal((api.match(/this\._replayedAt\.set\(`\$\{item\.method\} \$\{item\.path\}`, Date\.now\(\)\);/g) ?? []).length, 2);
  assert.match(api, /getReplayedAt\(method, path\) \{\s*return this\._replayedAt\.get\(`\$\{method\} \$\{path\}`\) \?\? 0;/);
  assert.match(dash, /sentAt: this\.api\.getReplayedAt\?\.\('PUT', `\/entities\/\$\{entity\.id\}`\) \?\? 0,/);
});
