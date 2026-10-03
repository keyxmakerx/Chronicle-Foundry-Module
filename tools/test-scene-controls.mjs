#!/usr/bin/env node
/** Pins the Chronicle scene-control group (scripts/_scene-controls.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addChronicleControls } from '../scripts/_scene-controls.mjs';

const run = { dashboard() {}, syncCalendar() {}, notebook() {} };
const titles = { syncCalendar: 'Open Sync Calendar', notebook: 'Open my Chronicle notebook' };

function names(controls) {
  if (Array.isArray(controls)) {
    const g = controls.find((c) => c.name === 'chronicle-sync');
    return g ? g.tools.map((t) => t.name) : null;
  }
  const g = controls['chronicle-sync'];
  return g ? Object.keys(g.tools) : null;
}

const CASES = [
  ['GM, connected', { isGM: true, notebook: true }, ['dashboard', 'sync-calendar', 'notebook']],
  ['GM, not connected', { isGM: true, notebook: false }, ['dashboard', 'sync-calendar']],
  ['player, connected', { isGM: false, notebook: true }, ['notebook']],
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
  assert.equal(arr[0].tools[0].onClick, run.notebook);
  assert.equal(arr[0].layer, 'controls');
  const obj = {};
  addChronicleControls(obj, { isGM: true, notebook: true, run, titles });
  const g = obj['chronicle-sync'];
  assert.equal(g.activeTool, 'dashboard');
  assert.equal(g.tools['sync-calendar'].onChange, run.syncCalendar);
  assert.equal(g.tools['sync-calendar'].icon, 'fa-solid fa-calendar-days');
  assert.equal(g.tools.notebook.title, titles.notebook);
  assert.ok(!('run' in g.tools.notebook));
});
