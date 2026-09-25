// Pins the calendar-structure-mismatch remedy text (the pause toast plus the
// dashboard's two Calendar-tab banners) to advice the operator can actually
// follow: edit either calendar's structure so the two match. "Import" and
// "author a new calendar" are NOT reachable — the campaign already has a
// calendar by construction whenever this mismatch fires, so Chronicle's
// create-calendar endpoint 409s, and a newly authored calendar is never made
// default (no caller sets it), so it never reaches the wire. Pointing the
// module at a different Chronicle calendar is a separate, still-open gap
// (#95) and must not be implied by this text either. All three strings are
// read from where they ship and held to the same verdict so they can't drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Foundry global stubs ---------------------------------------------------
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};
globalThis.game = globalThis.game || {
  settings: { get: () => '', set: () => {}, register: () => {}, registerMenu: () => {} },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  users: [],
  user: { id: 'u1', isGM: true },
  journal: { find: () => null },
};
globalThis.Hooks = globalThis.Hooks || { on: () => {}, once: () => {}, off: () => {} };

const { CalendarSync } = await import('../scripts/calendar-sync.mjs');

/** The permanent toast the pause path raises. */
function toastText() {
  const cs = new CalendarSync({}, {});
  let msg = '';
  const prevUI = globalThis.ui;
  globalThis.ui = { notifications: { warn: (m) => { msg = m; } } };
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    cs._pauseCalendarSyncForMismatch(
      { name: 'Harptos', months: new Array(12), weekdays: new Array(10) },
      { name: 'Gregorian', monthDays: new Array(12), weekdayCount: 7 },
      'weekday count 10 vs 7',
    );
  } finally {
    console.warn = prevWarn;
    globalThis.ui = prevUI;
  }
  return msg;
}

/** The dashboard's two Calendar-tab mismatch hints, read from the template. */
function bannerHints() {
  const hbs = readFileSync(join(root, 'templates', 'sync-dashboard.hbs'), 'utf8');
  const block = hbs.slice(hbs.indexOf('calendar-mismatch-banner'));
  const hints = [...block.matchAll(/<div class="action-hint">([\s\S]*?)<\/div>/g)].map((m) => m[1].trim());
  assert.equal(hints.length, 2,
    'expected exactly two calendar-mismatch action hints (paused + incompatible) — '
    + 'if the template grew a third, it has to be held to the same standard');
  return hints;
}

/**
 * The unreachable instructions, as patterns. Each is paired with the Chronicle
 * source fact that closes it, so a future reader can re-verify rather than
 * trust this file.
 */
const UNREACHABLE = [
  {
    re: /\bimport(ing)?\b[^.]*\bcalendar\b|\bcalendar\b[^.]*\bimport(ing)?\b/i,
    why: 'POST /api/v1/campaigns/:cid/calendar returns 409 calendar_already_exists '
      + 'whenever the campaign has ANY calendar, which is always true when a '
      + 'structure mismatch has been computed against one',
  },
  {
    re: /\bauthor\b|\bcreate a (new )?calendar\b|\bnew calendar\b/i,
    why: 'calendarService.CreateCalendar sets IsDefault only for the FIRST '
      + 'calendar in a campaign, the module is served '
      + '`ORDER BY is_default DESC, sort_order ASC LIMIT 1`, and Chronicle\'s '
      + 'SetDefaultCalendar has no route, handler or control — so an authored '
      + 'calendar never reaches the wire',
  },
];

/** The reachable remedy has to be named, not merely implied. */
const REACHABLE = /calendar settings|months|weekdays|structure|edit/i;

test('the mismatch remedy never tells the operator to import or author a calendar', () => {
  const texts = [['the pause toast', toastText()], ...bannerHints().map((h, i) => [`banner hint ${i + 1}`, h])];
  for (const [label, text] of texts) {
    assert.ok(text && text.length > 0, `${label} is empty — there is nothing to check`);
    for (const { re, why } of UNREACHABLE) {
      assert.equal(re.test(text), false,
        `${label} tells the operator to do something that cannot be done:\n`
        + `  ${text}\n`
        + `  ${why}`);
    }
  }
});

test('the mismatch remedy names a reachable action instead', () => {
  const texts = [['the pause toast', toastText()], ...bannerHints().map((h, i) => [`banner hint ${i + 1}`, h])];
  for (const [label, text] of texts) {
    assert.ok(REACHABLE.test(text),
      `${label} removes the impossible advice without offering the possible one:\n`
      + `  ${text}\n`
      + '  Editing either calendar so the two structures match IS reachable — '
      + 'Chronicle\'s Calendar Settings owns months and weekdays, and Calendaria / '
      + 'Simple Calendar own the Foundry side. An empty remedy is honest but useless.');
  }
});

test('the pause toast still says sync is paused and what keeps working', () => {
  // The two facts the remedy must not cost while it is being rewritten: the
  // operator has to know calendar sync stopped, and that the rest did not.
  const text = toastText();
  assert.match(text, /paused/i, 'the toast must still say calendar sync is paused');
  assert.match(text, /journals/i,
    'the toast must still say journals, characters and maps keep syncing — that '
    + 'sentence is what stops a structure mismatch reading as a dead integration');
  assert.match(text, /reload the world/i,
    'the pause is for the session, so the toast must still say a reload is what clears it');
});
