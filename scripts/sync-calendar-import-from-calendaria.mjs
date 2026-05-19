/**
 * Chronicle Sync — Calendaria → Chronicle calendar-import transform (pure).
 *
 * The Sync Calendar editor's empty-state import flow takes a Calendaria
 * calendar (full object via `CALENDARIA.api.getCalendar(id)`) and turns
 * it into a Chronicle create-calendar payload that the operator POSTs to
 * `POST /api/v1/campaigns/:cid/calendar` (new endpoint added by the
 * concurrent C-CAL-CREATE-ENDPOINT dispatch).
 *
 * v1 transform scope (per dispatch):
 *
 *   Maps:    name, description, current date, months, weekdays (days),
 *            seasons, moons, eras.
 *   Skips:   cycles, festivals, weather zones (the operator can add
 *            them via Chronicle's internal UI after the import — see
 *            C-CAL-WCF-UI).
 *
 * The transform is one-shot: post-import, Chronicle is the source of
 * truth and the existing two-way sync in `calendar-sync.mjs` handles
 * date + events. Structure-level two-way sync is PR 5.
 *
 * Pure: no DOM, no Foundry globals, no Calendaria coupling beyond the
 * input shape. Unit-tested at
 * `tools/test-sync-calendar-import-from-calendaria.mjs` against the
 * three operator fixture calendars.
 */

/**
 * Wire-contract version stamp. Bumped by Chronicle's
 * `2026-05-XX-calendar-create-wire.md` decision doc when the create-
 * payload shape changes; matched here so older Foundry clients can
 * detect a contract mismatch.
 */
export const IMPORT_WIRE_VERSION = 1;

/**
 * Transform a Calendaria calendar into a Chronicle create-calendar
 * payload.
 *
 * @param {object} calendariaCalendar - return of `CALENDARIA.api.getCalendar(id)`
 * @returns {{
 *   payload: object,
 *   summary: { mappedCounts: object, skipped: string[] },
 * }}
 */
export function transformCalendariaCalendar(calendariaCalendar) {
  if (!calendariaCalendar || typeof calendariaCalendar !== 'object') {
    throw new Error('Cannot transform: input is not a Calendaria calendar object.');
  }

  const months   = readCollection(calendariaCalendar.months,   'months');
  const weekdays = readCollection(calendariaCalendar.days,     'days');
  const seasons  = readCollection(calendariaCalendar.seasons,  'seasons');
  const moons    = readCollection(calendariaCalendar.moons,    'moons');
  const eras     = readCollection(calendariaCalendar.eras,     'eras');
  // Skipped — surfaced in summary.
  const cycles    = readCollection(calendariaCalendar.cycles,    'cycles');
  const festivals = readCollection(calendariaCalendar.festivals, 'festivals');
  const weather   = (calendariaCalendar.weather?.zones && typeof calendariaCalendar.weather.zones === 'object')
    ? Object.values(calendariaCalendar.weather.zones)
    : [];

  const currentDate = calendariaCalendar.currentDate || {};
  const yearsBlock = calendariaCalendar.years || {};

  const payload = {
    schema_version: IMPORT_WIRE_VERSION,
    source: 'calendaria',
    source_id: calendariaCalendar.metadata?.id || '',

    name:        String(calendariaCalendar.name || 'Imported Calendar'),
    description: String(calendariaCalendar.description || ''),

    year_zero:           toIntOr(yearsBlock.yearZero, 0),
    current_year:        toIntOr(currentDate.year,       yearsBlock.yearZero ?? 0),
    current_month:       toIntOr(currentDate.month,       0) + 1,
    current_day:         toIntOr(currentDate.dayOfMonth,  0) + 1,
    current_hour:        toIntOr(currentDate.hour,        0),
    current_minute:      toIntOr(currentDate.minute,      0),
    seconds_per_round:   toIntOr(calendariaCalendar.secondsPerRound, 6),
    allow_negative_years: !!yearsBlock.allowNegativeYears,

    months:   months.sortedByOrdinal.map((m) => ({
      name:           String(m.name || ''),
      abbreviation:   String(m.abbreviation || ''),
      days:           toIntOr(m.days, 0),
      intercalary:    !!m.intercalary,
      ordinal:        toIntOr(m.ordinal, null),
      leap_extra_days: m.leapDays != null ? toIntOr(m.leapDays, 0) : null,
    })),

    weekdays: weekdays.sortedByOrdinal.map((d) => ({
      name:         String(d.name || ''),
      abbreviation: String(d.abbreviation || ''),
      rest_day:     !!d.isRestDay,
      ordinal:      toIntOr(d.ordinal, null),
    })),

    seasons: seasons.values.map((s) => ({
      name:           String(s.name || ''),
      abbreviation:   String(s.abbreviation || ''),
      color:          String(s.color || ''),
      icon:           String(s.icon || ''),
      seasonal_type:  String(s.seasonalType || ''),
      month_start:    s.monthStart != null ? toIntOr(s.monthStart, null) : null,
      month_end:      s.monthEnd   != null ? toIntOr(s.monthEnd,   null) : null,
      day_start:      s.dayStart   != null ? toIntOr(s.dayStart,   null) : null,
      day_end:        s.dayEnd     != null ? toIntOr(s.dayEnd,     null) : null,
    })),

    moons: moons.values.map((moon) => ({
      name:                String(moon.name || ''),
      color:               String(moon.color || ''),
      cycle_length:        toIntOr(moon.cycleLength, 0),
      cycle_day_adjust:    toIntOr(moon.cycleDayAdjust, 0),
      // We pass `phase_mode` through verbatim — Calendaria's enum is
      // `'fixed' | 'randomized'`; Chronicle stores the string and feeds
      // it back so Foundry can recover the original.
      phase_mode:          String(moon.phaseMode || 'fixed'),
      cycle_variance:      Number.isFinite(moon.cycleVariance) ? Number(moon.cycleVariance) : 0,
      reference_phase:     Number.isFinite(moon.referencePhase) ? Number(moon.referencePhase) : 0,
      reference_date:      moonReferenceDateToWire(moon.referenceDate),
      // Phase table is opaque to Chronicle; we ship the keyed object as
      // an array of `{id, name, icon, start, end}` so round-tripping
      // back into Calendaria is feasible (PR 5 work).
      phases:              extractPhases(moon.phases),
    })),

    eras: eras.values.map((era) => ({
      name:         String(era.name || ''),
      abbreviation: String(era.abbreviation || ''),
      start_year:   toIntOr(era.startYear, null),
      end_year:     era.endYear != null ? toIntOr(era.endYear, null) : null,
      format:       String(era.format || 'suffix'),
    })),
  };

  const skipped = [];
  if (cycles.values.length > 0)    skipped.push(`cycles (${cycles.values.length})`);
  if (festivals.values.length > 0) skipped.push(`festivals (${festivals.values.length})`);
  if (weather.length > 0)          skipped.push(`weather zones (${weather.length})`);

  return {
    payload,
    summary: {
      mappedCounts: {
        months:   payload.months.length,
        weekdays: payload.weekdays.length,
        seasons:  payload.seasons.length,
        moons:    payload.moons.length,
        eras:     payload.eras.length,
      },
      skipped,
    },
  };
}

/**
 * Pre-flight summary for the import button row — shown to the operator
 * BEFORE they click the button, so they can pick the right calendar
 * with full knowledge of what's lossy.
 *
 * @param {object} calendariaCalendar
 * @returns {{
 *   id: string, name: string, daysPerYear: number,
 *   monthCount: number, weekdayCount: number, moonCount: number,
 *   skipNotice: string,
 * }}
 */
export function buildCalendarPreflightSummary(calendariaCalendar) {
  if (!calendariaCalendar || typeof calendariaCalendar !== 'object') {
    return { id: '', name: '', daysPerYear: 0, monthCount: 0, weekdayCount: 0, moonCount: 0, skipNotice: '' };
  }
  const months   = readCollection(calendariaCalendar.months,   'months');
  const weekdays = readCollection(calendariaCalendar.days,     'days');
  const moons    = readCollection(calendariaCalendar.moons,    'moons');
  const cycles    = readCollection(calendariaCalendar.cycles,    'cycles');
  const festivals = readCollection(calendariaCalendar.festivals, 'festivals');
  const weather   = (calendariaCalendar.weather?.zones && typeof calendariaCalendar.weather.zones === 'object')
    ? Object.values(calendariaCalendar.weather.zones).length
    : 0;
  const daysPerYear = months.values.reduce((s, m) => s + (Number(m.days) || 0), 0);
  const skipParts = [];
  if (cycles.values.length)    skipParts.push(`cycles (${cycles.values.length})`);
  if (festivals.values.length) skipParts.push(`festivals (${festivals.values.length})`);
  if (weather)                 skipParts.push(`weather zones (${weather})`);
  return {
    id:           calendariaCalendar.metadata?.id || '',
    name:         calendariaCalendar.name || '',
    daysPerYear,
    monthCount:   months.values.length,
    weekdayCount: weekdays.values.length,
    moonCount:    moons.values.length,
    skipNotice:   skipParts.length ? `Skips: ${skipParts.join(', ')}` : '',
  };
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * Calendaria stores `months`/`days`/`seasons` as `{values: {id: {...}}}`
 * (id-keyed objects). `moons` is a flat `{id: {...}}` object. `eras` is
 * also flat. This helper normalizes everything into an `{values: [], sortedByOrdinal: []}`
 * shape the transform can iterate.
 */
function readCollection(input, kind) {
  if (!input || typeof input !== 'object') {
    return { values: [], sortedByOrdinal: [] };
  }
  const flat = (input.values && typeof input.values === 'object') ? input.values : input;
  const values = Object.values(flat).filter((v) => v && typeof v === 'object');
  const sortedByOrdinal = values
    .slice()
    .sort((a, b) => {
      const ao = Number(a.ordinal ?? 0);
      const bo = Number(b.ordinal ?? 0);
      if (Number.isFinite(ao) && Number.isFinite(bo)) return ao - bo;
      return 0;
    });
  // Suppress unused-arg lint warning.
  void kind;
  return { values, sortedByOrdinal };
}

function moonReferenceDateToWire(ref) {
  if (!ref || typeof ref !== 'object') {
    return { year: 0, month: 1, day: 1 };
  }
  return {
    year:  toIntOr(ref.year,       0),
    month: toIntOr(ref.month,      0) + 1,
    day:   toIntOr(ref.dayOfMonth, 0) + 1,
  };
}

function extractPhases(phases) {
  if (!phases || typeof phases !== 'object') return [];
  return Object.entries(phases).map(([id, p]) => ({
    id,
    name:  String(p?.name || ''),
    icon:  String(p?.icon || ''),
    start: Number.isFinite(p?.start) ? Number(p.start) : 0,
    end:   Number.isFinite(p?.end)   ? Number(p.end)   : 0,
  }));
}

function toIntOr(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}
