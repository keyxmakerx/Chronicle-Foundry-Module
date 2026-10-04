/**
 * Chronicle's calendar date math, so the Foundry calendar places days,
 * weekdays and leap days exactly where Chronicle's own calendar page does.
 * A port of the `CalDate` object in Chronicle's
 * `static/js/widgets/calendar_view.js` (itself a mirror of the Go model);
 * every function keeps its Chronicle name and behavior. `cal` is the
 * `GET /calendar` JSON. Months are 1-based unless a name says `month0`.
 *
 * `tools/test-chronicle-caldate.mjs` compares this file with Chronicle's
 * copy whenever CHRONICLE_DIR points at a Chronicle checkout.
 */

export function mod(a, n) { return ((a % n) + n) % n; }

export function usesRealTime(cal) {
  return cal.mode === 'reallife' && !!cal.tracks_real_time;
}

export function monthDaysNative(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function yearLength(cal) {
  let total = 0;
  for (const m of cal.months || []) total += m.days;
  return total;
}

export function isLeapYear(cal, year) {
  if (!cal.leap_year_every || cal.leap_year_every <= 0) return false;
  return mod(year - cal.leap_year_offset, cal.leap_year_every) === 0;
}

export function monthDays(cal, month0, year) {
  const months = cal.months || [];
  if (month0 < 0 || month0 >= months.length) return 0;
  if (usesRealTime(cal)) return monthDaysNative(year, month0 + 1);
  let days = months[month0].days;
  if (isLeapYear(cal, year)) days += (months[month0].leap_year_days || 0);
  return days;
}

export function constLenDayIndex(cal, year, month1, day) {
  const months = cal.months || [];
  let abs = year * yearLength(cal);
  for (let i = 0; i < month1 - 1 && i < months.length; i++) abs += months[i].days;
  return abs + day;
}

export function leapExtraDays(cal) {
  let total = 0;
  for (const m of cal.months || []) total += (m.leap_year_days || 0);
  return total;
}

export function leapYearsBefore(cal, year) {
  const e = cal.leap_year_every;
  if (!e || e <= 0 || year <= 0) return 0;
  const r = mod(cal.leap_year_offset, e);
  if (year <= r) return 0;
  return Math.floor((year - 1 - r) / e) + 1;
}

export function absoluteDay(cal, year, month1, day) {
  let total = 0;
  if (year > 0) {
    total = year * yearLength(cal);
    const extra = leapExtraDays(cal);
    if (extra) total += extra * leapYearsBefore(cal, year);
  }
  const months = cal.months || [];
  for (let i = 0; i < month1 - 1 && i < months.length; i++) total += monthDays(cal, i, year);
  return total + day;
}

export function gregorianJDN(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** The one day counter weekdays, moons and comparisons go through. */
export function dayIndex(cal, year, month1, day) {
  if (usesRealTime(cal)) return gregorianJDN(year, month1, day);
  if (year <= 0) return constLenDayIndex(cal, year, month1, day);
  return absoluteDay(cal, year, month1, day);
}

export function weekLen(cal) { return (cal.weekdays || []).length || 7; }

export function monthIsIntercalary(cal, month1) {
  const months = cal.months || [];
  const i = month1 - 1;
  if (i < 0 || i >= months.length) return false;
  return !!months[i].is_intercalary;
}

/** Weekday column of a date, or -1 for a festival day that belongs to no week. */
export function weekdayCol(cal, year, month1, day) {
  const wl = weekLen(cal);
  if (wl <= 0) return 0;
  if (cal.month_starts_new_week && !usesRealTime(cal)) {
    if (monthIsIntercalary(cal, month1)) return -1;
    return mod(day - 1, wl);
  }
  return mod(dayIndex(cal, year, month1, day), wl);
}

export function monthCount(cal) { return (cal.months || []).length || 12; }

/** Walk {y,m,d} by `delta` days using the leap-aware month lengths. */
export function addDays(cal, date, delta) {
  let { y, m, d } = date;
  const mc = monthCount(cal);
  const n = Math.abs(delta);
  const step = delta > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    if (step > 0) {
      const len = monthDays(cal, m - 1, y);
      d++;
      if (d > len) { d = 1; m++; if (m > mc) { m = 1; y++; } }
    } else {
      d--;
      if (d < 1) { m--; if (m < 1) { m = mc; y--; } d = monthDays(cal, m - 1, y); }
    }
  }
  return { y, m, d };
}

export function shiftMonth(cal, year, month1, delta) {
  const mc = monthCount(cal);
  let m = month1 - 1 + delta;
  let y = year;
  while (m < 0) { m += mc; y--; }
  while (m >= mc) { m -= mc; y++; }
  return { y, m: m + 1 };
}
