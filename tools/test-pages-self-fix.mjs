/**
 * The Pages list's fixes, run on the dashboard itself with Foundry stubbed:
 * what it brings up to date, brings in and sends unasked, what it leaves
 * alone, and that a failure is kept for the row instead of tried again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { syncJournals: true, firstRunPending: false, conflictResolution: 'chronicle' };
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
// The Link question: each test says what the GM answers.
let answer = true;
const asked = [];
globalThis.foundry.applications.api.DialogV2 = { confirm: async (opts) => { asked.push(opts.content); return answer; } };
globalThis.ui = globalThis.ui || { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game = globalThis.game || {
  settings: { get: (_scope, key) => settings[key] ?? '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
  user: { id: 'u1', isGM: true },
  journal: { find: () => null, get: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };
globalThis.CONST = globalThis.CONST || { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2, NONE: 0 } };
globalThis.Actor = globalThis.Actor || class {};

const { SyncDashboard } = await import('../scripts/sync-dashboard.mjs');

class JournalSync {
  constructor() { this.applied = []; this.pushed = []; this.sent = []; this.linked = []; }
  async _sendJournalAsPage(journal) {
    if (journal.id === 'bad-send') throw new Error('Chronicle answered 500');
    if (journal.id === 'no-types') return null;
    // A page was made but its text did not follow: the journal is linked all the same.
    journal.flags.entityId = `page-of-${journal.id}`;
    if (journal.id === 'half-sent') throw new Error('the text did not go up');
    this.sent.push(journal.id);
    return { entityId: journal.flags.entityId };
  }
  async _linkJournalToPage(journal, entity, keep) { this.linked.push([journal.id, entity.id, keep]); }
  async _onEntityUpdated(entity) {
    if (entity.id === 'bad-apply') throw new Error('could not write the journal');
    this.applied.push(entity.id);
  }
  async _pushJournalUpdate(journal, entityId) { this.pushed.push(entityId); }
}

const journalDoc = (id, flags = {}) => ({ id, name: id, flags, getFlag(_scope, key) { return this.flags[key]; }, pages: [] });

function makeDash({ state = 'connected', rows = [], journals = [], waiting = [], failGet = new Set(), truncated = false } = {}) {
  const docs = new Map(journals.map((j) => [j.id, journalDoc(j.id)]));
  game.journal.get = (id) => docs.get(id) ?? null;
  const journalSync = new JournalSync();
  const api = {
    state,
    gets: [],
    sends: 0,
    async get(path) {
      this.gets.push(path);
      const id = path.split('/').pop();
      if (failGet.has(id)) throw new Error('Chronicle said no');
      return { id };
    },
    getRetryQueue: () => waiting,
    async processRetryQueue() { this.sends += 1; },
  };
  const list = [];
  const dash = Object.assign(Object.create(SyncDashboard.prototype), {
    _syncManager: { api, _modules: [journalSync], logActivity: () => {} },
    _cache: { entities: list, entitiesTruncated: truncated },
    _pageRows: new Map(rows.map((r) => [r.id, r])),
    _journalRows: new Map(journals.map((j) => [j.id, j])),
    _catchingUp: new Set(),
    _catchUpTried: new Set(),
    _catchUpRunning: false,
    _pageFailures: new Map(),
    _sendingJournals: new Set(),
    _sendTried: new Set(),
    _journalFailures: new Map(),
    _sendAgainTried: new Set(),
    _healthSending: false,
    rendered: true,
    element: null,
    renders: 0,
    render() { this.renders += 1; },
  });
  return { dash, api, journalSync, docs };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const changed = (id, extra = {}) => ({ id, journalId: `j-${id}`, status: 'modified', state: 'modified', trouble: null, ...extra });
const lone = (id, state = 'chronicle-only') => ({ id, journalId: null, status: 'chronicle-only', state });

test('pages Chronicle changed are fetched and applied by the live-change path, once', async () => {
  const { dash, api, journalSync } = makeDash({ rows: [changed('a'), { id: 'b', status: 'synced', state: 'synced' }, changed('c', { state: 'off' })] });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/a']);
  assert.deepEqual(journalSync.applied, ['a']);
  assert.equal(dash.renders, 1, 'one redraw at the end of the pass');
  // What was tried is not tried again, so a redraw cannot start a loop.
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/a']);
  assert.equal(dash.renders, 1);
});

test('a page with no journal is brought in and a journal with no page is sent, once each', async () => {
  const { dash, api, journalSync } = makeDash({
    rows: [lone('p'), changed('a')],
    journals: [{ id: 'j1', state: 'foundry-only' }, { id: 'j2', state: 'foundry-only' }],
  });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/a', '/entities/p'], 'changed pages first, then the missing ones');
  assert.deepEqual(journalSync.applied, ['a', 'p']);
  assert.deepEqual(journalSync.sent, ['j1', 'j2']);
  assert.equal(dash.renders, 1, 'one redraw for the whole pass');
  assert.equal(dash._cache.entities, null, 'Chronicle has new pages, so the list is read again');
  assert.equal(dash._sendingJournals.size, 0);
  dash._cache.entities = [];
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(journalSync.sent, ['j1', 'j2']);
  assert.deepEqual(api.gets, ['/entities/a', '/entities/p']);
});

test('what the list holds back is left for the GM', async () => {
  const { dash, api, journalSync } = makeDash({
    rows: [lone('off', 'chronicle-only-off'), lone('clash', 'clash'), lone('hero', 'character'), lone('failed', 'failed')],
    journals: ['set-aside', 'off', 'clash', 'failed', 'sending'].map((state) => ({ id: state, state })),
  });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, []);
  assert.deepEqual(journalSync.sent, []);
  assert.equal(dash.renders, 0);
});

test('nothing is brought in or sent before the first-run setup is done, and a list cut short sends nothing', async () => {
  settings.firstRunPending = true;
  const first = makeDash({ rows: [lone('p')], journals: [{ id: 'j1', state: 'foundry-only' }] });
  first.dash._fixPagesByItself();
  await settle();
  settings.firstRunPending = false;
  assert.deepEqual(first.api.gets, []);
  assert.deepEqual(first.journalSync.sent, []);

  const cut = makeDash({ rows: [lone('p')], journals: [{ id: 'j1', state: 'foundry-only' }], truncated: true });
  cut.dash._fixPagesByItself();
  await settle();
  assert.deepEqual(cut.api.gets, ['/entities/p'], 'bringing in needs no complete list');
  assert.deepEqual(cut.journalSync.sent, []);
});

test('a send that fails is kept for its row, and one that half worked is its page\'s to show', async () => {
  const { dash, journalSync, docs } = makeDash({ journals: ['bad-send', 'no-types', 'half-sent', 'fine'].map((id) => ({ id, state: 'foundry-only' })) });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(journalSync.sent, ['fine']);
  assert.equal(dash._journalFailures.get('bad-send').message, 'Chronicle answered 500');
  assert.equal(dash._journalFailures.get('no-types').message, 'CHRONICLE.Dashboard.Pages.NoPageTypes');
  assert.equal(dash._journalFailures.has('half-sent'), false);
  assert.equal(docs.get('half-sent').flags.entityId, 'page-of-half-sent');
  // Not tried again by itself; Send by hand still works and clears the failure.
  dash._cache.entities = [];
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(journalSync.sent, ['fine']);
  docs.get('bad-send').id = 'mended';
  await dash._onPushJournal('bad-send');
  assert.deepEqual(journalSync.sent, ['fine', 'mended']);
  assert.equal(dash._journalFailures.has('bad-send'), false);
});

test('Link asks first, and keeps the text the conflict setting picks', async () => {
  const { dash, journalSync, api } = makeDash({ rows: [lone('p9', 'clash')], journals: [{ id: 'j1', state: 'clash', clashEntityId: 'p9' }] });
  answer = false;
  await dash._linkPair('p9', 'j1');
  assert.deepEqual(journalSync.linked, [], 'No leaves both as they were');
  assert.match(asked.at(-1), /LinkKeepChronicle/);
  answer = true;
  settings.conflictResolution = 'foundry';
  await dash._linkPair('p9', 'j1');
  assert.match(asked.at(-1), /LinkKeepFoundry/);
  assert.deepEqual(journalSync.linked, [['j1', 'p9', 'foundry']]);
  assert.deepEqual(api.gets, ['/entities/p9', '/entities/p9']);
  settings.conflictResolution = 'chronicle';
});

test('nothing is fixed unasked while Chronicle is away or page sync is off', async () => {
  const away = makeDash({ state: 'reconnecting', rows: [changed('a')], waiting: [{ method: 'PUT', path: '/entities/9' }] });
  away.dash._fixPagesByItself();
  await settle();
  assert.deepEqual(away.api.gets, []);
  assert.equal(away.api.sends, 0);

  settings.syncJournals = false;
  const off = makeDash({ rows: [changed('a')] });
  off.dash._fixPagesByItself();
  await settle();
  settings.syncJournals = true;
  assert.deepEqual(off.api.gets, []);
});

test('a page whose own change was never sent is not overwritten by a catch-up', async () => {
  const { dash, api } = makeDash({ rows: [changed('mine', { state: 'failed', trouble: { kind: 'failed', direction: 'out' } })] });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, []);
});

test('a catch-up that fails is kept for its row and not tried again by itself', async () => {
  const { dash, api } = makeDash({ rows: [changed('x'), changed('bad-apply')], failGet: new Set(['x']) });
  dash._fixPagesByItself();
  await settle();
  assert.equal(dash._pageFailures.get('x').message, 'Chronicle said no');
  assert.equal(dash._pageFailures.get('bad-apply').message, 'could not write the journal');
  assert.equal(dash._catchingUp.size, 0);
  // A freshly loaded list: both were tried already.
  dash._cache.entities = [];
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/x', '/entities/bad-apply']);
  // Asking again by hand works, and a success clears the failure.
  dash._syncManager.api.get = async (path) => ({ id: path.split('/').pop() });
  await dash._runCatchUp(['x']);
  assert.equal(dash._pageFailures.has('x'), false);
});

test('waiting changes are sent again once by the list, then only when asked', async () => {
  const waiting = [{ method: 'PUT', path: '/entities/9' }];
  const { dash, api } = makeDash({ waiting });
  dash._fixPagesByItself();
  await settle();
  assert.equal(api.sends, 1);
  dash._fixPagesByItself();
  await settle();
  assert.equal(api.sends, 1, 'the queue drops a change after a few failed tries, so the list tries once');
  await dash._sendWaiting();
  assert.equal(api.sends, 2, 'Send now still works');
});

test('Try again sends an unsent change again, and fetches anything else', async () => {
  const journal = { id: 'j1' };
  const original = game.journal.get;
  const { dash, api, journalSync } = makeDash({ rows: [
    { id: 'out', journalId: 'j1', status: 'synced', state: 'failed', trouble: { kind: 'failed', direction: 'out' } },
    { id: 'in', journalId: 'j1', status: 'modified', state: 'failed', trouble: { kind: 'failed', direction: 'in' } },
  ] });
  game.journal.get = (id) => (id === 'j1' ? journal : null);
  await dash._retryPage('out');
  assert.deepEqual(journalSync.pushed, ['out']);
  assert.deepEqual(api.gets, []);
  await dash._retryPage('in');
  assert.deepEqual(api.gets, ['/entities/in']);
  assert.deepEqual(journalSync.applied, ['in']);
  game.journal.get = original;
});
