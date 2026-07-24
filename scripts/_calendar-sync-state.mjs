/**
 * Chronicle Sync — calendar sync-state classifier (FM-SYNC-WIRE-FIX fix 3).
 *
 * Pure helper mapping the dashboard's calendar inputs to ONE of four explicit,
 * honest states. Extracted from sync-dashboard.mjs so the classification is
 * unit-testable in isolation (house pattern: `_overview-model.mjs`,
 * `_calendar-probe-state.mjs`).
 *
 * The pre-fix badge lied twice: it computed "In Sync" from raw y/m/d equality
 * alone (no structure awareness, no drift direction) and derived its "paused"
 * state from a flag the SimpleCalendar path never set. This classifier replaces
 * that with:
 *
 *   - `paused`                  — the live CalendarSync module has stopped calendar
 *                                 sync for the session (`_calendarSyncDisabled`).
 *                                 Now fed by BOTH module paths (fix 2 makes the
 *                                 SimpleCalendar path set the flag too).
 *   - `incompatible-structures` — the module has NOT paused, but the dashboard can
 *                                 itself read both structures and they differ. This
 *                                 is the fail-open case: the module skips pausing on
 *                                 an unreadable structure, or isn't running, yet the
 *                                 dates on the wire are still meaningless. Carries
 *                                 the month/weekday counts.
 *   - `date-drift`              — structures compatible (or not comparable) but the
 *                                 dates differ. Carries a direction.
 *   - `in-sync`                 — structures compatible and the dates match.
 *
 * `paused` outranks `incompatible-structures` because a paused module is the
 * stronger operational fact (sync is actually off); its detail string already
 * spells out the structural reason. Both remain independently reachable, so the
 * badge never has to invent a state it can't back with data.
 */

/**
 * Compare two {year, month, day} coordinates. Missing fields sort low.
 * @param {{year?:number, month?:number, day?:number}} a
 * @param {{year?:number, month?:number, day?:number}} b
 * @returns {number} <0 if a<b, 0 if equal, >0 if a>b
 */
function compareDates(a, b) {
  for (const key of ['year', 'month', 'day']) {
    const av = Number(a?.[key] ?? 0);
    const bv = Number(b?.[key] ?? 0);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Classify the calendar sync state from the dashboard's already-gathered inputs.
 *
 * @param {object} input
 * @param {boolean} input.paused - CalendarSync `_calendarSyncDisabled` (module
 *   paused this session). When true the state is `paused` regardless of dates.
 * @param {string|null} [input.pausedDetail] - CalendarSync `_calendarMismatchDetail`
 *   (human-readable reason the module paused).
 * @param {{match:boolean, detail:string}|null} [input.structureCmp] - result of
 *   `compareCalendarStructures` when BOTH structures were readable; null when the
 *   dashboard could not compare (fail-open — never reports incompatible on a
 *   missing read).
 * @param {string|null} [input.chronicleShape] - e.g. `"12mo/7wd"` (for the
 *   incompatible-structures detail).
 * @param {string|null} [input.foundryShape] - e.g. `"15mo/6wd"`.
 * @param {{year:number, month:number, day:number}|null} [input.chronicleDate]
 * @param {{year:number, month:number, day:number}|null} [input.foundryDate]
 * @returns {{state:('in-sync'|'date-drift'|'incompatible-structures'|'paused'),
 *   direction:('chronicle-ahead'|'foundry-ahead'|null), detail:string}}
 */
export function classifyCalendarSyncState(input) {
  const {
    paused = false,
    pausedDetail = null,
    structureCmp = null,
    chronicleShape = null,
    foundryShape = null,
    chronicleDate = null,
    foundryDate = null,
  } = input || {};

  // 1. Module has paused sync for the session — the strongest fact.
  if (paused) {
    return {
      state: 'paused',
      direction: null,
      detail: pausedDetail || 'Calendar sync is paused for this session.',
    };
  }

  // 2. Dashboard-detected structural incompatibility while the module has NOT
  //    paused (fail-open, or module not running). Only when we actually compared.
  if (structureCmp && structureCmp.match === false) {
    const shapes = chronicleShape && foundryShape
      ? `Chronicle ${chronicleShape} vs Foundry ${foundryShape} — `
      : '';
    return {
      state: 'incompatible-structures',
      direction: null,
      detail: `${shapes}${structureCmp.detail || 'calendar structures differ'}`,
    };
  }

  // 3/4. Structures compatible (or not comparable). Compare dates.
  //     A missing local date can never be confirmed in-sync — report drift with
  //     an unknown direction rather than claiming synchronization.
  if (!foundryDate || !chronicleDate) {
    return { state: 'date-drift', direction: null, detail: '' };
  }
  const cmp = compareDates(chronicleDate, foundryDate);
  if (cmp === 0) {
    return { state: 'in-sync', direction: null, detail: '' };
  }
  return {
    state: 'date-drift',
    // Chronicle later than Foundry → Chronicle is ahead (pulling advances Foundry).
    direction: cmp > 0 ? 'chronicle-ahead' : 'foundry-ahead',
    detail: '',
  };
}
