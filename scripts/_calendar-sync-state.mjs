/**
 * Chronicle Sync — calendar sync-state classifier.
 *
 * Pure helper mapping the dashboard's calendar inputs to one explicit state:
 * `unavailable`, `paused`, `incompatible-structures`, `structure-changed`,
 * `date-drift`, or `in-sync`. States are checked in that order, each ranked
 * above the ones below it because it is the stronger operational fact (e.g.
 * a paused module means sync is actually off, so it outranks a date delta).
 * `structure-changed` is advisory only: counts still match, but month names,
 * cycles, festivals and era boundaries aren't compared, and the new
 * structure is never auto-applied.
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
 * @param {string|null} [input.structureChangedDetail] - set by CalendarSync when
 *   a structure-updated broadcast arrived this session and the re-compare found
 *   the structures still compatible; truthy raises the advisory
 *   `structure-changed` state.
 * @returns {{state:('in-sync'|'date-drift'|'structure-changed'|'incompatible-structures'|'paused'|'unavailable'),
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
    structureChangedDetail = null,
    unavailable = false,
    unavailableDetail = null,
  } = input || {};

  // 0. Chronicle's calendar endpoint is not answering. Ranked above `paused`
  //    because with no server-side calendar nothing below is computable.
  //    Callers normally return earlier during a blackout; this guard is
  //    defence in depth so a missing date never falls through to `date-drift`
  //    and reports an outage as an out-of-sync date.
  if (unavailable) {
    return {
      state: 'unavailable',
      direction: null,
      detail: unavailableDetail
        || 'Chronicle’s calendar is unavailable — sync is paused. Other sync is unaffected.',
    };
  }

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

  // 3. Chronicle's structure moved this session and the re-compare came back
  //    compatible. Advisory — sync keeps running, but the badge stops claiming
  //    a clean "In Sync" the operator hasn't verified.
  if (structureChangedDetail) {
    return { state: 'structure-changed', direction: null, detail: structureChangedDetail };
  }

  // 4/5. Structures compatible (or not comparable). Compare dates.
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
