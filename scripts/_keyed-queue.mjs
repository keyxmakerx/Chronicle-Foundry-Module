/**
 * Per-key promise queue: tasks for one key run strictly in arrival order,
 * tasks for different keys run independently. Used so a burst of Chronicle
 * events for one entity (created, updated, updated) applies in order and
 * never interleaves its awaits, without making unrelated entities wait.
 *
 * A failing task rejects only its own promise; the key's chain carries on.
 * Pure — see tools/test-keyed-queue.mjs.
 */
export class KeyedQueue {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} Tail of each key's chain. */
    this._tails = new Map();
  }

  /**
   * Run `task` after every earlier task for `key` has settled.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} task
   * @returns {Promise<T>}
   */
  run(key, task) {
    const prev = this._tails.get(key) || Promise.resolve();
    const result = prev.then(task);
    // The tail swallows rejections so one failure does not poison the chain.
    const tail = result.catch(() => {});
    this._tails.set(key, tail);
    tail.then(() => {
      if (this._tails.get(key) === tail) this._tails.delete(key);
    });
    return result;
  }

  /** @param {string} key @returns {boolean} true while `key` has queued or running work. */
  isBusy(key) {
    return this._tails.has(key);
  }
}
