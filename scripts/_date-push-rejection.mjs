/**
 * Session guard for date pushes Chronicle refuses outright.
 *
 * A 400/422 means Chronicle's calendar cannot hold the date Foundry sent
 * (different months or leap days); a 403 means the API key is not the
 * campaign owner's. Retrying on every world-time tick can never succeed and
 * flooded the console, so the first refusal pauses date push for the session
 * and tells the GM once. Pulls and event sync are unaffected.
 */

const FALLBACK = {
  rejected: 'Chronicle won\'t accept this date: its calendar has different months or leap days. Date sync is paused.',
  forbidden: 'Only the campaign owner\'s key can change Chronicle\'s date. Date sync is paused.',
};
const KEYS = {
  rejected: 'CHRONICLE.CalendarDatePush.Rejected',
  forbidden: 'CHRONICLE.CalendarDatePush.Forbidden',
};

/** @type {{paused: boolean, shown: Set<string>}} */
const state = { paused: false, shown: new Set() };

function statusOf(err) {
  const msg = String(err?.message || '');
  return (typeof err?.status === 'number' && err.status)
    || Number(msg.match(/Chronicle API error (\d{3})\b/)?.[1])
    || 0;
}

function text(kind) {
  try {
    const out = globalThis.game?.i18n?.localize?.(KEYS[kind]);
    if (out && out !== KEYS[kind]) return out;
  } catch { /* headless */ }
  return FALLBACK[kind];
}

/**
 * Classify a failed date push. A 422 whose body names real-time tracking is
 * the real-time guard's, not a calendar-shape rejection.
 * @param {*} err
 * @returns {'rejected'|'forbidden'|null}
 */
export function classifyDatePushRefusal(err) {
  const status = statusOf(err);
  if (status === 403) return 'forbidden';
  if (status === 400) return 'rejected';
  if (status === 422 && !/real.?time/i.test(String(err?.message || ''))) return 'rejected';
  return null;
}

/** @returns {boolean} true once a refusal paused date push this session. */
export function datePushPaused() {
  return state.paused;
}

/**
 * Pause date push and notify the GM once per kind per session.
 * @param {*} err
 * @returns {boolean} true when the error was a refusal (caller should return
 *   without logging an error).
 */
export function handleDatePushRefusal(err) {
  const kind = classifyDatePushRefusal(err);
  if (!kind) return false;
  state.paused = true;
  if (!state.shown.has(kind)) {
    state.shown.add(kind);
    const msg = text(kind);
    console.warn(`Chronicle Sync: ${msg}`);
    try { globalThis.ui?.notifications?.warn(msg); } catch { /* headless */ }
  }
  return true;
}

/**
 * Let date push try again (after a reconnect, a manual pull or a fixed
 * mismatch). The once-per-session notice stays spent, so a still-refused
 * push pauses again quietly.
 */
export function resumeDatePush() {
  state.paused = false;
}

/** Test seam. @private */
export function _resetDatePushRefusalForTests() {
  state.paused = false;
  state.shown = new Set();
}
