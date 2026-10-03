/**
 * Echo suppression scoped to the notes Chronicle is currently applying.
 *
 * While a pull writes a Foundry note, Foundry fires the note hook for that
 * very write; pushing it back would duplicate or loop. A global "syncing"
 * flag also swallowed every unrelated GM edit made during the pull, so the
 * guard names what is being applied instead: local ids (update/delete) and
 * a name+date key (create, where the id does not exist until the hook has
 * already fired). Reference-counted so overlapping applies don't unmask each
 * other.
 */

/** @param {{name?:string, year?:number, month?:number, day?:number}|null} p */
export function echoKey(p) {
  if (!p) return null;
  return `${p.year}-${p.month}-${p.day}|${String(p.name ?? '').trim()}`;
}

export class ApplyGuard {
  constructor() {
    /** @type {Map<string, number>} */
    this._ids = new Map();
    /** @type {Map<string, number>} */
    this._keys = new Map();
  }

  static _inc(map, k) { map.set(k, (map.get(k) || 0) + 1); }

  static _dec(map, k) {
    const n = (map.get(k) || 0) - 1;
    if (n > 0) map.set(k, n); else map.delete(k);
  }

  /** @param {{ids?: Array<string|null|undefined>, keys?: Array<string|null>}} scope */
  begin({ ids = [], keys = [] } = {}) {
    const token = { ids: ids.filter(Boolean).map(String), keys: keys.filter(Boolean) };
    token.ids.forEach((i) => ApplyGuard._inc(this._ids, i));
    token.keys.forEach((k) => ApplyGuard._inc(this._keys, k));
    return token;
  }

  /** Add an id learned mid-apply (a created note's id). */
  addId(token, id) {
    if (id == null || !token) return;
    token.ids.push(String(id));
    ApplyGuard._inc(this._ids, String(id));
  }

  end(token) {
    if (!token) return;
    token.ids.forEach((i) => ApplyGuard._dec(this._ids, i));
    token.keys.forEach((k) => ApplyGuard._dec(this._keys, k));
  }

  /**
   * True when a hook payload is the echo of an in-flight apply.
   * @param {{id?: string|null, key?: string|null}} probe
   */
  isEcho({ id, key } = {}) {
    if (id != null && this._ids.has(String(id))) return true;
    return !!key && this._keys.has(key);
  }

  /** Run fn with the scope held, always releasing it. */
  async run(scope, fn) {
    const token = this.begin(scope);
    try { return await fn(token); } finally { this.end(token); }
  }
}
