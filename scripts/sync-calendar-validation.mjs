/**
 * Chronicle Sync — Sync Calendar validation rule engine
 *
 * Pure-function rules over the Calendaria active-calendar object returned by
 * `CALENDARIA.api.getActiveCalendar()`. Each rule inspects the calendar and
 * returns either `null` (rule passes) or a finding describing what's off.
 *
 * Findings shape:
 *   {
 *     severity: 'error' | 'warning' | 'info',
 *     code:     'STABLE_RULE_CODE',
 *     message:  'human-readable text (already localized by the rule)',
 *     fix_hint: 'one-line action (optional, localized)',
 *     focus_target: 'left-rail navigation target (optional)',
 *   }
 *
 * Rules are pure — no Foundry globals touched. The `runValidation` entry
 * point swallows per-rule exceptions so a single buggy rule never blanks the
 * validation panel.
 *
 * Schema versioning: the user-flag state persisted by the editor carries a
 * `schemaVersion` integer (see `SCHEMA_VERSION` below). Bump on any rule-
 * output shape change so the editor can ignore stale flag data.
 *
 * Scoping reference: cordinator `reports/foundry/2026-05-19-fm-cal-editor-scoping.md`
 * § 6 — the 10 Therin gaps this rule set surfaces.
 */

export const SCHEMA_VERSION = 1;

/**
 * Run every rule against `cal`. Returns an array of findings.
 *
 * @param {object|null} cal — the Calendaria active-calendar object (from
 *   `CALENDARIA.api.getActiveCalendar()`). Null returns an empty array.
 * @param {object} [ctx]
 * @param {object|null} [ctx.currentDateTime] — output of
 *   `CALENDARIA.api.getCurrentDateTime()`; used by rules that compare runtime
 *   state to calendar definition.
 * @returns {Array<{severity, code, message, fix_hint?, focus_target?}>}
 */
export function runValidation(cal, ctx = {}) {
  if (!cal) return [];
  const findings = [];
  for (const rule of RULES) {
    try {
      const finding = rule(cal, ctx);
      if (finding) findings.push(finding);
    } catch (err) {
      // A buggy rule must never blank the panel. Log + skip.
      // eslint-disable-next-line no-console
      console.warn(`Sync Calendar | rule "${rule.name}" crashed`, err);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------
// Each rule is a named export so tests can import and call it directly.
// Localization is handled inline because the i18n keys are stable; the rule
// returns the localized string for the runtime renderer.

/**
 * R1 — Active weather zone references a zone that doesn't exist.
 *
 * Therin case: `weather.activeZone === "temperate"` but `weather.zones === {}`.
 * Calendaria silently falls back to no-weather in this state; operator only
 * sees the gap by running a weather check.
 */
export function ruleActiveZoneExists(cal) {
  const active = cal?.weather?.activeZone;
  const zones  = cal?.weather?.zones ?? {};
  if (!active) return null;
  const ids = Object.values(zones)
    .map((z) => z?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.includes(active)) return null;
  return {
    severity: 'warning',
    code: 'WEATHER_ACTIVE_ZONE_MISSING',
    message: `Active weather zone "${active}" is set but no zone with that id exists in the calendar.`,
    fix_hint: 'Create a zone with this id, choose an existing zone, or clear activeZone.',
    focus_target: 'weather',
  };
}

/**
 * R2 — Zero festivals authored.
 *
 * Therin case: `festivals: {}`. Advisory because some calendars genuinely
 * have no festivals; the operator's design probe specifically called this
 * out as a "gap I'd like the editor to surface."
 */
export function ruleFestivalsEmpty(cal) {
  const festivals = cal?.festivals ?? {};
  const count = Object.keys(festivals).length;
  if (count > 0) return null;
  return {
    severity: 'info',
    code: 'FESTIVALS_EMPTY',
    message: 'No festivals authored. The festival list will be empty in widgets that surface festivals.',
    fix_hint: 'Author festivals via Calendaria\'s Calendar Editor → Festivals tab (PR 4 will add an in-editor authoring flow).',
    focus_target: 'festivals',
  };
}

/**
 * R3 — Season with `seasonalType: null`.
 *
 * Therin case: "Greylight" with `seasonalType: null`. Calendaria's
 * astronomical anchors (equinox / solstice) silently skip these seasons.
 * Sometimes intentional (interstitial season); sometimes a forgotten field.
 */
export function ruleSeasonInterstitial(cal) {
  const seasons = cal?.seasons?.values ?? {};
  const interstitial = Object.entries(seasons)
    .filter(([_id, s]) => s && s.seasonalType === null)
    .map(([_id, s]) => s?.name || 'unnamed');
  if (interstitial.length === 0) return null;
  return {
    severity: 'info',
    code: 'SEASON_INTERSTITIAL',
    message: `Season(s) with seasonalType: null — astronomical anchors (equinox / solstice) will not resolve to: ${interstitial.join(', ')}.`,
    fix_hint: 'Intentional? Mark it on the season. Otherwise set seasonalType to spring/summer/autumn/winter.',
    focus_target: 'seasons',
  };
}

/**
 * R4 — Season month range wraps the year boundary.
 *
 * Therin case: "Greylight" `monthStart: 13, monthEnd: 0` (wraps year-end).
 * Not necessarily a bug, but flag for confirmation — operator may have
 * accidentally inverted the range.
 */
export function ruleSeasonWrapsYear(cal) {
  const seasons = cal?.seasons?.values ?? {};
  const wrapped = Object.entries(seasons)
    .filter(([_id, s]) => {
      if (!s || s.monthStart == null || s.monthEnd == null) return false;
      // Wraps when the start month index is greater than the end month index.
      // Indexing here is 0-based per Calendaria's internal storage; the
      // editor's display layer maps to 1-based ordinals before showing.
      return Number(s.monthStart) > Number(s.monthEnd);
    })
    .map(([_id, s]) => s?.name || 'unnamed');
  if (wrapped.length === 0) return null;
  return {
    severity: 'info',
    code: 'SEASON_WRAPS_YEAR',
    message: `Season(s) wrap the year boundary (monthStart > monthEnd): ${wrapped.join(', ')}.`,
    fix_hint: 'Confirm intentional — interstitial seasons spanning year-end are valid; reversed ranges are not.',
    focus_target: 'seasons',
  };
}

/**
 * R5 — Randomized moon with default `phaseSeed: 0`.
 *
 * Therin case: Umbra `phaseMode: "randomized"` + `phaseSeed: 0`. Calendaria's
 * editor docs describe the seed as click-to-randomize; `0` is the uninitialized
 * default. The moon will still work but every campaign starts from the same
 * pseudorandom sequence.
 */
export function ruleRandomizedMoonDefaultSeed(cal) {
  const moons = cal?.moons ?? {};
  const suspect = Object.entries(moons)
    .filter(([_id, m]) => m?.phaseMode === 'randomized' && Number(m?.phaseSeed ?? 0) === 0)
    .map(([_id, m]) => m?.name || 'unnamed');
  if (suspect.length === 0) return null;
  return {
    severity: 'warning',
    code: 'MOON_RANDOMIZED_DEFAULT_SEED',
    message: `Randomized moon(s) with default phaseSeed: 0 — every world will share the same pseudorandom sequence: ${suspect.join(', ')}.`,
    fix_hint: 'Reroll the seed in Calendaria\'s Moon editor (PR 5 will add an in-editor "regenerate seed" button).',
    focus_target: 'moons',
  };
}

/**
 * R6 — Multiple moons sharing the stock Calendaria phase icon set.
 *
 * Therin case: Lacrimosa + Sanguin'mor + Umbra all reference
 * `modules/calendaria/assets/moon-phases/0[1-8]_*.svg` for their phases.
 * Visually indistinguishable in the calendar UI. Low-priority advisory.
 */
export function ruleMoonIconsDuplicated(cal) {
  const moons = cal?.moons ?? {};
  const entries = Object.entries(moons);
  if (entries.length < 2) return null;
  const usesGeneric = entries.filter(([_id, m]) => {
    const phases = Object.values(m?.phases ?? {});
    if (phases.length === 0) return false;
    return phases.every((p) =>
      typeof p?.icon === 'string' &&
      p.icon.startsWith('modules/calendaria/assets/moon-phases/'),
    );
  });
  if (usesGeneric.length < 2) return null;
  return {
    severity: 'info',
    code: 'MOON_ICONS_GENERIC_DUPLICATED',
    message: `${usesGeneric.length} moons share Calendaria's stock phase icons — they will be visually indistinguishable in widgets that show all moons.`,
    fix_hint: 'Set custom phase icons per moon in Calendaria\'s Moon editor.',
    focus_target: 'moons',
  };
}

/**
 * R7 — Date format strings consisting entirely of bracket-escaped literals.
 *
 * Therin case: `dateFormats.weekHeader: "[W]"`, `yearHeader: "[YYYY]"`,
 * `yearLabel: "[YYYY] [GGGG]"`. Calendaria treats `[...]` as a literal-text
 * escape, so the format produces the literal string `W` (etc.) at runtime —
 * almost certainly not the intent.
 *
 * Detection: strip every `[...]` segment; if the remainder has no
 * non-whitespace characters, the format is literal-only. Forbidden Lands'
 * `"[Week] W [of] MMMM, Y"` mixes literals with real tokens and passes.
 */
export function ruleDateFormatLiteralString(cal) {
  const formats = cal?.dateFormats ?? {};
  const offenders = Object.entries(formats)
    .filter(([_k, v]) => typeof v === 'string' && v.length > 0)
    .filter(([_k, v]) => v.replace(/\[[^\]]*\]/g, '').trim() === '')
    .map(([k]) => k);
  if (offenders.length === 0) return null;
  return {
    severity: 'warning',
    code: 'DATE_FORMAT_LITERAL_ONLY',
    message: `Date format(s) consist entirely of bracket-escaped literals — they will render as plain text, not as computed tokens: ${offenders.join(', ')}.`,
    fix_hint: 'Remove the [brackets] around tokens you want computed (e.g. "YYYY" not "[YYYY]"). Use brackets only for literal text mixed with tokens.',
    focus_target: 'dateFormats',
  };
}

/**
 * R8 — Reference date with `dayOfMonth: 0` on a moon.
 *
 * Therin case: Umbra `referenceDate.dayOfMonth: 0`. Calendaria stores
 * `dayOfMonth` 0-indexed internally; the public API and editor surfaces
 * are 1-indexed. A literal `0` reads as "day 1" in the engine but is
 * suspicious to humans editing raw JSON. Surface so the operator can
 * confirm.
 */
export function ruleReferenceDateDayZero(cal) {
  const moons = cal?.moons ?? {};
  const suspect = Object.entries(moons)
    .filter(([_id, m]) => Number(m?.referenceDate?.dayOfMonth ?? -1) === 0)
    .map(([_id, m]) => m?.name || 'unnamed');
  if (suspect.length === 0) return null;
  return {
    severity: 'info',
    code: 'MOON_REFERENCE_DAY_ZERO',
    message: `Moon(s) with referenceDate.dayOfMonth: 0 — internally this is "day 1" (0-indexed) but reads as "day 0" to humans: ${suspect.join(', ')}.`,
    fix_hint: 'Confirm intent. PR 5 will display all date fields 1-indexed in the editor.',
    focus_target: 'moons',
  };
}

/**
 * R9 — `description` present at both the top level and under `metadata`,
 * and the two strings disagree.
 *
 * Therin case: top-level `description: "The common calendar used across..."`
 * but `metadata.description: ""`. Cosmetic but signals export inconsistency.
 */
export function ruleDescriptionDoubled(cal) {
  const top  = typeof cal?.description === 'string' ? cal.description.trim() : '';
  const meta = typeof cal?.metadata?.description === 'string' ? cal.metadata.description.trim() : '';
  if (!top || !meta) return null;
  if (top === meta) return null;
  return {
    severity: 'info',
    code: 'DESCRIPTION_DOUBLED',
    message: 'Top-level "description" and "metadata.description" both exist and disagree.',
    fix_hint: 'Pick one. PR 5 will collapse them into a single description field in the editor.',
    focus_target: 'overview',
  };
}

/**
 * R10 — Calendar has a persisted `currentDate` but it sits at the default
 * (year ≤ yearZero, no time advance recorded). Strong signal the world has
 * never been advanced since creation.
 *
 * Therin case: `currentDate: { year: 0, month: 0, day: 1, dayOfMonth: 0,
 * hour: 0, minute: 0 }` with yearZero: 0. Advisory only.
 */
export function ruleLastAdvancedNever(cal) {
  const cd = cal?.currentDate;
  if (!cd || typeof cd !== 'object') return null;
  const yearZero = Number(cal?.years?.yearZero ?? 0);
  const year     = Number(cd.year ?? 0);
  const dom      = Number(cd.dayOfMonth ?? cd.day ?? 0);
  const month    = Number(cd.month ?? 0);
  const hour     = Number(cd.hour ?? 0);
  const minute   = Number(cd.minute ?? 0);
  // Default state — year at or below yearZero, all time components zero.
  if (year > yearZero) return null;
  if (month !== 0)     return null;
  if (dom !== 0)       return null;
  if (hour !== 0 || minute !== 0) return null;
  return {
    severity: 'info',
    code: 'CALENDAR_LAST_ADVANCED_NEVER',
    message: 'Calendar has never been advanced — currentDate is at the default for a freshly-created calendar.',
    fix_hint: 'Advance the calendar with Calendaria\'s MiniCal / HUD, or set the initial date in PR 5\'s structure editor.',
    focus_target: 'overview',
  };
}

/**
 * Stable rule order. Each rule listed here gets called by `runValidation`.
 * The order matters only for display — rules render in this sequence.
 */
const RULES = [
  ruleActiveZoneExists,
  ruleFestivalsEmpty,
  ruleSeasonInterstitial,
  ruleSeasonWrapsYear,
  ruleRandomizedMoonDefaultSeed,
  ruleMoonIconsDuplicated,
  ruleDateFormatLiteralString,
  ruleReferenceDateDayZero,
  ruleDescriptionDoubled,
  ruleLastAdvancedNever,
];

/**
 * Test-only export so unit tests can iterate over every rule by reference.
 * The runtime never imports `ALL_RULES` — it goes through `runValidation`.
 */
export const ALL_RULES = Object.freeze(RULES.slice());
