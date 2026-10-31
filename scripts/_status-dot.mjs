/**
 * The sidebar status dot's words, kept apart from the DOM so they can be
 * tested. Text comes from lang/en.json through the `localize`/`format`
 * functions passed in.
 */

const STATES = new Set(['connected', 'connecting', 'reconnecting', 'disconnected']);

/** Any state the client doesn't name reads as disconnected. */
export function stateKey(state) {
  return STATES.has(state) ? state : 'disconnected';
}

/** "Chronicle: Connected" and the like. */
export function statusLabel(state, localize) {
  return localize(`CHRONICLE.Status.Indicator.${stateKey(state)}`);
}

/**
 * How long ago `at` was, in the user's language ("3 minutes ago").
 * @param {number} at - epoch ms
 * @param {number} now - epoch ms
 * @param {string} [lang] - Foundry's language code
 */
export function sinceText(at, now, lang) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }); }
  if (seconds < 60) return rtf.format(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

/**
 * The dot's tooltip. While connected it also says when Chronicle last sent
 * a change, so a quiet dot can be told apart from a stuck one.
 * @param {string} state
 * @param {{ lastChangeAt: number|null, now: number, lang?: string,
 *   localize: (k: string) => string, format: (k: string, d: object) => string }} opts
 */
export function statusTooltip(state, { lastChangeAt, now, lang, localize, format }) {
  const key = stateKey(state);
  const base = localize(`CHRONICLE.Status.Tooltip.${key}`);
  if (key !== 'connected') return base;
  const when = lastChangeAt
    ? format('CHRONICLE.Status.LastChange', { when: sinceText(lastChangeAt, now, lang) })
    : localize('CHRONICLE.Status.NoChangeYet');
  return `${base}\n${when}`;
}

/** Whether a client event is a change from Chronicle rather than the client's own bookkeeping. */
export function isChronicleChange(msg) {
  const type = typeof msg?.type === 'string' ? msg.type : '';
  return !!type && !type.startsWith('sync.');
}
