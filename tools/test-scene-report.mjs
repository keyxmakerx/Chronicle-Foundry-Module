#!/usr/bin/env node
/** Scene report: body shape, order, caps, folder paths and the hooks that trigger it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSceneReport, folderPath, sidebarOrder, SCENE_HOOKS, MAX_SCENES, MAX_SCENE_NAME_CHARS,
} from '../scripts/_scene-report.mjs';
import { PlayerReporter } from '../scripts/_player-report.mjs';

test('body has the contract fields, in the order given', () => {
  const body = buildSceneReport([
    { id: 's2', name: 'Sunken Crypt', folder: 'Act 2', active: false, navigation: true },
    { id: 's1', name: "Dragon's Lair", folder: '', active: true },
    { id: '', name: 'No id is dropped' },
    null,
  ]);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.scenes.map((s) => s.id), ['s2', 's1']);
  assert.deepEqual(body.scenes[1], { id: 's1', name: "Dragon's Lair", folder: '', active: true, navigation: false });
  assert.deepEqual(Object.keys(body).sort(), ['scenes', 'truncated']);
});

test('names are trimmed, folded onto one line and capped', () => {
  const body = buildSceneReport([{ id: 's1', name: `  Two\n lines ${'x'.repeat(400)}` }]);
  assert.ok(body.scenes[0].name.startsWith('Two lines '));
  assert.equal(body.scenes[0].name.length, MAX_SCENE_NAME_CHARS);
});

test('a world over the cap sends the first in sidebar order and says it is truncated', () => {
  const many = Array.from({ length: MAX_SCENES + 3 }, (_, i) => ({ id: `s${i}`, name: `Scene ${String(i).padStart(5, '0')}` }));
  const body = buildSceneReport(many);
  assert.equal(body.scenes.length, MAX_SCENES);
  assert.equal(body.truncated, true);
  assert.equal(body.scenes[0].name, 'Scene 00000');
});

test('sidebar order: subfolders first, then scenes, as the tree sorts them', () => {
  const sc = (id) => ({ id });
  const [lair, crypt, caves1, caves2, town, loose] = ['lair', 'crypt', 'c1', 'c2', 'town', 'loose'].map(sc);
  const scenes = {
    contents: [town, caves2, lair, loose, crypt, caves1],
    tree: {
      entries: [town],
      children: [
        { entries: [lair, crypt], children: [{ entries: [caves1, caves2], children: [] }] },
        { entries: [], children: [] },
      ],
    },
  };
  assert.deepEqual(sidebarOrder(scenes).map((s) => s.id), ['c1', 'c2', 'lair', 'crypt', 'town', 'loose'],
    'a scene the tree missed comes last, never dropped');
  assert.deepEqual(sidebarOrder({ contents: [crypt, lair] }).map((s) => s.id), ['crypt', 'lair'], 'no tree: collection order');
  assert.deepEqual(sidebarOrder(null), []);
  // A tree that loops back on itself stops instead of recursing forever.
  const loop = { entries: [lair], children: [] };
  loop.children.push(loop);
  assert.deepEqual(sidebarOrder({ contents: [lair], tree: loop }).map((s) => s.id), ['lair']);
});

test('the same world builds the same body twice', () => {
  const world = { contents: [{ id: 'a', name: 'Keep' }, { id: 'b', name: 'Cave' }], tree: { entries: [], children: [] } };
  world.tree.entries = [world.contents[1], world.contents[0]];
  assert.equal(JSON.stringify(buildSceneReport(sidebarOrder(world))), JSON.stringify(buildSceneReport(sidebarOrder(world))));
  assert.deepEqual(buildSceneReport(sidebarOrder(world)).scenes.map((s) => s.name), ['Cave', 'Keep']);
});

test('folder path reads outermost first', () => {
  assert.equal(folderPath(null), '');
  assert.equal(folderPath({ name: 'Caves', ancestors: [{ name: 'Act 2' }, { name: 'Campaign' }] }), 'Campaign / Act 2 / Caves');
  assert.equal(folderPath({ name: 'Top' }), 'Top');
});

test('scene and folder edits trigger a report', () => {
  for (const h of ['createScene', 'updateScene', 'deleteScene', 'updateFolder']) assert.ok(SCENE_HOOKS.includes(h), h);
});

test('the reporter stops on 404 and logs under its own label', async () => {
  const logs = [];
  const r = new PlayerReporter({
    label: 'scene report',
    send: async () => { const e = new Error('nope'); e.status = 404; throw e; },
    build: () => buildSceneReport([]),
    log: (m) => logs.push(m),
  });
  assert.equal(await r.report(), 'stopped');
  assert.equal(await r.report(), 'stopped');
  assert.deepEqual(logs, ['scene report stopped for this session (HTTP 404)']);
});

test('sync manager wires the scene report to the right route and hooks', () => {
  const sm = readFileSync(new URL('../scripts/sync-manager.mjs', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../scripts/api-client.mjs', import.meta.url), 'utf8');
  assert.match(api, /reportScenes\(body\) \{\s*return this\.post\('\/sync\/scenes', body\);/);
  assert.match(sm, /this\._scenes\.report\(\{ force: true \}\)/);
  assert.match(sm, /for \(const name of SCENE_HOOKS\)/);
  // Pictures never travel: the builder is handed no image fields.
  const at = sm.indexOf('buildSceneReport(sidebarOrder(game.scenes)');
  assert.ok(at > 0, 'the report is built in sidebar order');
  assert.doesNotMatch(sm.slice(at, at + 300), /background|thumb|img/);
});
