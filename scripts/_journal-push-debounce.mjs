/**
 * Per-journal debounce for Foundry -> Chronicle journal pushes.
 *
 * A GM typing in a journal fires `updateJournalEntry` on every keystroke's
 * autosave, and a PUT per edit would run into the API key's 60
 * requests/minute limit (API-CONTRACT.md) and draw 429s. This collapses a
 * burst into one push, scheduled `delayMs` after the last edit, keyed per
 * journal so edits to different journals never debounce each other.
 * Mirrors map-sync.mjs's per-mapId `_notifyTimers` debounce.
 *
 * Pure — no Foundry globals — so timing is testable with node:test's mock
 * timers. See tools/test-journal-push-debounce.mjs.
 */

/** Default debounce window: long enough to collapse a typing burst, short
 * enough that a GM never waits long to see their edit land on Chronicle. */
export const JOURNAL_PUSH_DEBOUNCE_MS = 2000;

export class JournalPushDebouncer {
  /**
   * @param {(...args: unknown[]) => void} pushFn - Called with the args
   *   passed to `schedule` once the debounce window elapses (or on flush).
   * @param {number} [delayMs]
   */
  constructor(pushFn, delayMs = JOURNAL_PUSH_DEBOUNCE_MS) {
    this._pushFn = pushFn;
    this._delayMs = delayMs;
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._timers = new Map();
    /** @type {Map<string, unknown[]>} */
    this._pending = new Map();
  }

  /**
   * (Re)start the debounce window for `key`. A later call before the
   * window elapses cancels the earlier one and restarts it — only the
   * latest args survive, which is what "push the last edit" requires.
   * @param {string} key
   * @param {...unknown} args
   */
  schedule(key, ...args) {
    this.cancel(key);
    this._pending.set(key, args);
    const timer = setTimeout(() => {
      this._timers.delete(key);
      this._pending.delete(key);
      this._pushFn(...args);
    }, this._delayMs);
    this._timers.set(key, timer);
  }

  /**
   * Cancel a pending push for `key` without running it. No-op if nothing
   * is pending.
   * @param {string} key
   */
  cancel(key) {
    const timer = this._timers.get(key);
    if (timer) clearTimeout(timer);
    this._timers.delete(key);
    this._pending.delete(key);
  }

  /**
   * Run `key`'s pending push immediately, if any. Used when a journal
   * closes or the world unloads — the last edit must never be lost to a
   * timer that never gets to fire.
   * @param {string} key
   * @returns {boolean} true if something was pending and got flushed.
   */
  flush(key) {
    const timer = this._timers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this._timers.delete(key);
    const args = this._pending.get(key);
    this._pending.delete(key);
    this._pushFn(...args);
    return true;
  }

  /** Flush every pending push immediately (world unload). */
  flushAll() {
    for (const key of [...this._timers.keys()]) {
      this.flush(key);
    }
  }
}
