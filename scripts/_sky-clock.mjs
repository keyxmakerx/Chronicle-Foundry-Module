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

/* ── The weather on the stone ── */

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/** '#rrggbb' as [r, g, b] (0..255), or null. */
export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Magic weathers that glow out of the stone's cracks, and the colour each glows. */
const GLOWS = {
  aurora: (R) => R.aurora[0]?.c0, aether: (R) => R.air[0]?.c, divine: (R) => R.air[0]?.c,
  arcane: (R) => R.parts[0]?.c, 'arcane-wind': (R) => R.air[0]?.c, // Ley light is white motes in many colours; on stone it reads as violet.
  'ley-surge': () => '#9d8cff',
  spectral: (R) => R.parts[0]?.c, veil: (R) => R.air[0]?.c, void: (R) => R.air[0]?.c,
  sigils: (R) => R.sigils[0]?.c, motes: (R) => R.parts[0]?.c, sparks: (R) => R.parts[0]?.c2,
  embers: (R) => R.parts[0]?.c, meteors: (R) => R.fire[0]?.c, miasma: (R) => R.air[0]?.c,
  spores: (R) => R.parts[0]?.c,
};

/** Particles that settle on the stone's tops as dust, and ones that come to rest on it whole. */
const DUSTS = { grain: 1, ash: 1, debris: 0.8 };
const LITTER = { leaf: 1, petal: 1 };

/**
 * How a weather marks the stone figure, read from the sky's own recipe for it
 * (`SkyLooks.resolve`), so every weather Chronicle's sky can draw (its
 * built-ins and a campaign's own) leaves its mark, and none is left over when
 * it clears. Each number is 0..1; colours are [r, g, b].
 *   wet: darker stone with a sheen, and drops running down it (drip: their colour)
 *   snow / hail: settled on the tops; rime: frost along every edge
 *   dew: beads that catch the light, in fog and mist
 *   dust: sand, ash or grit settled on the tops; soot: smoke-darkened stone
 *   litter: leaves or petals resting on the tops
 *   glow: magic glowing out of the cracks; heat: sun-bleached, dry stone
 *   grey: colour drained out
 */
export function stoneWeather(R) {
  const S = {
    wet: 0, drip: null, snow: 0, hail: 0, rime: 0, dew: 0, dust: null, soot: 0,
    litter: null, glow: null, heat: 0, grey: 0,
  };
  if (!R) return S;
  const fx = Array.isArray(R.effects) ? R.effects : [];
  const parts = Array.isArray(R.parts) ? R.parts : [];
  const has = (id) => fx.includes(id);
  S.wet = clamp01(0.8 * (R.rain || 0) + 0.3 * (R.hail || 0) + 0.2 * (R.storm || 0));
  if (S.wet > 0) S.drip = hexRgb(R.rainTint?.[0]) || [200, 214, 238];
  S.snow = clamp01(R.snow);
  S.hail = clamp01(R.hail);
  S.rime = clamp01((has('ice') ? 0.9 : 0) + (has('snow-heavy') ? 0.4 : 0));
  for (const p of parts) {
    if (DUSTS[p.p] && !S.dust) S.dust = { c: hexRgb(p.c) || [150, 140, 120], k: clamp01((p.a ?? 1) * DUSTS[p.p] * (p.mode === 'blow' && p.n < 60 ? 0.45 : 1)) };
    if (LITTER[p.p] && !S.litter) S.litter = { kind: p.p, c: hexRgb(p.c) || [190, 110, 50], c2: hexRgb(p.c2) || hexRgb(p.c) || [220, 160, 60], k: clamp01(p.a ?? 1) };
  }
  S.soot = clamp01((has('smoke') ? 0.6 : 0) + (has('ashfall') ? 0.35 : 0) + (has('embers') ? 0.25 : 0));
  for (const id of fx) {
    const pick = GLOWS[id];
    const c = pick && hexRgb(pick({ aurora: [], air: [], parts: [], sigils: [], fire: [], ...R }));
    if (c) { S.glow = { c, k: id === 'void' ? 0.55 : 0.8 }; break; }
  }
  S.heat = has('haze') ? 1 : 0;
  S.grey = clamp01(R.grey);
  // Dew only from wet air: dust, smoke and heat haze thicken the air too, but leave the stone dry.
  S.dew = S.dust || S.soot || S.heat ? 0 : clamp01((R.fog || 0) * (1 - S.wet) * (1 - S.snow) * 0.9);
  return S;
}

/** What falls in front of the figure, from the same recipe: rain (tinted), snow, hail, storm and fog. */
export function frontOf(R) {
  if (!R) return { rain: 0, snow: 0, hail: 0, storm: 0, fog: 0, tint: null };
  return {
    rain: Math.max(0, Math.min(1.6, R.rain || 0)),
    snow: Math.max(0, Math.min(1.6, R.snow || 0)),
    hail: clamp01(R.hail),
    storm: clamp01(R.storm),
    fog: clamp01(R.fog),
    tint: hexRgb(R.rainTint?.[0]),
  };
}

/**
 * A stand-in recipe for when Chronicle's sky has not loaded: the five front
 * weathers `frontWeather` tells apart, as the dials the sky would give them.
 */
export function plainRecipe(kind) {
  const R = { rain: 0, snow: 0, hail: 0, storm: 0, fog: 0, grey: 0, effects: [], parts: [], air: [], aurora: [], sigils: [], fire: [], rainTint: null, sky: null };
  if (kind === 'rain') { R.rain = 1; R.effects = ['rain']; }
  if (kind === 'storm') { R.rain = 1.25; R.storm = 1; R.effects = ['lightning']; }
  if (kind === 'snow') { R.snow = 1; R.effects = ['snow']; }
  if (kind === 'fog') { R.fog = 1; R.effects = ['fog']; }
  return R;
}

/**
 * Two weathers part of the way from one to the other, so a change rolls
 * across the stone as it does in the sky. Numbers ease across; a colour
 * comes from whichever side shows more.
 */
export function mixWeather(a, b, t) {
  if (!a) return b; if (!b) return a;
  const k = clamp01(t);
  if (k <= 0) return a; if (k >= 1) return b;
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key]; const y = b[key];
    if (typeof x === 'number' || typeof y === 'number') out[key] = (x || 0) * (1 - k) + (y || 0) * k;
    else if (x && y && typeof x === 'object' && !Array.isArray(x)) out[key] = { ...(k < 0.5 ? x : y), k: (x.k || 0) * (1 - k) + (y.k || 0) * k };
    else if (x && !y && typeof x === 'object' && !Array.isArray(x)) out[key] = { ...x, k: (x.k || 0) * (1 - k) };
    else if (y && !x && typeof y === 'object' && !Array.isArray(y)) out[key] = { ...y, k: (y.k || 0) * k };
    else out[key] = k < 0.5 ? (x ?? y ?? null) : (y ?? x ?? null);
  }
  return out;
}

/** The most drops the glass carries at once, in the heaviest rain. */
export const GLASS_DROPS = 9;

function hash(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

/**
 * Raindrops landing on the globe's glass at time `t` (seconds): each lands,
 * lingers, slides a little and fades, then lands somewhere else. Positions
 * are fractions of the globe (0.5, 0.5 is its centre) and keep to the outer
 * ring, so a drop never sits over the day figure. `wet` is the rain and
 * storm together; none fall below a drizzle's worth.
 */
export function glassDrops(wet, t) {
  const n = Math.round(GLASS_DROPS * Math.min(1, Math.max(0, (Number(wet) || 0) - 0.15) / 1.1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const life = 3.5 + hash(i, 500) * 4; const c = t / life + hash(i, 501); const cycle = Math.floor(c); const age = c - cycle;
    const ang = (0.08 + hash(cycle, 502 + i) * 0.84) * Math.PI * 2; const rad = 0.36 + hash(cycle, 520 + i) * 0.1;
    const r = 0.011 + hash(cycle, 540 + i) * 0.012;
    // Bigger drops run a short way down the glass before they go.
    const slide = r > 0.017 ? age * age * 0.06 : 0;
    const a = Math.min(1, age / 0.06) * (1 - Math.max(0, (age - 0.7) / 0.3));
    out.push({ x: 0.5 + Math.cos(ang) * rad, y: 0.5 + Math.sin(ang) * rad + slide, r, a, trail: slide });
  }
  return out;
}
