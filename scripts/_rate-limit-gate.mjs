/**
 * One shared pause for every REST call after Chronicle answers 429.
 *
 * Chronicle limits each API key per minute and says in Retry-After when the
 * window reopens. Every caller waits on the same gate, so a burst that hits
 * the limit stops sending instead of each request failing on its own, and a
 * re-render does not fire the same burst into a closed window.
 */

/** Wait used when Chronicle sends no usable Retry-After. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;

/** Longest single pause; Chronicle's window is one minute. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Times one request is re-sent after a 429 before its caller sees the error. */
export const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Milliseconds to wait from a Retry-After header: delta-seconds or an HTTP
 * date, clamped to between one second and a minute.
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number}
 */
export function parseRetryAfter(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  let ms = NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = Number(raw) * 1000;
  else if (raw) {
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) ms = at - now;
  }
  if (!Number.isFinite(ms)) ms = DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

export class RateLimitGate {
  constructor() {
    /** @type {number} Epoch ms before which nothing is sent. */
    this.until = 0;
  }

  /** Pause every request until `ms` from now; a longer pause already set wins. */
  block(ms, now = Date.now()) {
    this.until = Math.max(this.until, now + ms);
  }

  /** Milliseconds a request must still wait. */
  remaining(now = Date.now()) {
    return Math.max(0, this.until - now);
  }

  /** Resolve once the pause is over; re-checks because a new 429 may extend it. */
  async wait(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    for (let ms = this.remaining(); ms > 0; ms = this.remaining()) await sleep(ms);
  }
}
