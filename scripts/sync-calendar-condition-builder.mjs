/**
 * Chronicle Sync — visual conditionTree builder (pure logic).
 *
 * Calendaria's `conditionTree` schema lets a note fire on any subset of
 * dates matching a logical expression: every full moon, every 3rd
 * weekday of winter, every Nth of every month, etc. The full schema is
 * 7+ fields × 6+ operators × nested groups — too rich for an inline
 * picker. v1 ships preset compositions that cover the common workflows;
 * advanced trees fall through to Calendaria's existing builder via a
 * "Need more? Open Calendaria's editor" link.
 *
 * Pure logic: preset → tree, tree validation, tree → human-readable
 * summary. The Application class only orchestrates rendering the preset
 * buttons and persisting the chosen tree.
 *
 * Calendaria root-group rule: a `conditionTree` whose root is not
 * `{type: 'group'}` is silently ignored by Calendaria's matcher (this
 * is documented in their API-Reference and bit us in scoping). Our
 * `validateTree()` flags this; the form's save path blocks on it.
 *
 * Tests: `tools/test-sync-calendar-condition-builder.mjs`.
 */

// ---------------------------------------------------------------------
// Schema enums (v1 scope cap — per dispatch)
// ---------------------------------------------------------------------

/** Field names usable in v1 leaf conditions. */
export const FIELDS = Object.freeze({
  WEEKDAY:     'weekday',
  MONTH_DAY:   'monthDay',
  MONTH:       'month',
  YEAR:        'year',
  SEASON:      'season',
  MOON_PHASE:  'moonPhase',
  CYCLE_STAGE: 'cycleStage',
});

/** Operators usable in v1 leaf conditions. */
export const OPERATORS = Object.freeze({
  EQ:    '==',
  NEQ:   '!=',
  MOD:   '%',
  IN:    'in',
});

/** Group-mode enum (mirrors Calendaria's `conditionGroupModes`). */
export const GROUP_MODES = Object.freeze({
  AND: 'and',
  OR:  'or',
});

/**
 * Preset identifiers. The UI renders one button per preset; each
 * preset opens a tiny form (or applies a sane default) and produces a
 * full conditionTree via `treeFromPreset(id, params)`.
 */
export const PRESETS = Object.freeze({
  EVERY_WEEKDAY:           'every-weekday',           // params: {weekdayOrdinal: 1..N}
  EVERY_NTH_OF_MONTH:      'every-nth-of-month',      // params: {monthDay: 1..28}
  EVERY_MONTH:             'every-month',             // params: {monthOrdinal: 1..N}
  EVERY_SEASON:            'every-season',            // params: {seasonId: string}
  EVERY_FULL_MOON:         'every-full-moon',         // params: {moonIndex: 0..N-1}
  EVERY_NEW_MOON:          'every-new-moon',          // params: {moonIndex: 0..N-1}
  EVERY_NTH_WEEKDAY_OF_SEASON: 'every-nth-weekday-of-season', // params: {weekdayOrdinal, seasonId}
  EVERY_CYCLE_STAGE:       'every-cycle-stage',       // params: {cycleStage: string}
});

// ---------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------

/**
 * Build an empty root group. The form starts here; presets replace its
 * `children` array.
 */
export function emptyRootGroup(mode = GROUP_MODES.AND) {
  return { type: 'group', mode, children: [] };
}

/**
 * Build a leaf condition. Calendaria stores conditions as
 * `{type: 'condition', field, op, value, value2?}`.
 */
export function leaf(field, op, value, value2) {
  const c = { type: 'condition', field, op, value };
  if (value2 !== undefined) c.value2 = value2;
  return c;
}

/**
 * Build a tree from a preset.
 *
 * Throws on unknown preset id; returns `null` if required params are
 * missing or invalid (caller surfaces the failure inline via the form's
 * error list).
 *
 * @param {string} presetId - one of `PRESETS.*`
 * @param {object} params - preset-specific params (see PRESETS const)
 * @returns {object|null} root group, or null on bad params
 */
export function treeFromPreset(presetId, params = {}) {
  switch (presetId) {
    case PRESETS.EVERY_WEEKDAY: {
      const n = Number(params.weekdayOrdinal);
      if (!Number.isInteger(n) || n < 1) return null;
      return wrapAnd([leaf(FIELDS.WEEKDAY, OPERATORS.EQ, n)]);
    }
    case PRESETS.EVERY_NTH_OF_MONTH: {
      const n = Number(params.monthDay);
      if (!Number.isInteger(n) || n < 1) return null;
      return wrapAnd([leaf(FIELDS.MONTH_DAY, OPERATORS.EQ, n)]);
    }
    case PRESETS.EVERY_MONTH: {
      const n = Number(params.monthOrdinal);
      if (!Number.isInteger(n) || n < 1) return null;
      return wrapAnd([leaf(FIELDS.MONTH, OPERATORS.EQ, n)]);
    }
    case PRESETS.EVERY_SEASON: {
      if (typeof params.seasonId !== 'string' || !params.seasonId) return null;
      return wrapAnd([leaf(FIELDS.SEASON, OPERATORS.EQ, params.seasonId)]);
    }
    case PRESETS.EVERY_FULL_MOON: {
      const idx = Number(params.moonIndex);
      if (!Number.isInteger(idx) || idx < 0) return null;
      // Calendaria full-moon range is [0.5, 0.625]. We pin "== 0.5" as
      // the canonical full-moon position; matchers usually allow a small
      // tolerance band. If Calendaria's matcher is strict-equality this
      // becomes a 1-day-per-cycle event, which is the expected semantic.
      return wrapAnd([
        leafForMoon(idx, OPERATORS.EQ, 0.5),
      ]);
    }
    case PRESETS.EVERY_NEW_MOON: {
      const idx = Number(params.moonIndex);
      if (!Number.isInteger(idx) || idx < 0) return null;
      return wrapAnd([leafForMoon(idx, OPERATORS.EQ, 0)]);
    }
    case PRESETS.EVERY_NTH_WEEKDAY_OF_SEASON: {
      const n  = Number(params.weekdayOrdinal);
      const sid = params.seasonId;
      if (!Number.isInteger(n) || n < 1) return null;
      if (typeof sid !== 'string' || !sid) return null;
      return wrapAnd([
        leaf(FIELDS.WEEKDAY, OPERATORS.EQ, n),
        leaf(FIELDS.SEASON,  OPERATORS.EQ, sid),
      ]);
    }
    case PRESETS.EVERY_CYCLE_STAGE: {
      if (typeof params.cycleStage !== 'string' || !params.cycleStage) return null;
      return wrapAnd([leaf(FIELDS.CYCLE_STAGE, OPERATORS.EQ, params.cycleStage)]);
    }
    default:
      throw new Error(`Unknown preset: ${presetId}`);
  }
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

/**
 * Validate a tree against v1's scope cap. Returns an array of i18n
 * error keys (empty array = valid).
 *
 * The most important check: root MUST be `type: 'group'`. Calendaria
 * silently ignores conditionTrees with a non-group root. Anything past
 * that — v1 scope (fields + operators), depth cap (≤2 nested groups) —
 * generates softer warnings the form surfaces as errors but doesn't
 * block on if the operator wants to write it anyway (advanced editor
 * fallback path).
 *
 * @param {*} tree - the candidate root
 * @returns {string[]} i18n keys; empty if valid
 */
export function validateTree(tree) {
  const errors = [];
  if (!tree || typeof tree !== 'object') {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.NotAnObject');
    return errors;
  }
  if (tree.type !== 'group') {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.RootMustBeGroup');
    return errors;
  }
  const validModes = new Set(Object.values(GROUP_MODES));
  if (!validModes.has(tree.mode)) {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidGroupMode');
  }
  if (!Array.isArray(tree.children) || tree.children.length === 0) {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.EmptyGroup');
    return errors;
  }
  walkChildren(tree.children, 1, errors);
  return errors;
}

function walkChildren(children, depth, errors) {
  if (depth > 2) {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.TooDeep');
    return;
  }
  for (const child of children) {
    if (!child || typeof child !== 'object') {
      errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidChild');
      continue;
    }
    if (child.type === 'group') {
      walkChildren(Array.isArray(child.children) ? child.children : [], depth + 1, errors);
      continue;
    }
    if (child.type !== 'condition') {
      errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.InvalidChildType');
      continue;
    }
    validateLeaf(child, errors);
  }
}

function validateLeaf(c, errors) {
  const fields = new Set(Object.values(FIELDS));
  const ops    = new Set(Object.values(OPERATORS));
  if (!fields.has(c.field)) {
    // v1 doesn't ship `eclipse` or event-relative fields; flag, but
    // don't block — operator may have built it in Calendaria's editor.
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.FieldNotInV1Scope');
  }
  if (!ops.has(c.op)) {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.OperatorNotInV1Scope');
  }
  if (c.value === undefined || c.value === null || c.value === '') {
    errors.push('CHRONICLE.SyncCalendar.Recurrence.Errors.MissingValue');
  }
}

// ---------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------

/**
 * Produce a human-readable summary of a tree, for display in the
 * form's recurrence section. Keeps the wording terse and unambiguous —
 * the operator should be able to skim and confirm without opening the
 * raw JSON.
 *
 * Resolution is best-effort: leaf values that reference structural ids
 * (seasonId, cycleStage) appear as-is; the caller can post-process to
 * substitute display names if it has the structure map handy.
 *
 * @param {object} tree
 * @returns {string} terse summary
 */
export function treeToSummary(tree) {
  if (!tree || typeof tree !== 'object') return '(no recurrence)';
  if (tree.type !== 'group') return '(invalid recurrence — root must be a group)';
  if (!Array.isArray(tree.children) || tree.children.length === 0) {
    return '(empty group)';
  }
  const joiner = tree.mode === GROUP_MODES.OR ? ' OR ' : ' AND ';
  return tree.children.map(childToSummary).join(joiner);
}

function childToSummary(c) {
  if (!c || typeof c !== 'object') return '?';
  if (c.type === 'group') {
    return `(${treeToSummary(c)})`;
  }
  if (c.type !== 'condition') return '?';
  return `${c.field} ${c.op} ${formatValue(c.value)}`;
}

function formatValue(v) {
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'number') return String(v);
  if (v === null || v === undefined) return '(none)';
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function wrapAnd(children) {
  return { type: 'group', mode: GROUP_MODES.AND, children };
}

/**
 * Compose a moon-phase leaf. `moonIndex` would feed into a Calendaria
 * matcher that compares `getMoonPhasePosition(moonIndex, currentDate)`
 * against `value`. We encode the moon selection via `value2` (Calendaria
 * supports a secondary operand on `moonPhase` leaves).
 */
function leafForMoon(moonIndex, op, value) {
  return { type: 'condition', field: FIELDS.MOON_PHASE, op, value, value2: moonIndex };
}
