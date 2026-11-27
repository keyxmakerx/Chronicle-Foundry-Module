/**
 * Which documents this client is still unlinking after a player changed
 * their link. Between that change reaching this client and the unlink
 * landing, the document still names the page the player chose, so a lookup
 * by link finds it; a Chronicle change applied in that window would write
 * that page into it. Writers ask `holds` right before each write, with no
 * await in between, and skip the write when it says no.
 */
export default class LinkFence {
  constructor() {
    this._undoing = new Map();
    this._failed = new Set();
  }

  /**
   * Run an unlink with the document fenced until it lands. The fence goes
   * up and the write starts synchronously, so a hook that calls this has
   * fenced the document before it returns. An unlink that fails leaves the
   * document fenced until a later unlink of it lands, since it still names
   * the player's page; the next start's link check undoes that link.
   * @param {string} id
   * @param {() => Promise<unknown>} write
   * @returns {Promise<unknown>}
   */
  undo(id, write) {
    this._undoing.set(id, (this._undoing.get(id) ?? 0) + 1);
    const release = () => {
      const n = (this._undoing.get(id) ?? 1) - 1;
      if (n > 0) this._undoing.set(id, n);
      else this._undoing.delete(id);
    };
    const fail = (err) => {
      this._failed.add(id);
      throw err;
    };
    let pending;
    try {
      pending = Promise.resolve(write());
    } catch (err) {
      pending = Promise.reject(err);
    }
    const landed = (value) => {
      this._failed.delete(id);
      return value;
    };
    return pending.then(landed, fail).finally(release);
  }

  /**
   * Whether a write for `entityId` may go to the document now: it is still
   * linked to that page, no unlink of it is in flight and none has failed.
   * @param {string} id - the document's id
   * @param {string|null|undefined} linkedTo - the document's link as of now
   * @param {string} entityId - the page the write carries
   * @returns {boolean}
   */
  holds(id, linkedTo, entityId) {
    return !!entityId && linkedTo === entityId && !this._undoing.has(id) && !this._failed.has(id);
  }
}
