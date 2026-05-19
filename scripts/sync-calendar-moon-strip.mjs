/**
 * Chronicle Sync — Moon-phase strip builder (pure logic).
 *
 * Powers the Sync Calendar editor's month-view moon strip diagram. For each
 * moon defined on the active calendar, builds a per-day phase-position array
 * across the visible range. The application class then renders these as
 * color-coded horizontal strips.
 *
 * Pure: no DOM, no Foundry globals, no Calendaria coupling beyond the
 * injected `getPosition` lookup. Unit-tested at
 * `tools/test-sync-calendar-moon-strip.mjs` against the three operator
 * fixture calendars (Therin, Tyr, Forbidden Lands).
 *
 * Why this is its own module: per F-PR1 footgun #4, view-model logic that
 * needs unit tests does not belong inside an ApplicationV2 class — the
 * class is the integration shell, this is the pure logic.
 */

/**
 * Build per-moon strip data for the visible range.
 *
 * The caller supplies a `getPosition(moonIndex, date)` lookup — in
 * production this is `CALENDARIA.api.getMoonPhasePosition`; in tests a
 * deterministic stub. The function is pure: same inputs → same outputs.
 *
 * @param {object} args
 * @param {object[]} args.moons - Array of moon definitions, in order. Each
 *   needs at least `{name, color, cycleLength, phaseMode}` and may carry
 *   `phases` (id-keyed object) for phase-name lookup.
 * @param {number} args.year - Year being rendered.
 * @param {number} args.monthOrdinal - 1-indexed month being rendered.
 * @param {number} args.daysInMonth - Number of days in that month.
 * @param {(moonIndex: number, date: {year, month, dayOfMonth}) => number} args.getPosition
 *   Phase-position lookup, returns 0-1.
 * @returns {{moons: Array<{
 *   index: number,
 *   name: string,
 *   color: string,
 *   cycleLength: number,
 *   isRandomized: boolean,
 *   days: Array<{day: number, position: number, phaseName: string, isFull: boolean, isNew: boolean}>
 * }>}}
 */
export function buildMoonStripData({ moons, year, monthOrdinal, daysInMonth, getPosition }) {
  if (!Array.isArray(moons) || moons.length === 0) {
    return { moons: [] };
  }
  if (!Number.isFinite(daysInMonth) || daysInMonth < 1) {
    return { moons: [] };
  }
  if (typeof getPosition !== 'function') {
    return { moons: [] };
  }

  const rows = moons.map((moon, index) => {
    const phases = (moon && typeof moon.phases === 'object' && moon.phases !== null)
      ? Object.values(moon.phases)
      : [];

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      let position = 0;
      try {
        const raw = getPosition(index, { year, month: monthOrdinal, dayOfMonth: d });
        position = Number.isFinite(raw) ? clamp01(raw) : 0;
      } catch {
        position = 0;
      }
      const phaseName = phaseNameAt(phases, position);
      days.push({
        day: d,
        position,
        phaseName,
        isFull: isFullPosition(position),
        isNew:  isNewPosition(position),
      });
    }

    return {
      index,
      name:         moon?.name || `Moon ${index + 1}`,
      color:        moon?.color || '#888888',
      cycleLength:  Number(moon?.cycleLength ?? 0),
      isRandomized: moon?.phaseMode === 'randomized',
      days,
    };
  });

  return { moons: rows };
}

/**
 * Pixel-to-day translator for click-to-day on the strip.
 *
 * Strip widths are CSS-determined at render time; this helper converts
 * the click X (clientX - strip.left) to a 1-indexed day ordinal. Edge
 * cases: clicks outside the strip clamp to 1 / daysInMonth.
 *
 * @param {number} clickXWithinStrip - X offset relative to strip's left edge.
 * @param {number} stripWidthPx - Strip's rendered width.
 * @param {number} daysInMonth - Number of days the strip spans.
 * @returns {number} 1-indexed day.
 */
export function dayFromStripClick(clickXWithinStrip, stripWidthPx, daysInMonth) {
  if (!Number.isFinite(daysInMonth) || daysInMonth < 1) return 1;
  if (!Number.isFinite(stripWidthPx) || stripWidthPx <= 0) return 1;
  const x = Number.isFinite(clickXWithinStrip) ? clickXWithinStrip : 0;
  const ratio = Math.min(1, Math.max(0, x / stripWidthPx));
  const day = Math.floor(ratio * daysInMonth) + 1;
  return Math.min(daysInMonth, Math.max(1, day));
}

/**
 * Detect "convergence" days — those where two or more moons are
 * simultaneously near-full. Used by the strip diagram to surface a
 * pip on the day cell. Tyr's 33-day Ral + 125-day Guthay produce
 * sparse but meaningful convergences; Therin's randomized Umbra
 * produces noise we don't tag.
 *
 * @param {ReturnType<typeof buildMoonStripData>} stripData
 * @returns {number[]} Sorted unique 1-indexed days with ≥2 moons full.
 */
export function findConvergenceDays(stripData) {
  if (!stripData || !Array.isArray(stripData.moons) || stripData.moons.length < 2) {
    return [];
  }
  const determinist = stripData.moons.filter((m) => !m.isRandomized);
  if (determinist.length < 2) return [];

  const daysSet = new Set();
  const dayCount = determinist[0].days.length;
  for (let i = 0; i < dayCount; i++) {
    let fulls = 0;
    for (const m of determinist) {
      if (m.days[i]?.isFull) fulls++;
      if (fulls >= 2) break;
    }
    if (fulls >= 2) daysSet.add(determinist[0].days[i].day);
  }
  return Array.from(daysSet).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Position 0.5-0.625 is the canonical "full" band in Calendaria phase
 * tables (all three fixture calendars place "Full" at exactly that
 * range). We accept a small tolerance either side.
 */
function isFullPosition(position) {
  return position >= 0.48 && position <= 0.65;
}

/**
 * Position near 0 (or wrapping near 1) is "new moon". Calendaria places
 * "New" at 0-0.125 typically.
 */
function isNewPosition(position) {
  return position < 0.12 || position > 0.98;
}

/**
 * Look up the phase name covering a position. Calendaria phases have
 * `{start, end}` covering [0,1]; a position lands in exactly one (or
 * none if the table is sparse).
 */
function phaseNameAt(phases, position) {
  if (!Array.isArray(phases) || phases.length === 0) return '';
  for (const p of phases) {
    const start = Number(p?.start ?? 0);
    const end   = Number(p?.end ?? 0);
    if (position >= start && position < end) return p?.name || '';
  }
  // Tail end: position exactly 1.0 should match the last phase.
  const last = phases[phases.length - 1];
  if (last && Number(last.end ?? 0) === 1 && position >= Number(last.start ?? 0)) {
    return last.name || '';
  }
  return '';
}
