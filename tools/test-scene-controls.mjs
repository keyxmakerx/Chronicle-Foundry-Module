#!/usr/bin/env node
/** Pins the Chronicle scene-control group (scripts/_scene-controls.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addChronicleControls } from '../scripts/_scene-controls.mjs';

const run = { dashboard() {}, dmScreen() {}, satchel() {}, calendar() {} };
const titles = { dashboard: 'Open Chronicle Sync', dmScreen: 'Open the DM Screen', satchel: 'Open my Satchel', calendar: 'Open the Chronicle calendar' };

function names(controls) {
  if (Array.isArray(controls)) {
    const g = controls.find((c) => c.name === 'chronicle-sync');
    return g ? g.tools.map((t) => t.name) : null;
  }
  const g = controls['chronicle-sync'];
  return g ? Object.keys(g.tools) : null;
}

const CASES = [
  ['GM, connected', { isGM: true, notebook: true }, ['dashboard', 'dm-screen', 'satchel', 'calendar']],
  ['GM, not connected', { isGM: true, notebook: false }, ['dashboard', 'dm-screen']],
  ['player, connected', { isGM: false, notebook: true }, ['satchel', 'calendar']],
  ['player, not connected', { isGM: false, notebook: false }, null],
];

for (const [name, opts, want] of CASES) {
  test(`v12 array: ${name}`, () => {
    const controls = [];
    addChronicleControls(controls, { ...opts, run, titles });
    assert.deepEqual(names(controls), want);
  });
  test(`v13 object: ${name}`, () => {
    const controls = {};
    addChronicleControls(controls, { ...opts, run, titles });
    assert.deepEqual(names(controls), want);
  });
}

test('v12 tools use onClick; v13 tools use onChange and name an activeTool', () => {
  const arr = [];
  addChronicleControls(arr, { isGM: false, notebook: true, run, titles });
  assert.equal(arr[0].tools[0].onClick, run.satchel);
  assert.equal(arr[0].layer, 'controls');
  const obj = {};
  addChronicleControls(obj, { isGM: true, notebook: true, run, titles });
  const g = obj['chronicle-sync'];
  assert.equal(g.activeTool, 'dashboard');
  assert.equal(g.tools.satchel.title, titles.satchel);
  assert.equal(g.tools.dashboard.title, titles.dashboard);
  assert.equal(g.tools['dm-screen'].onChange, run.dmScreen);
  assert.equal(g.tools['dm-screen'].title, titles.dmScreen);
  assert.ok(!('run' in g.tools.satchel));
  assert.equal(g.tools.calendar.onChange, run.calendar);
  assert.equal(g.tools.calendar.title, titles.calendar);
});

test('without a calendar opener there is no Calendar button', () => {
  const controls = {};
  const { calendar, ...noCal } = run;
  addChronicleControls(controls, { isGM: false, notebook: true, run: noCal, titles });
  assert.deepEqual(names(controls), ['satchel']);
});

test('the Satchel button is for players and the GM alike', () => {
  for (const isGM of [false, true]) {
    const obj = {};
    addChronicleControls(obj, { isGM, notebook: true, run, titles });
    assert.equal(obj['chronicle-sync'].tools.satchel.onChange, run.satchel);
    assert.equal(obj['chronicle-sync'].tools.satchel.title, titles.satchel);
  }
});
