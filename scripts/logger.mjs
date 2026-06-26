/**
 * Chronicle Sync — leveled logger with an in-memory ring buffer.
 *
 * Two jobs:
 *   1. Gate console noise by a current level (error < warn < info < debug < trace).
 *   2. ALWAYS capture recent messages into a ring buffer, so the dashboard can
 *      export them (Diagnostic Bundle) even when the console wasn't open.
 *
 * Adoption is incremental: modules migrate `console.*` → `log.*` over time. The
 * level control is wired into the UI only once enough call sites route through
 * here for it to actually govern output (so we never ship a no-op control).
 *
 * PURE except for `console` and the clock — unit-tested in tools/test-logger.mjs.
 */

/** Numeric severities; lower = more severe. `silent` suppresses all console output. */
export const LOG_LEVELS = Object.freeze({ silent: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 });

const RING_MAX = 500;
let _level = LOG_LEVELS.info;
const _ring = [];

/**
 * Set the active console level by name ("error".."trace"/"silent") or number.
 * Unknown names are ignored (keeps the prior level).
 * @param {string|number} level
 */
export function setLogLevel(level) {
  if (typeof level === 'number' && Number.isFinite(level)) {
    _level = level;
    return;
  }
  if (typeof level === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
    _level = LOG_LEVELS[level];
  }
}

/** @returns {string} the active level name. */
export function getLogLevelName() {
  return Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === _level) ?? 'info';
}

function _stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message || String(v);
  try { return JSON.stringify(v); } catch (err) { return String(v); }
}

function _record(levelName, args) {
  _ring.push({ t: Date.now(), level: levelName, msg: args.map(_stringify).join(' ') });
  if (_ring.length > RING_MAX) _ring.shift();
}

function _emit(levelName, args) {
  _record(levelName, args);
  const sev = LOG_LEVELS[levelName];
  if (sev < 0 || sev > _level) return; // below the active threshold → captured but not printed
  const fn = levelName === 'error' ? console.error
    : levelName === 'warn' ? console.warn
      : levelName === 'info' ? (console.info || console.log)
        : (console.debug || console.log);
  try { fn.call(console, `Chronicle [${levelName}]:`, ...args); } catch (err) { /* console unavailable */ }
}

/** Leveled log methods. Each records to the ring AND prints if the level allows. */
export const log = {
  error: (...a) => _emit('error', a),
  warn: (...a) => _emit('warn', a),
  info: (...a) => _emit('info', a),
  debug: (...a) => _emit('debug', a),
  trace: (...a) => _emit('trace', a),
};

/** @returns {Array<{t:number, level:string, msg:string}>} a copy of the ring buffer. */
export function getLogBuffer() {
  return _ring.slice();
}

/** Clear the captured ring buffer. */
export function clearLogBuffer() {
  _ring.length = 0;
}

/** Render the ring buffer as plain text (for the Diagnostic Bundle / export). */
export function exportLogText() {
  return _ring
    .map((e) => `[${new Date(e.t).toISOString()}] ${e.level.toUpperCase()} ${e.msg}`)
    .join('\n');
}
