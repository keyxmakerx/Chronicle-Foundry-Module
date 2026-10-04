/**
 * The built-in calendar's pure logic: stepping a date, labels, the month
 * grid, the sky colour for the hour, and the player-safe snapshot the GM's
 * client shares with every player. No Foundry globals, so all of it is
 * unit-tested by `tools/test-calendar-view-model.mjs`.
 *
 * `cal` is the `GET /calendar` JSON (or the snapshot's copy of it); a date is
 * `{year, month, day, hour, minute}` with 1-based month and day.
 */

import {
  addDays, monthDays, monthCount, weekdayCol, weekLen, shiftMonth,
} from './_chronicle-caldate.mjs';

/** Steps the GM can move the date by. */
export const STEP_UNITS = Object.freeze(['hour', 'day', 'week']);

/** Snapshot format; a player client ignores any other version. */
export const SNAPSHOT_VERSION = 1;

/** Events kept in the snapshot, so the world setting stays small. */
export const SNAPSHOT_EVENT_LIMIT = 300;

function hoursPerDay(cal) {
  const h = Number(cal?.hours_per_day);
  return Number.isFinite(h) && h > 0 ? Math.floor(h) : 24;
}

function minutesPerHour(cal) {
  const m = Number(cal?.minutes_per_hour);
  return Number.isFinite(m) && m > 0 ? Math.floor(m) : 60;
}

/**
 * Move `date` by `n` steps of `unit` ('hour' | 'day' | 'week'), carrying
 * hours into days with the calendar's own day length and walking days with
 * Chronicle's leap-aware month lengths. Unknown units leave the date as is.
 */
export function stepDate(cal, date, unit, n = 1) {
  if (!cal || !date) return date;
  const out = { ...date, hour: date.hour ?? 0, minute: date.minute ?? 0 };
  const count = Math.trunc(Number(n) || 0);
  let dayDelta = 0;
  if (unit === 'hour') {
    const hpd = hoursPerDay(cal);
    const total = out.hour + count;
    dayDelta = Math.floor(total / hpd);
    out.hour = ((total % hpd) + hpd) % hpd;
  } else if (unit === 'day') {
    dayDelta = count;
  } else if (unit === 'week') {
    dayDelta = count * weekLen(cal);
  } else {
    return date;
  }
  if (dayDelta) {
    const d = addDays(cal, { y: out.year, m: out.month, d: out.day }, dayDelta);
    out.year = d.y; out.month = d.m; out.day = d.d;
  }
  return out;
}

/** Clamp a hand-entered date into the calendar, or null when it can't fit. */
export function clampDate(cal, date) {
  if (!cal || !date) return null;
  const year = Math.trunc(Number(date.year));
  const month = Math.trunc(Number(date.month));
  const day = Math.trunc(Number(date.day));
  if (![year, month, day].every(Number.isFinite)) return null;
  if (month < 1 || month > monthCount(cal)) return null;
  const len = monthDays(cal, month - 1, year);
  if (day < 1 || day > len) return null;
  const hour = Math.min(Math.max(Math.trunc(Number(date.hour) || 0), 0), hoursPerDay(cal) - 1);
  const minute = Math.min(Math.max(Math.trunc(Number(date.minute) || 0), 0), minutesPerHour(cal) - 1);
  return { year, month, day, hour, minute };
}

export function monthName(cal, month) {
  return cal?.months?.[month - 1]?.name || String(month);
}

/** "7 Mirtul 1492" — day, month name, year, the order Chronicle's pages use. */
export function formatDate(cal, date) {
  if (!date) return '';
  return `${date.day} ${monthName(cal, date.month)} ${date.year}`;
}

/** "14:05", padded to the calendar's own minute width. */
export function formatTime(cal, date) {
  if (!date) return '';
  const width = String(minutesPerHour(cal) - 1).length;
  return `${String(date.hour ?? 0).padStart(2, '0')}:${String(date.minute ?? 0).padStart(Math.max(width, 2), '0')}`;
}

/** Weekday name for a date, or '' on a festival day outside the week. */
export function weekdayName(cal, date) {
  if (!date) return '';
  const col = weekdayCol(cal, date.year, date.month, date.day);
  if (col < 0) return '';
  return cal?.weekdays?.[col]?.name || '';
}

/**
 * The month view: weekday headers and rows of day cells (null pads the
 * first and last week). A festival month outside the week
 * (`month_starts_new_week`) is one plain row of its days.
 */
export function monthGrid(cal, year, month) {
  const len = monthDays(cal, month - 1, year);
  const wl = weekLen(cal);
  const headers = Array.from({ length: wl }, (_, i) => cal?.weekdays?.[i]?.name || '');
  if (weekdayCol(cal, year, month, 1) < 0) {
    return { year, month, name: monthName(cal, month), headers: [], festival: true,
      rows: [Array.from({ length: len }, (_, i) => i + 1)] };
  }
  const rows = [];
  let row = new Array(wl).fill(null);
  for (let d = 1; d <= len; d++) {
    const col = weekdayCol(cal, year, month, d);
    if (d > 1 && col === 0) { rows.push(row); row = new Array(wl).fill(null); }
    row[col] = d;
  }
  rows.push(row);
  return { year, month, name: monthName(cal, month), headers, festival: false, rows };
}

export { shiftMonth };

/**
 * Sky colours for the bar at an hour, scaled to the calendar's day length:
 * night, dawn, day and dusk, matching the sky pane's palette.
 */
const SKY = Object.freeze({
  night: ['#0b1026', '#1b2350'],
  dawn: ['#3a2a5c', '#e08a5b'],
  day: ['#2f6fb5', '#8fc3ea'],
  dusk: ['#47306b', '#d2694a'],
});

export function skyPhase(cal, hour) {
  const f = (Number(hour) || 0) / hoursPerDay(cal);
  if (f < 0.21 || f >= 0.85) return 'night';
  if (f < 0.3) return 'dawn';
  if (f < 0.75) return 'day';
  return 'dusk';
}

export function skyGradient(cal, hour) {
  const [a, b] = SKY[skyPhase(cal, hour)];
  return `linear-gradient(90deg, ${a}, ${b})`;
}

/** Only `#rgb`/`#rrggbb` colours reach a style attribute. */
export function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : null;
}

const WEATHER_ICONS = Object.freeze({
  clear: 'fa-sun', cloud: 'fa-cloud', rain: 'fa-cloud-rain', snow: 'fa-snowflake', storm: 'fa-cloud-bolt', fog: 'fa-smog',
});

/** Font Awesome class for a weather reading, as Chronicle's calendar draws it. */
export function weatherIconClass(icon) {
  return WEATHER_ICONS[icon] || 'fa-cloud-sun';
}

/** Font Awesome classes for a moon phase icon from Chronicle. */
export function moonIconClass(phaseIcon) {
  if (phaseIcon === 'circle-dot') return 'fa-regular fa-circle';
  if (phaseIcon === 'moon') return 'fa-solid fa-circle';
  return 'fa-solid fa-moon';
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The structure a client needs to draw the month view, nothing more. */
export function snapshotCalendar(cal) {
  if (!cal) return null;
  return {
    mode: str(cal.mode, 40),
    tracks_real_time: !!cal.tracks_real_time,
    hours_per_day: hoursPerDay(cal),
    minutes_per_hour: minutesPerHour(cal),
    leap_year_every: num(cal.leap_year_every) ?? 0,
    leap_year_offset: num(cal.leap_year_offset) ?? 0,
    month_starts_new_week: !!cal.month_starts_new_week,
    months: (cal.months || []).map((m) => ({
      name: str(m.name, 80) || '',
      days: Math.max(0, Math.trunc(num(m.days) ?? 0)),
      is_intercalary: !!m.is_intercalary,
      leap_year_days: Math.max(0, Math.trunc(num(m.leap_year_days) ?? 0)),
    })),
    weekdays: (cal.weekdays || []).map((w) => ({ name: str(w.name, 80) || '' })),
  };
}

/**
 * Is a calendar (as `GET /calendar` serves it) shown to every player? False
 * for a GM-only calendar and for one limited to named players; fails closed
 * on rules it cannot read.
 */
export function calendarOpenToPlayers(cal) {
  if (!cal) return false;
  if (cal.visibility !== undefined && cal.visibility !== null && cal.visibility !== 'everyone') return false;
  const raw = cal.visibility_rules;
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return true;
  let rules = raw;
  if (typeof raw === 'string') {
    try { rules = JSON.parse(raw); } catch { return false; }
  }
  if (rules === null) return true;
  if (typeof rules !== 'object' || Array.isArray(rules)) return false;
  const named = (list) => Array.isArray(list) && list.length > 0;
  return !named(rules.allowed_users) && !named(rules.denied_users);
}

/**
 * Build what every player sees, from reads made with `?audience=players`.
 * Chronicle applies its player rules to those and says so by echoing
 * `"audience":"players"`; an older Chronicle ignores the parameter and
 * answers with the GM's view, so without that echo the moons, era and events
 * are left out. Fails closed on top: an event that is not plainly public
 * (`isPublic`) is dropped, and each kept field is copied by name, never
 * spread, so nothing Chronicle adds later reaches players by accident.
 *
 * @param {object} p
 * @param {object|null} p.calendar - GET /calendar, or null when players can't see it.
 * @param {object|null} p.dateInfo - players-audience GET /calendar/date.
 * @param {object[]} p.events - players-audience events.
 * @param {boolean} p.eventsConfirmed - every events page echoed the players audience.
 * @param {(e:object)=>boolean} p.isPublic - isChronicleEventPublic.
 */
export function buildPlayerSnapshot({
  calendar, dateInfo, events = [], eventsConfirmed = false, isPublic, dayWeather = [], dayWeatherConfirmed = false,
}) {
  if (!calendarOpenToPlayers(calendar) || !dateInfo) return { v: SNAPSHOT_VERSION, hidden: true };
  const filtered = dateInfo.audience === 'players';
  const w = dateInfo.current_weather;
  const keep = eventsConfirmed && typeof isPublic === 'function' ? events.filter((e) => isPublic(e)) : [];
  return {
    v: SNAPSHOT_VERSION,
    hidden: false,
    calendar: snapshotCalendar(calendar),
    date: {
      year: num(dateInfo.year) ?? 0,
      month: num(dateInfo.month) ?? 1,
      day: num(dateInfo.day) ?? 1,
      hour: num(dateInfo.hour) ?? 0,
      minute: num(dateInfo.minute) ?? 0,
    },
    season: dateInfo.current_season
      ? { name: str(dateInfo.current_season.name, 80), color: safeColor(dateInfo.current_season.color) }
      : null,
    era: filtered && dateInfo.current_era ? { name: str(dateInfo.current_era.name, 80) } : null,
    weather: w
      ? {
        label: str(w.preset_label, 80) || str(w.description, 80),
        icon: str(w.icon, 20),
        color: safeColor(w.color),
        temperature_celsius: num(w.temperature_celsius),
      }
      : null,
    moons: filtered
      ? (dateInfo.current_moon_phases || []).map((m) => ({
        name: str(m.moon_name, 80), phase_name: str(m.phase_name, 80), phase_icon: str(m.phase_icon, 40),
      }))
      : [],
    events: keep.slice(0, SNAPSHOT_EVENT_LIMIT).map(snapshotEvent),
    dayWeather: dayWeatherConfirmed ? pastDayWeather(dayWeather, dateInfo) : [],
  };
}

/**
 * Day readings up to `today`, reduced to what the month view draws. Chronicle
 * already holds future days back from players; this drops them again so a
 * forecast can never reach the snapshot.
 */
export function pastDayWeather(days, today) {
  const t = today && [num(today.year), num(today.month), num(today.day)];
  if (!t || t.some((v) => v === null)) return [];
  const onOrBefore = (d) => d.year < t[0] || (d.year === t[0] && (d.month < t[1] || (d.month === t[1] && d.day <= t[2])));
  return (days || [])
    .map((d) => ({ year: num(d?.year), month: num(d?.month), day: num(d?.day), icon: str(d?.icon, 20), label: str(d?.preset_label, 80) || str(d?.description, 80) }))
    .filter((d) => d.year !== null && d.month !== null && d.day !== null && onOrBefore(d))
    .slice(0, SNAPSHOT_EVENT_LIMIT);
}

/** Background for a day cell: the sky that weather gives. */
const DAY_SKY = Object.freeze({
  clear: 'linear-gradient(#9cc7ea, #dfeaf2)',
  cloud: 'linear-gradient(#7d8fa3, #b9c3cc)',
  rain: 'linear-gradient(#5b6b80, #9aa6b4)',
  snow: 'linear-gradient(#c9d6e2, #eef1f4)',
  storm: 'linear-gradient(#4b5a73, #8b97a6)',
  fog: 'linear-gradient(#a7adb3, #d3d6d9)',
});

export function daySky(icon) {
  return DAY_SKY[icon] || DAY_SKY.cloud;
}

/** Which particles the strip's mini sky shows for a weather icon and hour. */
export function skyParticles(cal, hour, icon) {
  if (icon === 'snow') return 'snow';
  if (icon === 'rain' || icon === 'storm') return 'rain';
  const phase = skyPhase(cal, hour);
  if ((phase === 'night') && icon !== 'fog') return 'stars';
  return 'none';
}

/** Keep a dragged strip on screen. */
export function clampPlace(place, box, viewport) {
  const x = Math.min(Math.max(Number(place?.x) || 0, 0), Math.max(viewport.width - box.width, 0));
  const y = Math.min(Math.max(Number(place?.y) || 0, 0), Math.max(viewport.height - box.height, 0));
  return { x: Math.round(x), y: Math.round(y) };
}

/** The fields the month view shows for an event. */
export function snapshotEvent(e) {
  return {
    id: str(String(e.id), 80),
    name: str(e.name, 120) || '',
    year: num(e.year), month: num(e.month), day: num(e.day),
    start_hour: num(e.start_hour), start_minute: num(e.start_minute),
    all_day: !!e.all_day,
    color: safeColor(e.color),
  };
}

/** Events on one day of a list, ordered by start time (all-day first). */
export function eventsOn(events, year, month, day) {
  return (events || [])
    .filter((e) => e.year === year && e.month === month && e.day === day)
    .sort((a, b) => ((a.all_day ? -1 : a.start_hour ?? -1) - (b.all_day ? -1 : b.start_hour ?? -1))
      || ((a.start_minute ?? 0) - (b.start_minute ?? 0)));
}

/** Is a snapshot something a player client should draw? */
export function isUsableSnapshot(s) {
  return !!s && s.v === SNAPSHOT_VERSION && !s.hidden && !!s.calendar && !!s.date
    && Array.isArray(s.calendar.months) && s.calendar.months.length > 0;
}

/** Same date to the minute? */
export function sameDate(a, b) {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day
    && (a.hour ?? 0) === (b.hour ?? 0) && (a.minute ?? 0) === (b.minute ?? 0);
}

/** Temperature label in the reader's unit. */
export function formatTemperature(celsius, unit = 'C') {
  if (celsius === null || celsius === undefined || !Number.isFinite(Number(celsius))) return '';
  const c = Number(celsius);
  return unit === 'F' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
}
