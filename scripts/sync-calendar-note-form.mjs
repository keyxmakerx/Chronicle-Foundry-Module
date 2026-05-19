/**
 * Chronicle Sync — Sync Calendar note-form pure logic
 *
 * Pure-function translation between the editor's note-form view-model and
 * Calendaria's documented `CALENDARIA.api.createNote` / `updateNote` input
 * shape. No Foundry globals touched — fully unit-testable.
 *
 * Pulled out per PR 1 footgun #4 (and called out in the scoping report
 * §3.1 architecture): the Application class stays a thin integration shell
 * around well-tested pure helpers.
 *
 * Form schema (the editor's interchange shape, all fields explicit):
 *   {
 *     name:         string,
 *     content:      string,                       // HTML
 *     year, month, day:           integer,        // 1-indexed start
 *     endYear, endMonth, endDay:  integer | null, // 1-indexed end; null → same as start
 *     hour, minute:               integer,        // 0-indexed time of day
 *     endHour, endMinute:         integer | null,
 *     allDay:       boolean,
 *     visibility:   'visible' | 'hidden' | 'secret',
 *     displayStyle: 'icon' | 'pip' | 'banner',
 *     icon:         string,                       // FA class or path
 *     color:        string,                       // hex
 *     categories:   string[],                     // preset IDs
 *   }
 *
 * Calendaria-side note shape (what we hand to `createNote` / `updateNote`):
 *   {
 *     name, content, startDate, endDate?, allDay, categories,
 *     icon, color, visibility, displayStyle, openSheet: false,
 *   }
 *
 * The pure module deliberately handles only the documented `CALENDARIA.api`
 * options. The legacy `gmOnly` boolean used by `calendar-sync.mjs` for
 * Chronicle wire translation is NOT in scope here — it lives on the sync
 * layer and is fixed separately in `calendar-sync.mjs` per PR 2's
 * carry-in fix A.
 */

export const VISIBILITY = Object.freeze({
  VISIBLE: 'visible',
  HIDDEN:  'hidden',
  SECRET:  'secret',
});

export const DISPLAY_STYLE = Object.freeze({
  ICON:   'icon',
  PIP:    'pip',
  BANNER: 'banner',
});

const VISIBILITY_VALUES    = Object.values(VISIBILITY);
const DISPLAY_STYLE_VALUES = Object.values(DISPLAY_STYLE);

/**
 * Empty / default form, anchored to the operator's selected day.
 *
 * @param {{year:number, month:number, day:number,
 *          endYear?:number|null, endMonth?:number|null, endDay?:number|null}} anchor
 * @returns {object} form
 */
export function defaultFormForDate(anchor) {
  const year  = Number(anchor?.year ?? 0);
  const month = Math.max(1, Number(anchor?.month ?? 1));
  const day   = Math.max(1, Number(anchor?.day ?? 1));
  const hasRange =
    anchor?.endYear != null && anchor?.endMonth != null && anchor?.endDay != null;
  return {
    name: '',
    content: '',
    year,  month,  day,
    endYear:  hasRange ? Number(anchor.endYear)  : null,
    endMonth: hasRange ? Number(anchor.endMonth) : null,
    endDay:   hasRange ? Number(anchor.endDay)   : null,
    hour: 0, minute: 0,
    endHour: null, endMinute: null,
    allDay: true,
    visibility:   VISIBILITY.VISIBLE,
    displayStyle: DISPLAY_STYLE.ICON,
    icon:  '',
    color: '',
    categories: [],
  };
}

/**
 * Pull form values out of a Calendaria note stub.
 *
 * Defensive: any field may be missing on a stub returned by an older
 * Calendaria version. Falls back to safe defaults for missing fields so
 * the editor renders a coherent form even when the stub is partial.
 *
 * @param {object|null} note — return value of `CALENDARIA.api.getNote(id)`
 *   (or a `noteCreated`/`noteUpdated` hook stub).
 * @returns {object} form
 */
export function formFromNote(note) {
  const fallback = defaultFormForDate({ year: 0, month: 1, day: 1 });
  if (!note || typeof note !== 'object') return fallback;

  // Calendaria stubs vary: top-level + nested `flagData` are both seen in
  // calendar-sync.mjs. Merge with top-level winning.
  const f = (note.flagData && typeof note.flagData === 'object') ? note.flagData : {};
  const start = note.startDate || f.startDate || {};
  const end   = note.endDate   || f.endDate   || null;

  const name    = pickString(note.name, note.title, '');
  const content = pickString(note.content, f.content, '');

  const year  = toIntOr(start.year,        fallback.year);
  const month = toIntOr(start.month,       fallback.month);
  const day   = toIntOr(start.day ?? start.dayOfMonth, fallback.day);

  let endYear  = null, endMonth = null, endDay = null;
  if (end && typeof end === 'object') {
    endYear  = toIntOr(end.year, null);
    endMonth = toIntOr(end.month, null);
    endDay   = toIntOr(end.day ?? end.dayOfMonth, null);
  }

  const hour     = toIntOr(start.hour,   0);
  const minute   = toIntOr(start.minute, 0);
  const endHour   = end ? toIntOr(end.hour,   null) : null;
  const endMinute = end ? toIntOr(end.minute, null) : null;

  const allDay = note.allDay ?? f.allDay ?? true;

  return {
    name,
    content,
    year, month, day,
    endYear, endMonth, endDay,
    hour, minute,
    endHour, endMinute,
    allDay: !!allDay,
    visibility:   coerceVisibility(note.visibility ?? f.visibility),
    displayStyle: coerceDisplayStyle(note.displayStyle ?? f.displayStyle),
    icon:  pickString(note.icon,  f.icon,  ''),
    color: pickString(note.color, f.color, ''),
    categories: coerceCategories(note.categories ?? f.categories),
  };
}

/**
 * Convert a form to the options object accepted by
 * `CALENDARIA.api.createNote` / `updateNote`.
 *
 * Strips empty optional fields so Calendaria's defaults apply. Date+time
 * are emitted 1-indexed for month/day per Calendaria's public API
 * convention.
 *
 * @param {object} form
 * @returns {object} options for `createNote` / `updateNote`
 */
export function noteOptionsFromForm(form) {
  if (!form || typeof form !== 'object') {
    throw new TypeError('noteOptionsFromForm: form must be an object');
  }

  const startDate = {
    year:  Math.trunc(Number(form.year)),
    month: Math.trunc(Number(form.month)),
    day:   Math.trunc(Number(form.day)),
  };
  if (!form.allDay) {
    startDate.hour   = clampInt(form.hour,   0, 23);
    startDate.minute = clampInt(form.minute, 0, 59);
  }

  const hasEndDate =
    form.endYear  != null &&
    form.endMonth != null &&
    form.endDay   != null;
  let endDate = null;
  if (hasEndDate) {
    endDate = {
      year:  Math.trunc(Number(form.endYear)),
      month: Math.trunc(Number(form.endMonth)),
      day:   Math.trunc(Number(form.endDay)),
    };
    if (!form.allDay) {
      endDate.hour   = clampInt(form.endHour ?? form.hour,   0, 23);
      endDate.minute = clampInt(form.endMinute ?? form.minute, 0, 59);
    }
  }

  const options = {
    name:    String(form.name ?? '').trim(),
    content: String(form.content ?? ''),
    startDate,
    allDay:  !!form.allDay,
    visibility:   coerceVisibility(form.visibility),
    displayStyle: coerceDisplayStyle(form.displayStyle),
    // Skip openSheet — the editor opens its own form; do NOT pop the
    // Calendaria note sheet over our window.
    openSheet: false,
  };

  if (endDate) options.endDate = endDate;

  const icon  = String(form.icon  ?? '').trim();
  const color = String(form.color ?? '').trim();
  if (icon)  options.icon  = icon;
  if (color) options.color = color;

  const categories = coerceCategories(form.categories);
  if (categories.length > 0) options.categories = categories;

  return options;
}

/**
 * Validate a form. Returns an array of error messages (empty if valid).
 * Validation is structural — date semantics (e.g. month > calendar's
 * month count) are deferred to Calendaria, which knows the calendar.
 *
 * @param {object} form
 * @returns {string[]}
 */
export function validateForm(form) {
  const errors = [];
  if (!form || typeof form !== 'object') {
    return ['CHRONICLE.SyncCalendar.NoteForm.Errors.NotAnObject'];
  }
  if (!String(form.name ?? '').trim()) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.NameRequired');
  }
  if (!Number.isFinite(Number(form.year))) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.YearInvalid');
  }
  const month = Number(form.month);
  if (!Number.isFinite(month) || month < 1) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.MonthInvalid');
  }
  const day = Number(form.day);
  if (!Number.isFinite(day) || day < 1) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.DayInvalid');
  }

  const hasEnd =
    form.endYear  != null &&
    form.endMonth != null &&
    form.endDay   != null;
  if (hasEnd) {
    const endYear  = Number(form.endYear);
    const endMonth = Number(form.endMonth);
    const endDay   = Number(form.endDay);
    if (!Number.isFinite(endYear) || !Number.isFinite(endMonth) || !Number.isFinite(endDay)) {
      errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.EndDateInvalid');
    } else if (
      // End strictly before start at any granularity → error.
      endYear  <  Number(form.year) ||
      (endYear === Number(form.year) && endMonth <  Number(form.month)) ||
      (endYear === Number(form.year) && endMonth === Number(form.month) && endDay < Number(form.day))
    ) {
      errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.EndBeforeStart');
    }
  }

  if (!form.allDay) {
    const h = Number(form.hour), m = Number(form.minute);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.HourInvalid');
    }
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.MinuteInvalid');
    }
  }

  if (!VISIBILITY_VALUES.includes(form.visibility)) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.VisibilityInvalid');
  }
  if (!DISPLAY_STYLE_VALUES.includes(form.displayStyle)) {
    errors.push('CHRONICLE.SyncCalendar.NoteForm.Errors.DisplayStyleInvalid');
  }

  return errors;
}

/**
 * Coerce a free-form categories input (array OR comma-separated string)
 * into a deduplicated string[]. Exported for the form's tag-style input.
 */
export function coerceCategories(input) {
  if (Array.isArray(input)) {
    return dedupeStrings(input.map((c) => String(c).trim()).filter(Boolean));
  }
  if (typeof input === 'string') {
    return dedupeStrings(input.split(',').map((c) => c.trim()).filter(Boolean));
  }
  return [];
}

/**
 * Pin a visibility value to the documented enum. Unknown / missing →
 * `'visible'` (Calendaria's default).
 */
export function coerceVisibility(v) {
  return VISIBILITY_VALUES.includes(v) ? v : VISIBILITY.VISIBLE;
}

/**
 * Pin a displayStyle value to the documented enum. Unknown / missing →
 * `'icon'` (Calendaria's default).
 */
export function coerceDisplayStyle(s) {
  return DISPLAY_STYLE_VALUES.includes(s) ? s : DISPLAY_STYLE.ICON;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

function toIntOr(value, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, lo, hi) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(lo, Math.min(hi, n));
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
