#!/usr/bin/env node
/** Pins what "At this table" lists (scripts/_table-view.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ONLY_FOUNDRY, RECENT_LIMIT, SET_ASIDE, pushRecent, tableView, tokenPages } from '../scripts/_table-view.mjs';

const J = (id, name, extra = {}) => ({ id, name, category: 'Lore', folder: '', ...extra });
const journals = [
  J('salt', 'Saltreach', { category: 'Locations', entityId: 'e-salt', tags: ['city'] }),
  J('maric', 'Warden Maric Toldt', { category: 'Characters', folder: 'Saltreach', entityId: 'e-maric' }),
  J('stalker', 'Dry-country Stalker', { category: 'Creatures', entityId: 'e-stalker' }),
  J('shop', 'Hessa Ord’s Workshop', { category: 'Shops', entityId: 'e-shop' }),
  J('father', 'The First Father', { folder: 'Gods', entityId: 'e-father' }),
  J('cyril', 'Cyril', { folder: 'Gods', entityId: 'e-cyril' }),
  J('guild1', 'The Adventurer’s Guild', { category: 'Factions', entityId: 'e-g1' }),
  J('guild2', 'The Emerald Way', { category: 'Factions', entityId: 'e-g2' }),
  J('test', 'Test', { category: '' }),
  J('old', 'Calendar', { category: 'Calendars', entityId: 'e-old', setAside: true }),
];
const scene = { journalId: 'salt', noteJournalIds: ['shop', 'missing'], tokens: [{ entityId: 'e-stalker', count: 3 }, { entityId: 'e-maric', count: 1 }, { entityId: 'e-hero', count: 1 }] };

test('the scene comes first: its page, the pages of its tokens, its map notes', () => {
  const v = tableView({ journals, scene, recent: [], pinned: [] });
  assert.equal(v.mode, 'table');
  assert.deepEqual(v.groups[0].rows.map((r) => [r.id, r.why]), [
    ['salt', { kind: 'scene' }],
    ['stalker', { kind: 'tokens', count: 3 }],
    ['maric', { kind: 'tokens', count: 1 }],
    ['shop', { kind: 'note' }],
  ]);
  assert.equal(v.groups[0].rows[2].where, 'Characters / Saltreach');
});

test('recent and pinned follow, and a page shows once', () => {
  const v = tableView({ journals, scene, recent: ['father', 'salt', 'gone', 'cyril'], pinned: ['cyril', 'test'] });
  assert.deepEqual(v.groups.map((g) => [g.key, g.rows.map((r) => r.id)]), [
    ['scene', ['salt', 'stalker', 'maric', 'shop']],
    ['recent', ['father', 'cyril']],
    ['pinned', ['test']],
  ]);
});

test('no scene, nothing recent or pinned: only the chips', () => {
  const v = tableView({ journals, scene: null, recent: [], pinned: [] });
  assert.deepEqual(v.groups, []);
  assert.ok(v.chips.length > 0);
});

test('one chip per category name, then Foundry-only and set aside', () => {
  const v = tableView({ journals, scene: null, recent: [], pinned: [] });
  assert.deepEqual(v.chips.map((c) => [c.key, c.count]), [
    ['Characters', 1], ['Creatures', 1], ['Factions', 2], ['Locations', 1], ['Lore', 2], ['Shops', 1],
    [ONLY_FOUNDRY, 1], [SET_ASIDE, 1],
  ]);
});

test('a chip lists its pages by folder then name; a set-aside page is only under set aside', () => {
  const lore = tableView({ journals, scene: null, recent: [], pinned: [], chip: 'Lore' });
  assert.deepEqual(lore.groups[0].rows.map((r) => r.id), ['cyril', 'father']);
  const aside = tableView({ journals, scene: null, recent: [], pinned: [], chip: SET_ASIDE });
  assert.deepEqual(aside.groups[0].rows.map((r) => r.id), ['old']);
  const calendars = tableView({ journals, scene: null, recent: [], pinned: [], chip: 'Calendars' });
  assert.deepEqual(calendars.groups[0].rows, []);
});

test('a set-aside page is never offered for a token of the same page', () => {
  const v = tableView({ journals, scene: { tokens: [{ entityId: 'e-old', count: 1 }] }, recent: [], pinned: [] });
  assert.deepEqual(v.groups, []);
});

test('search looks at names, categories, folders and tags; name starts rank first', () => {
  const by = (q) => tableView({ journals, scene, recent: [], pinned: [], query: q }).groups[0].rows.map((r) => r.id);
  assert.deepEqual(by('salt'), ['salt', 'maric']);
  assert.deepEqual(by('gods'), ['cyril', 'father']);
  assert.deepEqual(by('CITY'), ['salt']);
  assert.deepEqual(by('nothing like this'), []);
  assert.equal(tableView({ journals, scene, recent: [], pinned: [], query: '  ' }).mode, 'table');
});

test('recent keeps the newest first, once, up to its limit', () => {
  let list = [];
  for (let i = 0; i < RECENT_LIMIT + 3; i++) list = pushRecent(list, `j${i}`);
  list = pushRecent(list, 'j5');
  assert.equal(list.length, RECENT_LIMIT);
  assert.equal(list[0], 'j5');
  assert.equal(list.filter((x) => x === 'j5').length, 1);
  assert.deepEqual(pushRecent(['a'], ''), ['a']);
});

test('tokens count for their actor’s page and the page linked to them', () => {
  assert.deepEqual(tokenPages([
    { entityId: 'e-stalker' }, { entityId: 'e-stalker' }, { linkedEntityId: 'e-maric' },
    { entityId: 'e-hero', linkedEntityId: 'e-hero' }, {}, null,
  ], false), [
    { entityId: 'e-stalker', count: 2 }, { entityId: 'e-maric', count: 1 }, { entityId: 'e-hero', count: 1 },
  ]);
});

test('a hidden token is listed for the GM only', () => {
  const tokens = [{ entityId: 'e-ambush', hidden: true }, { entityId: 'e-maric' }];
  assert.deepEqual(tokenPages(tokens, false), [{ entityId: 'e-maric', count: 1 }]);
  assert.deepEqual(tokenPages(tokens, true).map((t) => t.entityId).sort(), ['e-ambush', 'e-maric']);
});

test('a Secret-disposition token (a disguise, a mimic) is listed for the GM only', () => {
  const tokens = [{ entityId: 'e-mimic', disposition: -2 }, { entityId: 'e-maric', disposition: 0 }];
  assert.deepEqual(tokenPages(tokens, false), [{ entityId: 'e-maric', count: 1 }]);
  assert.deepEqual(tokenPages(tokens, true).map((t) => t.entityId).sort(), ['e-maric', 'e-mimic']);
});
