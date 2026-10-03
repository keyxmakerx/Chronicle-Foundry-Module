#!/usr/bin/env node
/**
 * The History tab: rows drawn from GET /sync/history (escaping, day
 * headings, failures and steps), the query it sends, and SyncManager adding
 * a row for each change Chronicle sends once the modules have applied it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import './_journal-test-env.mjs';
import { buildHistoryRows, historyQuery, dayLabel, duration, toDom, textOf } from '../scripts/_history-view.mjs';

// Serialize node descriptions the way a browser would show them, escaping
// text, so the assertions read like markup.
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (nodes) => [].concat(nodes).map((n) => (n.tag
  ? `<${n.tag}${n.cls ? ` class="${n.cls}"` : ''}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${html(n.children)}</${n.tag}>`
  : esc(n.text))).join('');
const renderHistoryRows = (events, opts) => html(buildHistoryRows(events, opts));

const { SyncManager } = await import('../scripts/sync-manager.mjs');

const now = new Date(2026, 9, 3, 20, 0, 0);
const at = (h, m, dayOffset = 0) => new Date(2026, 9, 3 + dayOffset, h, m, 7, 114).toISOString();

test('rows: day headings, names escaped, failures and steps shown', () => {
  const html = renderHistoryRows([
    { id: 9, at: at(19, 42), direction: 'to_chronicle', reportedBy: 'chronicle', kind: 'page', name: '<b>Port</b>', action: 'page updated', who: 'Ren', call: 'PUT /entities/:entityID', status: '200', ok: true, durationMs: 38 },
    { id: 8, at: at(19, 41), direction: 'link', reportedBy: 'client', kind: 'sync', name: '', action: 'catch-up', call: 'foundry connect', status: 'ok', ok: true, durationMs: 1500, children: [
      { id: 10, at: at(19, 41), direction: 'to_foundry', kind: 'page', name: 'Bell', action: 'page updated', status: 'failed', ok: false, message: 'folder <missing>', durationMs: 4 },
    ] },
    { id: 7, at: at(21, 0, -1), direction: 'to_foundry', kind: 'calendar', name: '', action: 'date moved', status: 'ok', ok: true, durationMs: 12 },
  ], { now });
  assert.match(html, /<div class="sh-day">Today<\/div>/);
  assert.match(html, /<div class="sh-day">Yesterday<\/div>/);
  assert.match(html, /&lt;b&gt;Port&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>Port/);
  assert.match(html, /page updated · Ren/);
  assert.match(html, /19:42:07\.114/);
  assert.match(html, /class="sh-row sh-kid sh-fail"/);
  assert.match(html, /folder &lt;missing&gt;/);
  assert.match(html, /1\.50 s/);
  assert.match(html, />Calendar </);
  assert.match(html, /<dt>Recorded by<\/dt><dd>Foundry<\/dd>/);
});

test('empty list says why', () => {
  assert.match(renderHistoryRows([], { now }), /Nothing has synced yet/);
  assert.match(renderHistoryRows([], { filtered: true, now }), /Nothing matches/);
});

test('helpers', () => {
  assert.equal(dayLabel(new Date(2026, 8, 30), now), 'Wed 30 Sep');
  assert.equal(dayLabel(new Date(2025, 8, 30), now), 'Tue 30 Sep 2025');
  assert.equal(duration(999), '999 ms');
});

test('Chronicle text only ever becomes text nodes', () => {
  const made = [];
  const doc = {
    createDocumentFragment: () => ({ kids: [], appendChild(c) { this.kids.push(c); return c; } }),
    createTextNode: (t) => { made.push(['text', t]); return { t }; },
    createElement: (tag) => {
      made.push(['el', tag]);
      return { tag, kids: [], setAttribute() {}, appendChild(c) { this.kids.push(c); return c; },
        set innerHTML(_) { throw new Error('innerHTML used'); } };
    },
  };
  const nodes = buildHistoryRows([{ id: 1, at: at(10, 0), direction: 'to_foundry', name: '<img src=x onerror=alert(1)>', action: 'page updated', status: 'ok', ok: true, durationMs: 1 }], { now });
  toDom(nodes, doc);
  assert.ok(made.some(([k, t]) => k === 'text' && t.startsWith('<img src=x')), 'name stayed text');
  assert.ok(!made.some(([k, t]) => k === 'el' && t === 'img'), 'no element made from the name');
  assert.match(textOf(nodes), /<img src=x onerror=alert\(1\)> page updated/);
});

test('query carries the filters and the page cursor', () => {
  assert.equal(historyQuery({}), '/sync/history?limit=50');
  assert.equal(historyQuery({ q: ' Ren ', direction: 'to_foundry', failed: true }, 41),
    '/sync/history?limit=50&before=41&direction=to_foundry&failed=1&q=Ren');
});

test('SyncManager adds a row once modules applied a change, skipping echoes', async () => {
  const sm = new SyncManager();
  const added = [];
  sm._history.add = (ev) => added.push(ev);
  sm._modules = [
    { onMessage: async () => {} },
    { onMessage: async (m) => { if (m.resourceId === 'bad') throw new Error('folder missing'); } },
  ];
  sm._history.noteWrite('/entities/mine-1');
  const origError = console.error;
  console.error = () => {};
  try {
    await sm._recordApplied({ type: 'entity.updated', resourceId: 'e1', payload: { name: 'Bell' } }, Date.now(), sm._modules.map((m) => m.onMessage({ resourceId: 'e1' })));
    await sm._recordApplied({ type: 'entity.updated', resourceId: 'bad' }, Date.now(), sm._modules.map((m) => m.onMessage({ resourceId: 'bad' })));
    await sm._recordApplied({ type: 'entity.updated', resourceId: 'mine-1' }, Date.now(), []);
    await sm._recordApplied({ type: 'token.updated', resourceId: 't' }, Date.now(), []);
  } finally {
    console.error = origError;
  }
  assert.equal(added.length, 2);
  assert.deepEqual([added[0].direction, added[0].name, added[0].ok, added[0].call], ['to_foundry', 'Bell', true, 'ws entity.updated']);
  assert.equal(added[1].ok, false);
  assert.equal(added[1].message, 'folder missing');
});

test('activity log entries are reported, pushes are not', () => {
  const sm = new SyncManager();
  const added = [];
  sm._history.add = (ev) => { if (ev) added.push(ev); };
  sm.logActivity('push', 'Pushed "A" to Chronicle');
  sm.logActivity('error', 'Initial sync failed: x');
  assert.equal(added.length, 1);
  assert.equal(added[0].ok, false);
  assert.equal(sm.getActivityLog().length, 2);
});
