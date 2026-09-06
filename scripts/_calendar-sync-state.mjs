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
 *   - `structure-changed`       — FM-SYNC-SUBRESOURCES-P1. Chronicle broadcast
 *                                 `calendar.structure.updated` (or its granular
 *                                 `cycle`/`festival` siblings) THIS SESSION, the
 *                                 module re-ran the comparison, and it came back
 *                                 compatible. Advisory, not an error: the counts
 *                                 we compare (month count, per-month day counts,
 *                                 weekday count) still match, but month NAMES,
 *                                 cycles, festivals and era boundaries are outside
 *                                 the comparison, so the operator should eyeball
 *                                 the calendar. We deliberately do NOT auto-apply
 *                                 the new structure — auto-merge is a later arc.
 *   - `date-drift`              — structures compatible (or not comparable) but the
 *                                 dates differ. Carries a direction.
 *   - `in-sync`                 — structures compatible and the dates match.
 *
 * `paused` outranks `incompatible-structures` because a paused module is the
 * stronger operational fact (sync is actually off); its detail string already
 * spells out the structural reason. `structure-changed` sits BELOW both — it is
 * an advisory that only makes sense once we've established nothing is actually
 * broken — and ABOVE `date-drift`/`in-sync`, because "the structure moved under
 * you" is more important than a one-day date delta. All four remain
 * independently reachable, so the badge never has to invent a state it can't
 * back with data.
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
 *   a `calendar.structure.updated` (or cycle/festival) broadcast arrived this
 *   session and the re-compare found the structures still compatible
 *   (FM-SYNC-SUBRESOURCES-P1). A truthy value raises the advisory
 *   `structure-changed` state; it is deliberately outranked by `paused` and
 *   `incompatible-structures`, which describe actual breakage.
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

  // 0. Chronicle's calendar endpoint is not answering (FM-CAL-BLACKOUT).
  //
  //    Ranked ABOVE `paused` because it is the stronger operational fact: with
  //    no server-side calendar there is nothing to be paused against, and no
  //    other verdict below is even computable.
  //
  //    This is defence in depth. The dashboard returns before reaching this
  //    function during the blackout, so today the branch is unreachable — but
  //    the fall-through at step 4 answers `date-drift` for a missing date,
  //    which would render an outage as "out of sync with Chronicle" and send
  //    the GM to check settings that are fine. An invariant that holds only
  //    because every caller remembers to guard it is not an invariant.
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
  //    compatible (FM-SYNC-SUBRESOURCES-P1). Advisory — sync keeps running, but
  //    the badge stops claiming a clean "In Sync" the operator hasn't verified.
  //    Reached only after the two breakage states above have been ruled out.
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
