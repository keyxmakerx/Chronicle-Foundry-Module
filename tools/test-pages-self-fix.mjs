/**
 * The Pages list's fixes, run on the dashboard itself with Foundry stubbed:
 * what it brings up to date and sends again unasked, what it leaves alone,
 * and that a failure is kept for the row instead of tried again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { syncJournals: true };
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
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
  constructor() { this.applied = []; this.pushed = []; }
  async _onEntityUpdated(entity) {
    if (entity.id === 'bad-apply') throw new Error('could not write the journal');
    this.applied.push(entity.id);
  }
  async _pushJournalUpdate(journal, entityId) { this.pushed.push(entityId); }
}

function makeDash({ state = 'connected', rows = [], waiting = [], failGet = new Set() } = {}) {
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
    _cache: { entities: list },
    _pageRows: new Map(rows.map((r) => [r.id, r])),
    _catchingUp: new Set(),
    _catchUpTried: new Set(),
    _catchUpList: null,
    _catchUpRunning: false,
    _pageFailures: new Map(),
    _sendAgainTried: new Set(),
    _healthSending: false,
    rendered: true,
    element: null,
    renders: 0,
    render() { this.renders += 1; },
  });
  return { dash, api, journalSync };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const changed = (id, extra = {}) => ({ id, status: 'modified', state: 'modified', trouble: null, ...extra });

test('pages Chronicle changed are fetched and applied by the live-change path, once', async () => {
  const { dash, api, journalSync } = makeDash({ rows: [changed('a'), { id: 'b', status: 'synced', state: 'synced' }, changed('c', { state: 'off' })] });
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/a']);
  assert.deepEqual(journalSync.applied, ['a']);
  assert.equal(dash.renders, 1, 'one redraw at the end of the pass');
  // The same loaded list is not looked at twice, so a redraw cannot start a loop.
  dash._fixPagesByItself();
  await settle();
  assert.deepEqual(api.gets, ['/entities/a']);
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
  game.journal.get = (id) => (id === 'j1' ? journal : null);
  const { dash, api, journalSync } = makeDash({ rows: [
    { id: 'out', journalId: 'j1', status: 'synced', state: 'failed', trouble: { kind: 'failed', direction: 'out' } },
    { id: 'in', journalId: 'j1', status: 'modified', state: 'failed', trouble: { kind: 'failed', direction: 'in' } },
  ] });
  await dash._retryPage('out');
  assert.deepEqual(journalSync.pushed, ['out']);
  assert.deepEqual(api.gets, []);
  await dash._retryPage('in');
  assert.deepEqual(api.gets, ['/entities/in']);
  assert.deepEqual(journalSync.applied, ['in']);
  game.journal.get = original;
});
