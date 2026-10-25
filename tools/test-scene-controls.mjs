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
  assert.equal(g.tools['dm-screen'].title, titles.dmScreen);
  assert.ok(!('run' in g.tools.satchel));
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
    assert.equal(typeof obj['chronicle-sync'].tools.satchel.onChange, 'function');
    assert.equal(obj['chronicle-sync'].tools.satchel.title, titles.satchel);
  }
});

/** A stand-in for a click inside a toolbar element carrying data-tool. */
function pressOn(tool) {
  const el = { dataset: { tool } };
  return { target: { closest: (sel) => (sel === '[data-tool]' && tool ? el : null) } };
}

test('a v13 tool runs only when its own button is pressed', () => {
  const calls = [];
  const spy = { dashboard: () => calls.push('dashboard'), dmScreen: () => calls.push('dm-screen'),
    satchel: () => calls.push('satchel'), calendar: () => calls.push('calendar') };
  const obj = {};
  addChronicleControls(obj, { isGM: true, notebook: true, run: spy, titles });
  const tools = obj['chronicle-sync'].tools;

  tools.dashboard.onChange(pressOn('dashboard'), true);
  tools['dm-screen'].onChange(pressOn('dm-screen'), true);
  assert.deepEqual(calls, ['dashboard', 'dm-screen']);

  // Foundry calling the group's active tool when another group or tab is
  // clicked, or on a toolbar re-render, must not open anything.
  calls.length = 0;
  tools.dashboard.onChange(pressOn('tokens'), true);
  tools.dashboard.onChange(pressOn(null), true);
  tools.dashboard.onChange(undefined, true);
  tools.dashboard.onChange(pressOn('dashboard'), false);
  assert.deepEqual(calls, []);
});
