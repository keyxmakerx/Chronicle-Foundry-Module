#!/usr/bin/env node
/**
 * `scripts/_chronicle-caldate.mjs` must place days, weekdays and leap days
 * exactly where Chronicle's calendar page does. Always: a few fixed answers.
 * With CHRONICLE_DIR pointing at a Chronicle checkout: every function is
 * compared with Chronicle's own `CalDate` (static/js/widgets/calendar_view.js)
 * across sample calendars and a spread of dates.
 *
 * Run: `node --test tools/test-chronicle-caldate.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import * as CD from '../scripts/_chronicle-caldate.mjs';

const harptos = {
  mode: 'fantasy',
  months: [
    { name: 'Hammer', days: 30 }, { name: 'Midwinter', days: 1, is_intercalary: true },
    { name: 'Alturiak', days: 30 }, { name: 'Ches', days: 30, leap_year_days: 1 },
  ],
  weekdays: Array.from({ length: 10 }, (_, i) => ({ name: `D${i + 1}` })),
  leap_year_every: 4, leap_year_offset: 0,
};
const restart = { ...harptos, month_starts_new_week: true };
const gregorian = {
  mode: 'reallife', tracks_real_time: true,
  months: Array.from({ length: 12 }, (_, i) => ({ name: `M${i + 1}`, days: 31 })),
  weekdays: Array.from({ length: 7 }, (_, i) => ({ name: `W${i}` })),
};
const CALS = { harptos, restart, gregorian };

test('fixed answers', () => {
  assert.equal(CD.monthDays(harptos, 3, 1492), 31); // leap year adds Ches's day
  assert.equal(CD.monthDays(harptos, 3, 1493), 30);
  assert.equal(CD.monthDays(gregorian, 1, 2024), 29); // real-time follows the real calendar
  assert.equal(CD.weekdayCol(restart, 1492, 2, 1), -1); // festival day outside the week
  assert.equal(CD.weekdayCol(restart, 1492, 3, 1), 0);
  assert.deepEqual(CD.addDays(harptos, { y: 1492, m: 1, d: 30 }, 1), { y: 1492, m: 2, d: 1 });
  assert.deepEqual(CD.addDays(harptos, { y: 1492, m: 1, d: 1 }, -1), { y: 1491, m: 4, d: 30 });
  assert.deepEqual(CD.shiftMonth(harptos, 1492, 4, 1), { y: 1493, m: 1 });
});

const chronicleDir = process.env.CHRONICLE_DIR;
const viewFile = chronicleDir && join(resolve(chronicleDir), 'static', 'js', 'widgets', 'calendar_view.js');

/** Chronicle's `var CalDate = {…};` block, evaluated on its own. */
function loadChronicleCalDate(file) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('var CalDate = {');
  assert.ok(start >= 0, 'var CalDate not found in calendar_view.js');
  const end = src.indexOf('\n  };', start);
  assert.ok(end > start, 'end of CalDate not found');
  const ctx = {};
  vm.runInNewContext(`${src.slice(start, end + 5)}\nthis.CalDate = CalDate;`, ctx);
  return ctx.CalDate;
}

test('matches Chronicle\'s CalDate (needs CHRONICLE_DIR)', { skip: !(viewFile && existsSync(viewFile)) && 'CHRONICLE_DIR not set' }, () => {
  const ch = loadChronicleCalDate(viewFile);
  const names = Object.keys(CD).filter((k) => typeof CD[k] === 'function');
  for (const n of names) assert.equal(typeof ch[n], 'function', `Chronicle's CalDate has no ${n}`);
  for (const [cname, cal] of Object.entries(CALS)) {
    for (const year of [-3, 0, 1, 3, 4, 1491, 1492, 2023, 2024]) {
      assert.equal(CD.isLeapYear(cal, year), ch.isLeapYear(cal, year), `${cname} isLeapYear ${year}`);
      assert.equal(CD.leapYearsBefore(cal, year), ch.leapYearsBefore(cal, year), `${cname} leapYearsBefore ${year}`);
      for (let m = 1; m <= cal.months.length; m++) {
        assert.equal(CD.monthDays(cal, m - 1, year), ch.monthDays(cal, m - 1, year), `${cname} monthDays ${year}-${m}`);
        assert.deepEqual(CD.shiftMonth(cal, year, m, 5), { ...ch.shiftMonth(cal, year, m, 5) });
        assert.deepEqual(CD.shiftMonth(cal, year, m, -7), { ...ch.shiftMonth(cal, year, m, -7) });
        for (const d of [1, 2, 15, 30]) {
          if (d > CD.monthDays(cal, m - 1, year)) continue;
          const at = `${cname} ${year}-${m}-${d}`;
          assert.equal(CD.dayIndex(cal, year, m, d), ch.dayIndex(cal, year, m, d), `dayIndex ${at}`);
          assert.equal(CD.weekdayCol(cal, year, m, d), ch.weekdayCol(cal, year, m, d), `weekdayCol ${at}`);
          for (const delta of [1, -1, 40, -400]) {
            assert.deepEqual(CD.addDays(cal, { y: year, m, d }, delta), { ...ch.addDays(cal, { y: year, m, d }, delta) }, `addDays ${at} ${delta}`);
          }
        }
      }
    }
  }
});
