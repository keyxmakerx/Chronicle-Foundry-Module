/**
 * Chronicle Sync — calendar sub-resource projection (FM-SYNC-SUBRESOURCES-P1).
 *
 * Chronicle broadcasts eleven `calendar.*` WebSocket types; before this file
 * the module's handler switch (`calendar-sync.mjs` `onMessage`) matched four
 * of them — date + the three event-CRUD types — and every other type fell off
 * the end of the switch with no `default:`, silently dropped. Weather, season,
 * era, moon phase, cycle, festival and structure changes authored in Chronicle
 * never reached the GM's table.
 *
 * This module holds the PURE half of the fix: payload normalization, the
 * human-readable one-liners the chat/dashboard surfaces render, and the
 * reducer that maintains the "last known sub-resource state" snapshot the
 * dashboard's Calendar tab reads. Everything that touches Foundry globals
 * (ChatMessage, CALENDARIA.api, ui.notifications) stays in `calendar-sync.mjs`
 * so this file is unit-testable off-DOM (house pattern: `_overview-model.mjs`,
 * `_calendar-sync-state.mjs`).
 *
 * ## Payload shapes (verified against Chronicle main, 2026-07-25)
 *
 * Producers live in `internal/plugins/calendar/service.go` +
 * `worldstate_service.go`; the wire names are assigned by
 * `calendarEventPublisherAdapter.PublishCalendarEvent`
 * (`internal/app/routes.go`).
 *
 * | Type                          | Payload                                              |
 * |-------------------------------|------------------------------------------------------|
 * | `calendar.season.changed`     | `{id, name, color}` — **or `null`** when the date left a season without entering another (service.go:2544) |
 * | `calendar.era.changed`        | `{id, name, color}`                                  |
 * | `calendar.moon.phase_changed` | `{moon_id, moon_name, phase_name, phase_position}`   |
 * | `calendar.weather.changed`    | merged `WeatherInput` (FLAT snake_case) — **or `null`** from the weather-zone paths (service.go:1490, :1523) |
 * | `calendar.structure.updated`  | `null`                                               |
 * | `calendar.cycle.changed`      | `null`                                               |
 * | `calendar.festival.changed`   | `null`                                               |
 * | `calendar.worldstate.changed` | `{date:{year,month,day}, moodTint:{color,intensity}}` |
 *
 * Two consequences drive the defensive shape of the code below:
 *
 * 1. **A null payload is normal, not an error.** Four of the eight types can
 *    arrive with `payload: null` by design. Handlers must treat null as "this
 *    changed — refetch if you care", never as a malformed message.
 * 2. **Weather arrives in two different shapes.** The WS payload is the FLAT
 *    `WeatherInput` (`wind_speed_kph`, `precipitation_type`); a refetch of
 *    `GET /calendar/weather` returns the NESTED `Weather` model
 *    (`wind: {speed_kph}`, `precipitation: {type}`). `normalizeWeather` accepts
 *    both so the refetch path and the push path render identically.
 */

/**
 * Every `calendar.*` WebSocket type this module knowingly routes. Used by the
 * `default:` log-once branch to distinguish "a type we deliberately ignore"
 * from "a type Chronicle grew that nobody wired up" — the second is the class
 * of silent drop this whole dispatch exists to end.
 *
 * `calendar.cycle.changed` and `calendar.festival.changed` are listed as
 * *routed* because they are handled by the structure re-compare path: both
 * always fire alongside `calendar.structure.updated` from the same service
 * call (service.go:1594-1595, :1629-1630), so treating them as a second
 * structure signal is correct and avoids a duplicate re-compare.
 */
export const ROUTED_CALENDAR_TYPES = Object.freeze([
  'calendar.date.advanced',
  'calendar.event.created',
  'calendar.event.updated',
  'calendar.event.deleted',
  'calendar.season.changed',
  'calendar.era.changed',
  'calendar.moon.phase_changed',
  'calendar.weather.changed',
  'calendar.worldstate.changed',
  'calendar.structure.updated',
  'calendar.cycle.changed',
  'calendar.festival.changed',
]);

/**
 * Types that mean "Chronicle's calendar structure moved — re-compare". All
 * three fire from the same service calls; `structure.updated` is the umbrella
 * and the other two are the granular siblings added by C-CAL-WS-DOTTED.
 */
export const STRUCTURE_SIGNAL_TYPES = Object.freeze([
  'calendar.structure.updated',
  'calendar.cycle.changed',
  'calendar.festival.changed',
]);

/**
 * Map a sub-resource WS type to the world setting that gates its chat
 * announcement. Returns null for types that never announce.
 *
 * Defaults (registered in `settings.mjs`) follow the dispatch: season/era ON,
 * moon OFF (a moon phase changes every few in-world days — announcing each one
 * is chat spam), weather ON, worldstate ON.
 *
 * @param {string} type
 * @returns {string|null} setting key, or null when the type never announces
 */
export function announceSettingFor(type) {
  switch (type) {
    case 'calendar.weather.changed':    return 'calendarAnnounceWeather';
    case 'calendar.worldstate.changed': return 'calendarAnnounceWorldstate';
    case 'calendar.season.changed':     return 'calendarAnnounceSeasonEra';
    case 'calendar.era.changed':        return 'calendarAnnounceSeasonEra';
    case 'calendar.moon.phase_changed': return 'calendarAnnounceMoon';
    default:                            return null;
  }
}

/**
 * Coerce a possibly-absent value to a trimmed non-empty string, else null.
 * @param {unknown} v
 * @returns {string|null}
 */
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Coerce to a finite number, else null. `Number(null)` is 0, so the explicit
 * null/'' rejection matters: a missing temperature must not render as "0°C".
 * @param {unknown} v
 * @returns {number|null}
 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize either weather shape into one flat record for rendering.
 *
 * Accepts BOTH:
 *   - the WS payload: flat merged `WeatherInput`
 *     (`wind_speed_kph`, `wind_speed_tier`, `wind_direction`,
 *     `precipitation_type`, `precipitation_intensity`)
 *   - a `GET /calendar/weather` response: nested `Weather`
 *     (`wind: {speed_kph, speed_tier, direction}`,
 *     `precipitation: {type, intensity}`)
 *
 * Returns null when the input carries no renderable field at all — the caller
 * treats that as "nothing to announce" rather than posting an empty line.
 *
 * @param {object|null|undefined} raw
 * @returns {{presetLabel:string|null, temperatureC:number|null, windTier:string|null,
 *   windSpeedKph:number|null, windDirection:string|null, precipType:string|null,
 *   precipIntensity:number|null, zoneName:string|null, description:string|null,
 *   icon:string|null}|null}
 */
export function normalizeWeather(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wind = (raw.wind && typeof raw.wind === 'object') ? raw.wind : {};
  const precip = (raw.precipitation && typeof raw.precipitation === 'object') ? raw.precipitation : {};

  const out = {
    presetLabel:     str(raw.preset_label) ?? str(raw.preset_id),
    temperatureC:    num(raw.temperature_celsius),
    windTier:        str(raw.wind_speed_tier) ?? str(wind.speed_tier),
    windSpeedKph:    num(raw.wind_speed_kph) ?? num(wind.speed_kph),
    windDirection:   str(raw.wind_direction) ?? str(wind.direction),
    precipType:      str(raw.precipitation_type) ?? str(precip.type),
    precipIntensity: num(raw.precipitation_intensity) ?? num(precip.intensity),
    zoneName:        str(raw.zone_name) ?? str(raw.zone_id),
    description:     str(raw.description),
    icon:            str(raw.icon),
  };
  const hasAny = Object.entries(out).some(([k, v]) => k !== 'icon' && v !== null);
  return hasAny ? out : null;
}

/**
 * Render a normalized weather record as one GM-facing line.
 *
 * Example: `Chronicle weather: Heavy snow, -8°C, gale from the north,
 * snow (heavy) — North Reach`
 *
 * @param {ReturnType<typeof normalizeWeather>} w
 * @returns {string|null} null when there is nothing worth saying
 */
export function formatWeatherLine(w) {
  if (!w) return null;
  const parts = [];
  if (w.presetLabel) parts.push(w.presetLabel);
  if (w.temperatureC !== null) parts.push(`${w.temperatureC}°C`);
  const windBits = [w.windTier, w.windSpeedKph !== null ? `${w.windSpeedKph} kph` : null]
    .filter(Boolean).join(' ');
  if (windBits) parts.push(w.windDirection ? `${windBits} from ${w.windDirection}` : windBits);
  else if (w.windDirection) parts.push(`wind from ${w.windDirection}`);
  if (w.precipType) {
    parts.push(w.precipIntensity !== null ? `${w.precipType} (${w.precipIntensity})` : w.precipType);
  }
  if (w.description) parts.push(w.description);
  if (!parts.length) return null;
  const zone = w.zoneName ? ` — ${w.zoneName}` : '';
  return `Chronicle weather: ${parts.join(', ')}${zone}`;
}

/**
 * Render `calendar.worldstate.changed` as one GM-facing line.
 *
 * **Known Chronicle-side gap (see this file's header + the PR body):** the
 * payload carries only the date and the ambient mood tint — no meteor/eclipse
 * detail, despite `calendar_celestial_events` being the feature that motivated
 * the dispatch. The line therefore reports what the payload actually contains
 * and never invents a celestial event it cannot see.
 *
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function formatWorldstateLine(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const d = payload.date;
  const dateBit = (d && typeof d === 'object' && num(d.year) !== null)
    ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}`
    : null;
  const tint = payload.moodTint ?? payload.mood_tint;
  const tintBit = (tint && typeof tint === 'object' && str(tint.color))
    ? `mood ${str(tint.color)}${num(tint.intensity) !== null ? ` @ ${num(tint.intensity)}` : ''}`
    : null;
  const bits = [dateBit, tintBit].filter(Boolean);
  if (!bits.length) return null;
  return `Chronicle world state changed: ${bits.join(' · ')}`;
}

/**
 * Render `calendar.season.changed`. A null payload is the documented "left a
 * season without entering a new one" case (service.go:2544), which is still
 * worth announcing — the seasonal modifiers the table was using no longer
 * apply.
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function formatSeasonLine(payload) {
  const name = str(payload?.name);
  return name ? `Chronicle season: ${name}` : 'Chronicle season: no season currently in effect';
}

/**
 * Render `calendar.era.changed`. Unlike season, Chronicle only publishes this
 * with a populated payload, so a nameless payload means a malformed message
 * and renders nothing.
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function formatEraLine(payload) {
  const name = str(payload?.name);
  return name ? `Chronicle era: ${name}` : null;
}

/**
 * Render `calendar.moon.phase_changed`.
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function formatMoonLine(payload) {
  const moon = str(payload?.moon_name) ?? str(payload?.moonName);
  const phase = str(payload?.phase_name) ?? str(payload?.phaseName);
  if (!moon && !phase) return null;
  if (!phase) return `Chronicle moon: ${moon} phase changed`;
  return `Chronicle moon: ${moon || 'Moon'} is now ${phase}`;
}

/**
 * Render the announcement line for any sub-resource type, dispatching to the
 * per-type formatter. Returns null when the type never announces or the
 * payload carried nothing renderable.
 *
 * @param {string} type
 * @param {object|null|undefined} payload
 * @returns {string|null}
 */
export function formatSubresourceLine(type, payload) {
  switch (type) {
    case 'calendar.weather.changed':    return formatWeatherLine(normalizeWeather(payload));
    case 'calendar.worldstate.changed': return formatWorldstateLine(payload);
    case 'calendar.season.changed':     return formatSeasonLine(payload);
    case 'calendar.era.changed':        return formatEraLine(payload);
    case 'calendar.moon.phase_changed': return formatMoonLine(payload);
    default:                            return null;
  }
}

/**
 * The empty sub-resource snapshot. Kept as a factory (not a frozen singleton)
 * because the reducer returns a NEW object each call and callers hold the
 * previous one — a shared mutable default would alias across CalendarSync
 * instances in tests.
 * @returns {{weather:object|null, weatherLine:string|null, season:object|null,
 *   era:object|null, moons:object, lastType:string|null}}
 */
export function emptySubresourceState() {
  return {
    weather: null,
    weatherLine: null,
    season: null,
    era: null,
    /** Keyed by moon id (falling back to name) so N moons coexist. */
    moons: {},
    lastType: null,
  };
}

/**
 * Fold one sub-resource message into the snapshot the dashboard renders.
 * Pure: returns a new state object, never mutates `prev`.
 *
 * A null payload PRESERVES the prior value for that slot rather than blanking
 * it — the weather-zone paths publish `calendar.weather.changed` with a null
 * payload (service.go:1490, :1523), and treating that as "weather is now
 * unknown" would wipe a perfectly good reading off the dashboard. The one
 * exception is season, where Chronicle uses a null payload to mean the
 * specific, meaningful state "no season in effect".
 *
 * @param {ReturnType<typeof emptySubresourceState>|null} prev
 * @param {string} type
 * @param {object|null|undefined} payload
 * @returns {ReturnType<typeof emptySubresourceState>}
 */
export function reduceSubresourceState(prev, type, payload) {
  const next = { ...(prev || emptySubresourceState()) };
  next.moons = { ...(prev?.moons || {}) };
  next.lastType = type;

  switch (type) {
    case 'calendar.weather.changed': {
      const w = normalizeWeather(payload);
      if (w) {
        next.weather = w;
        next.weatherLine = formatWeatherLine(w);
      }
      break;
    }
    case 'calendar.season.changed':
      // Null is meaningful here: "left a season without entering another".
      next.season = payload && typeof payload === 'object'
        ? { name: str(payload.name), color: str(payload.color) }
        : null;
      break;
    case 'calendar.era.changed':
      if (payload && typeof payload === 'object' && str(payload.name)) {
        next.era = { name: str(payload.name), color: str(payload.color) };
      }
      break;
    case 'calendar.moon.phase_changed': {
      const id = str(payload?.moon_id) ?? str(payload?.moon_name);
      if (id) {
        next.moons[id] = {
          name: str(payload?.moon_name) ?? id,
          phase: str(payload?.phase_name),
          position: num(payload?.phase_position),
        };
      }
      break;
    }
    default:
      break;
  }
  return next;
}

/**
 * Project the snapshot into the flat, template-friendly shape the dashboard's
 * Calendar tab renders. Returns `{has:false}` when nothing has arrived yet so
 * the template can skip the panel entirely rather than render empty rows.
 *
 * @param {ReturnType<typeof emptySubresourceState>|null} state
 * @returns {{has:boolean, weatherLine:string|null, seasonName:string|null,
 *   eraName:string|null, moons:Array<{name:string, phase:string|null}>}}
 */
export function projectSubresourcePanel(state) {
  const moons = Object.values(state?.moons || {})
    .map((m) => ({ name: m?.name || 'Moon', phase: m?.phase ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const weatherLine = state?.weatherLine ?? null;
  const seasonName = state?.season?.name ?? null;
  const eraName = state?.era?.name ?? null;
  // `season: null` after a season.changed(null) is a real state, not "unset" —
  // `lastType` tells us something arrived, so the panel still shows.
  const has = Boolean(weatherLine || seasonName || eraName || moons.length || state?.lastType);
  return { has, weatherLine, seasonName, eraName, moons };
}
