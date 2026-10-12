/**
 * Chronicle Sync - Sky Clock, the pure parts
 *
 * What the Sky Clock (`sky-clock.mjs`) decides without a page: which corner a
 * dropped globe settles in, how its GM cradle sits there, the calendar it
 * hands Chronicle's sky code, which weather falls in front of the day
 * figure, and how many frames a second it may draw. Each is unit-tested by
 * `tools/test-sky-clock.mjs`.
 */

/** The globe's full size and its shrunk size, in CSS pixels. */
export const GLOBE = 116;
export const MINI = 52;

/** How far the cradle's buttons reach past the globe's edge, each side. */
export const CRADLE_SPARE = 41;

/** Gap kept between the globe and the edge of the free space. */
export const INSET = 12;

const CORNERS = ['tl', 'tr', 'bl', 'br'];

/** A saved corner, or the top right one. */
export function cornerOf(value) {
  return CORNERS.includes(value) ? value : 'tr';
}

/**
 * Where the globe sits in each corner. `free` is the part of the window
 * Foundry's own interface leaves clear ({left, top, right, bottom}, in
 * window pixels), so the globe never covers the sidebar or the tool bar.
 */
export function cornerSpots(free, size) {
  const l = free.left + INSET;
  const r = Math.max(l, free.right - size - INSET);
  const t = free.top + INSET;
  const b = Math.max(t, free.bottom - size - INSET);
  return { tl: { x: l, y: t }, tr: { x: r, y: t }, bl: { x: l, y: b }, br: { x: r, y: b } };
}

/** The corner nearest a globe dropped at `at` (its top-left point). */
export function nearestCorner(at, free, size) {
  const spots = cornerSpots(free, size);
  let best = 'tr';
  let bd = Infinity;
  for (const k of CORNERS) {
    const d = Math.hypot(spots[k].x - at.x, spots[k].y - at.y);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** Arrow keys move the globe to the corner that way. */
export function cornerByKey(corner, key) {
  let v = cornerOf(corner)[0];
  let h = cornerOf(corner)[1];
  if (key === 'ArrowUp') v = 't';
  else if (key === 'ArrowDown') v = 'b';
  else if (key === 'ArrowLeft') h = 'l';
  else if (key === 'ArrowRight') h = 'r';
  else return null;
  return v + h;
}

/**
 * How the GM's cradle sits: it holds the globe from below, or from above in a
 * bottom corner, where below would be off the screen. It is wider than the
 * globe, so beside the edge of the free space the globe moves inward by
 * `nudge` pixels while the cradle is open.
 */
export function cradleLayout(corner, spot, free, size = GLOBE) {
  const up = cornerOf(corner)[0] === 'b';
  let nudge = 0;
  const minX = free.left + 6;
  const maxX = free.right - 6;
  if (spot.x - CRADLE_SPARE < minX) nudge = minX - (spot.x - CRADLE_SPARE);
  else if (spot.x + size + CRADLE_SPARE > maxX) nudge = maxX - (spot.x + size + CRADLE_SPARE);
  return { up, nudge: Math.round(nudge) };
}

/**
 * The calendar as Chronicle's sky code reads it (the shape of `GET
 * /calendar` with its `current_*` fields): the view's calendar at the view's
 * date, with the day's weather. Null when there is nothing to draw.
 */
export function skyCalendar(view) {
  const cal = view?.calendar;
  const d = view?.date;
  if (!cal || !d || !Array.isArray(cal.months) || !cal.months.length) return null;
  return {
    mode: cal.mode,
    tracks_real_time: !!cal.tracks_real_time,
    hemisphere: cal.hemisphere === 'south' ? 'south' : 'north',
    hours_per_day: cal.hours_per_day,
    minutes_per_hour: cal.minutes_per_hour,
    leap_year_every: cal.leap_year_every,
    leap_year_offset: cal.leap_year_offset,
    months: cal.months,
    moons: Array.isArray(view.skyMoons) ? view.skyMoons : (cal.moons || []),
    current_year: d.year,
    current_month: d.month,
    current_day: d.day,
    current_hour: d.hour ?? 0,
    current_minute: d.minute ?? 0,
    weather: skyWeather(view),
  };
}

/**
 * The weather the sky draws: the day's own reading when the view has one,
 * as Chronicle's sky pane does, else the calendar's current weather.
 */
export function skyWeather(view) {
  const d = view?.date;
  const day = d && (view.dayWeather || []).find((w) => w.year === d.year && w.month === d.month && w.day === d.day);
  const w = day || view?.weather;
  if (!w) return null;
  return {
    preset_id: w.preset_id || undefined,
    preset_label: w.preset_label || w.label || undefined,
    icon: w.icon || undefined,
    precipitation: w.precipitation || undefined,
  };
}

/**
 * The day's moon-night events (a blood moon, an eclipse) as the sky code's
 * `parseDayEvents` reads them: each event's `payload` is a JSON string.
 */
export function skyEvents(view) {
  const d = view?.date;
  if (!d) return [];
  return (view.events || [])
    .filter((e) => e.year === d.year && e.month === d.month && e.day === d.day)
    .map((e) => (e.sky ? { ...e, payload: JSON.stringify(e.sky) } : e))
    .filter((e) => typeof e.payload === 'string');
}

/**
 * What falls in front of the day figure, from the weather's icon, preset or
 * precipitation: snow, rain, storm, fog, or nothing.
 */
export function frontWeather(w) {
  if (!w) return 'clear';
  const icon = String(w.icon || '').toLowerCase();
  const id = String(w.preset_id || '').toLowerCase();
  const type = String(w.precipitation?.type || '').toLowerCase();
  const all = `${icon} ${id} ${type}`;
  if (/storm|thunder|lightning/.test(all)) return 'storm';
  if (/snow|blizzard|sleet/.test(all)) return 'snow';
  if (/rain|drizzle|monsoon|hail|shower/.test(all)) return 'rain';
  if (/fog|mist|smog|haze/.test(all)) return 'fog';
  return 'clear';
}

/** Frames a second for the globe's loop. */
export const FPS = Object.freeze({ idle: 12, falling: 20, moving: 30 });

/**
 * How many frames a second to draw: none while hidden, shrunk, still or
 * resting; the full rate while something moves (a shake settling, the sky
 * gliding to a new time, a day changing); a middle rate while rain or snow
 * falls or the sky itself has moving weather; the idle rate otherwise.
 * `skyPace` is the sky code's own 0 / 1 / 2.
 */
export function framesPerSecond({ hidden, mini, still, resting, moving, falling, skyPace }) {
  if (hidden || still) return 0;
  if (moving) return FPS.moving;
  if (mini || resting) return 0;
  if (falling || skyPace === 2) return FPS.falling;
  return FPS.idle;
}

/**
 * Where the light on the day figure comes from: the sun while it is up,
 * else the brightest risen moon, as a point in the globe (0..1) with a
 * strength (0..1) and whether it is warm (sunlight). `st` is the sky code's
 * frame state.
 */
export function figureLight(st) {
  if (!st) return { x: 0.5, y: 0, k: 0.2, warm: false };
  const W = st.W || 1;
  const H = st.H || 1;
  const altDeg = Number(st.altEff) || 0;
  if (altDeg > -2 && st.sp) {
    const k = Math.max(0, Math.min(1, (altDeg + 2) / 20)) * Math.max(0.3, Math.min(1, st.wx?.light ?? 1));
    return { x: st.sp.x / W, y: st.sp.y / H, k, warm: true };
  }
  const moon = (st.moons || []).filter((m) => m.up && m.m && m.m.alt > 0)
    .sort((a, b) => b.m.lit * (b.mo?.size || 1) - a.m.lit * (a.mo?.size || 1))[0];
  if (moon) return { x: moon.x / W, y: moon.y / H, k: 0.2 + 0.35 * moon.m.lit, warm: false };
  return { x: 0.5, y: 0, k: 0.2, warm: false };
}

/**
 * Moves a corner spot clear of Foundry's own panels (`rects`, each {left,
 * top, right, bottom}): down past one in a top corner, up past one in a
 * bottom corner. A panel beside the spot, not across it, is left alone.
 */
export function clearOf(spot, size, rects, corner) {
  const top = cornerOf(corner)[0] === 't';
  let y = spot.y;
  // Two passes, since moving past one panel can land on another.
  for (let pass = 0; pass < 2; pass++) {
    for (const r of rects || []) {
      if (!r || r.right <= spot.x || r.left >= spot.x + size) continue;
      if (r.bottom <= y || r.top >= y + size) continue;
      y = top ? r.bottom + INSET : r.top - size - INSET;
    }
  }
  return { x: spot.x, y: Math.round(y) };
}
