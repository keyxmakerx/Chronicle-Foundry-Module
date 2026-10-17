/**
 * The Dice So Nice check behind the Health pane: what this client found, read
 * back as plain rows that say what is wrong and what to do. Dice So Nice is
 * someone else's module and can change without notice, so every fact the
 * bridge relies on (it is on, it started, the calls we make exist, our files
 * load) is a row here instead of an assumption.
 *
 * Pure: the bridge gathers the facts, this only judges them. Pinned by
 * tools/test-dice-so-nice-check.mjs.
 */

export const DSN_ID = 'dice-so-nice';

/** The Dice So Nice release this bridge was written and tested against. */
export const TESTED_VERSION = '6.4.4';

/** Calls the bridge cannot work without. */
export const REQUIRED_API = Object.freeze(['addSystem', 'addDicePreset', 'addColorset']);

/** Calls the bridge uses when present and does without otherwise. */
export const OPTIONAL_API = Object.freeze(['preloadPresets', 'isEnabled']);

/** Row levels, worst last. */
export const LEVELS = Object.freeze(['ok', 'info', 'warn', 'error']);

/**
 * Compare dotted versions numerically ("6.10" is after "6.9").
 * @returns {number} negative, zero or positive
 */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * @typedef {object} DiceFacts
 * @property {boolean} installed  - Dice So Nice is in this world's module list
 * @property {boolean} active     - and switched on
 * @property {string}  [version]
 * @property {boolean} [streamView]   - Foundry's /stream page, where Dice So Nice never starts
 * @property {boolean} [noCanvas]     - this player turned the canvas off
 * @property {boolean} [hasApi]       - game.dice3d exists
 * @property {boolean} [ready]        - its ready hook reached us
 * @property {boolean} [waitedLong]   - long enough since our ready that it should have started
 * @property {string[]} [methods]     - functions present on game.dice3d
 * @property {boolean} [enabled]      - its own on/off for this player (isEnabled)
 * @property {{ok: boolean, error?: string, problems?: object[], setCount?: number}} [manifest]
 * @property {{colorsets: number, systems: number, presets: number, errors: {step: string, id: string, message: string}[]}} [registration]
 * @property {{path: string, ok: boolean, status?: number}[]} [files] - only when the GM ran the file check
 */

const row = (level, code, data = {}) => ({ level, code, data });

/**
 * Judge the facts. Each row's `code` is a lang key under
 * CHRONICLE.Dice.Check (`<code>` for the line, `<code>Fix` for what to do).
 * @param {DiceFacts} f
 * @returns {{state: 'off'|'ok'|'warn'|'error', rows: {level: string, code: string, data: object}[]}}
 */
export function judgeDiceSoNice(f = {}) {
  const rows = [];
  if (!f.installed || !f.active) {
    rows.push(row('info', f.installed ? 'NotActive' : 'NotInstalled'));
    return { state: 'off', rows };
  }

  const v = f.version || '';
  if (!v) rows.push(row('warn', 'VersionUnknown'));
  else if (compareVersions(v, TESTED_VERSION) === 0) rows.push(row('ok', 'VersionTested', { version: v }));
  else if (compareVersions(v.split('.')[0], TESTED_VERSION.split('.')[0]) !== 0) {
    rows.push(row('warn', 'VersionMajor', { version: v, tested: TESTED_VERSION }));
  } else rows.push(row('info', 'VersionOther', { version: v, tested: TESTED_VERSION }));

  if (f.streamView) rows.push(row('info', 'StreamView'));
  else if (f.noCanvas) rows.push(row('info', 'NoCanvas'));
  else if (!f.hasApi) rows.push(row(f.waitedLong ? 'error' : 'info', f.waitedLong ? 'NoApi' : 'Starting'));
  else {
    const have = new Set(f.methods ?? []);
    const missing = REQUIRED_API.filter((m) => !have.has(m));
    if (missing.length) rows.push(row('error', 'ApiMissing', { methods: missing.join(', ') }));
    else rows.push(row('ok', 'ApiOk'));
    const optionalGone = OPTIONAL_API.filter((m) => !have.has(m));
    if (optionalGone.length) rows.push(row('info', 'ApiOptionalMissing', { methods: optionalGone.join(', ') }));
    if (!f.ready) rows.push(row(f.waitedLong ? 'error' : 'info', f.waitedLong ? 'NoReadyHook' : 'Starting'));
    if (f.enabled === false) rows.push(row('info', 'DisabledForUser'));
  }

  const m = f.manifest;
  if (m && !m.ok) rows.push(row('error', 'ManifestUnreadable', { error: m.error || '' }));
  else if (m) {
    for (const p of m.problems ?? []) {
      rows.push(row('warn', 'ManifestProblem', { problem: p.code, set: p.set || '', detail: p.detail || '' }));
    }
    rows.push(row(m.setCount ? 'ok' : 'info', m.setCount ? 'SetsListed' : 'NoSets', { count: m.setCount || 0 }));
  }

  const r = f.registration;
  if (r) {
    for (const e of r.errors ?? []) rows.push(row('error', 'RegisterFailed', e));
    if (r.colorsets || r.systems) {
      rows.push(row('ok', 'Registered', { colorsets: r.colorsets, systems: r.systems, presets: r.presets }));
    }
  }

  if (Array.isArray(f.files)) {
    const bad = f.files.filter((x) => !x.ok);
    for (const x of bad) rows.push(row('error', 'FileMissing', { path: x.path, status: x.status ?? '' }));
    if (f.files.length && !bad.length) rows.push(row('ok', 'FilesOk', { count: f.files.length }));
  }

  const worst = rows.reduce((w, x) => Math.max(w, LEVELS.indexOf(x.level)), 0);
  return { state: worst >= 3 ? 'error' : worst === 2 ? 'warn' : 'ok', rows };
}
