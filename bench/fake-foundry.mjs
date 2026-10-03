/**
 * An in-memory Foundry world for the two-sided sync bench.
 *
 * It implements just the document API the module's sync code calls, with
 * Foundry's semantics where sync bugs live: every write (including
 * `setFlag`) fires the matching hook with the diff, the write options and
 * the user id; hook handlers run synchronously and are not awaited; embedded
 * pages fire their own hooks. Nothing here is a mock of the module: the bench
 * runs the real `scripts/*.mjs` against this world and a real Chronicle.
 */

let idCounter = 0;
/** Foundry-style 16-character id, deterministic per process for readable logs. */
export function randomID() {
  idCounter += 1;
  return `bench${String(idCounter).padStart(11, '0')}`;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Expand `{ 'a.b': 1 }` into `{ a: { b: 1 } }`, keeping `-=key` deletions. */
export function expandObject(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    const parts = key.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = isPlainObject(node[parts[i]]) ? node[parts[i]] : {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    node[last] = isPlainObject(value) && isPlainObject(node[last])
      ? mergeInto(node[last], expandObject(value))
      : (isPlainObject(value) ? expandObject(value) : value);
  }
  return out;
}

/** Deep-merge `src` into `target` in place; `-=key` deletes `key`. */
function mergeInto(target, src) {
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith('-=')) { delete target[key.slice(2)]; continue; }
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}

/** The part of `change` that differs from `before` (Foundry's update diff). */
function diff(before, change) {
  const out = {};
  for (const [key, value] of Object.entries(change)) {
    if (key.startsWith('-=')) {
      if (before && key.slice(2) in before) out[key] = null;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(before?.[key])) {
      const inner = diff(before[key], value);
      if (Object.keys(inner).length) out[key] = inner;
    } else if (JSON.stringify(before?.[key]) !== JSON.stringify(value)) {
      out[key] = clone(value);
    }
  }
  return out;
}

export function getProperty(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* ----------------------------------------------------------------- Hooks */

export function makeHooks(log) {
  const handlers = new Map();
  let nextId = 1;
  const hooks = {
    on(name, fn) {
      const id = nextId++;
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push({ id, fn, once: false });
      return id;
    },
    once(name, fn) {
      const id = hooks.on(name, fn);
      handlers.get(name).at(-1).once = true;
      return id;
    },
    off(name, fnOrId) {
      const list = handlers.get(name) || [];
      handlers.set(name, list.filter((h) => h.fn !== fnOrId && h.id !== fnOrId));
    },
    /** Foundry runs handlers in order and does not await a returned promise. */
    callAll(name, ...args) {
      for (const h of [...(handlers.get(name) || [])]) {
        if (h.once) hooks.off(name, h.id);
        try {
          const ret = h.fn(...args);
          if (ret && typeof ret.catch === 'function') {
            ret.catch((err) => log.hookErrors.push({ name, err }));
          }
        } catch (err) {
          log.hookErrors.push({ name, err });
        }
      }
      return true;
    },
    call(name, ...args) { return hooks.callAll(name, ...args); },
  };
  return hooks;
}

/* ------------------------------------------------------------- Documents */

class Collection {
  constructor() { this._map = new Map(); }
  get contents() { return [...this._map.values()]; }
  get size() { return this._map.size; }
  get(id) { return this._map.get(id) || null; }
  getName(name) { return this.contents.find((d) => d.name === name) || null; }
  find(fn) { return this.contents.find(fn) || null; }
  filter(fn) { return this.contents.filter(fn); }
  map(fn) { return this.contents.map(fn); }
  some(fn) { return this.contents.some(fn); }
  forEach(fn) { this.contents.forEach(fn); }
  [Symbol.iterator]() { return this.contents[Symbol.iterator](); }
  set(id, doc) { this._map.set(id, doc); }
  delete(id) { return this._map.delete(id); }
}

/**
 * Base document: plain data in `_source`, live fields mirrored onto the
 * instance, writes go through `update` so hooks always fire.
 */
class BenchDocument {
  constructor(world, type, data) {
    this._world = world;
    this.documentName = type;
    this._source = { _id: data._id || randomID(), name: '', flags: {}, ownership: { default: 0 }, ...clone(data) };
    this._refresh();
  }

  get id() { return this._source._id; }
  get _id() { return this._source._id; }
  get uuid() { return `${this.documentName}.${this.id}`; }

  _refresh() {
    for (const [k, v] of Object.entries(this._source)) {
      if (k === '_id' || k === 'folder' || k === 'pages' || k === 'items') continue;
      this[k] = v;
    }
  }

  get folder() {
    const id = this._source.folder;
    return id ? this._world.game.folders.get(id) : null;
  }

  getFlag(scope, key) { return getProperty(this._source.flags?.[scope], key); }

  async setFlag(scope, key, value) {
    return this.update({ [`flags.${scope}.${key}`]: value });
  }

  async unsetFlag(scope, key) {
    return this.update({ [`flags.${scope}.-=${key}`]: null });
  }

  toObject() { return clone(this._source); }

  testUserPermission(user, level) {
    const lv = typeof level === 'number' ? level : this._world.CONST.DOCUMENT_OWNERSHIP_LEVELS[level];
    const have = this._source.ownership?.[user?.id] ?? this._source.ownership?.default ?? 0;
    return user?.isGM || have >= lv;
  }

  async update(data, options = {}) {
    if (!this._world.collectionFor(this.documentName).get(this.id) && !this._parent) return undefined;
    const change = diff(this._source, expandObject(data));
    if (!Object.keys(change).length) return this;
    mergeInto(this._source, change);
    this._refresh();
    this._world.log.writes.push({ op: 'update', type: this.documentName, id: this.id, change, options });
    change._id = this.id;
    this._world.Hooks.callAll(`update${this.documentName}`, this, change, options, this._world.game.user.id);
    return this;
  }

  async delete(options = {}) {
    const coll = this._world.collectionFor(this.documentName);
    if (!coll.get(this.id)) return undefined;
    coll.delete(this.id);
    this._world.log.writes.push({ op: 'delete', type: this.documentName, id: this.id, options });
    this._world.Hooks.callAll(`delete${this.documentName}`, this, options, this._world.game.user.id);
    return this;
  }
}

/** Embedded page: lives in its journal's `pages`, fires JournalEntryPage hooks. */
class BenchPage extends BenchDocument {
  constructor(world, parent, data) {
    super(world, 'JournalEntryPage', { type: 'text', text: { content: '', format: 1 }, sort: 0, ...data });
    this._parent = parent;
    this.parent = parent;
  }

  async update(data, options = {}) {
    const change = diff(this._source, expandObject(data));
    if (!Object.keys(change).length) return this;
    mergeInto(this._source, change);
    this._refresh();
    this._world.log.writes.push({ op: 'update', type: 'JournalEntryPage', id: this.id, parent: this.parent.id, change, options });
    change._id = this.id;
    this._world.Hooks.callAll('updateJournalEntryPage', this, change, options, this._world.game.user.id);
    return this;
  }

  async delete(options = {}) {
    return (await this.parent.deleteEmbeddedDocuments('JournalEntryPage', [this.id], options))[0];
  }
}

class BenchJournal extends BenchDocument {
  constructor(world, data) {
    const { pages = [], ...rest } = data;
    super(world, 'JournalEntry', rest);
    this.pages = new Collection();
    for (const p of pages) {
      const page = new BenchPage(world, this, p);
      this.pages.set(page.id, page);
    }
  }

  toObject() {
    return { ...clone(this._source), pages: this.pages.map((p) => p.toObject()) };
  }

  async createEmbeddedDocuments(type, list, options = {}) {
    const made = [];
    for (const data of list) {
      const page = new BenchPage(this._world, this, data);
      this.pages.set(page.id, page);
      made.push(page);
      this._world.log.writes.push({ op: 'create', type: 'JournalEntryPage', id: page.id, parent: this.id, options });
      this._world.Hooks.callAll('createJournalEntryPage', page, options, this._world.game.user.id);
    }
    return made;
  }

  async updateEmbeddedDocuments(type, list, options = {}) {
    const out = [];
    for (const data of list) {
      const page = this.pages.get(data._id);
      if (page) out.push(await page.update(data, options));
    }
    return out;
  }

  async deleteEmbeddedDocuments(type, ids, options = {}) {
    const out = [];
    for (const id of ids) {
      const page = this.pages.get(id);
      if (!page) continue;
      this.pages.delete(id);
      out.push(page);
      this._world.log.writes.push({ op: 'delete', type: 'JournalEntryPage', id, parent: this.id, options });
      this._world.Hooks.callAll('deleteJournalEntryPage', page, options, this._world.game.user.id);
    }
    return out;
  }
}

class BenchActor extends BenchDocument {
  constructor(world, data) {
    const { items = [], ...rest } = data;
    super(world, 'Actor', { type: 'character', system: {}, img: '', prototypeToken: {}, ...rest });
    this.items = new Collection();
    for (const i of items) this.items.set(i._id || randomID(), { ...i });
  }
}

class BenchFolder extends BenchDocument {
  constructor(world, data) {
    super(world, 'Folder', { type: 'JournalEntry', ...data });
  }
}

/* ----------------------------------------------------------------- World */

/**
 * Install a fresh Foundry world on `globalThis` and return it.
 *
 * Documents survive `SyncManager` restarts (a world reload keeps its
 * journals); `settings` is the world's saved settings, so a restart sees the
 * previous `lastSyncTime` exactly as Foundry would.
 * @param {{settings?: object, user?: object}} [opts]
 */
export function installFoundry({ settings = {}, systemId = 'dnd5e' } = {}) {
  const log = { writes: [], hookErrors: [], notifications: { info: [], warn: [], error: [] } };
  const world = { log };
  const Hooks = makeHooks(log);
  world.Hooks = Hooks;

  const CONST = { DOCUMENT_OWNERSHIP_LEVELS: { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 } };
  world.CONST = CONST;

  const gmUser = {
    id: 'benchGMuser00001', name: 'Bench GM', isGM: true, role: 4, flags: {},
    getFlag(scope, key) { return this.flags[`${scope}.${key}`]; },
    async setFlag(scope, key, value) { this.flags[`${scope}.${key}`] = value; },
  };
  const users = new Collection();
  users.set(gmUser.id, gmUser);

  const registered = new Map();
  const values = { ...settings };
  const journal = new Collection();
  const actors = new Collection();
  const folders = new Collection();

  const game = {
    user: gmUser,
    users,
    journal,
    actors,
    folders,
    items: new Collection(),
    scenes: new Collection(),
    system: { id: systemId, version: '5.0.0' },
    version: '14.300',
    modules: { get: () => null },
    time: { worldTime: 0, components: {} },
    i18n: {
      localize: (k) => k,
      format: (k, data) => `${k}${data ? ' ' + JSON.stringify(data) : ''}`,
      has: () => false,
    },
    clipboard: { copyPlainText: async () => {} },
    socket: { on() {}, off() {}, emit() {} },
    settings: {
      register(scope, key, cfg) {
        registered.set(key, cfg);
        if (!(key in values)) values[key] = clone(cfg?.default);
      },
      registerMenu() {},
      get(scope, key) {
        if (!registered.has(key) && !(key in values)) throw new Error(`setting ${scope}.${key} is not registered`);
        return values[key];
      },
      async set(scope, key, value) { values[key] = clone(value); return value; },
      sheet: { render() {} },
    },
  };
  world.game = game;
  world.settingsValues = values;

  world.collectionFor = (type) => ({ JournalEntry: journal, Actor: actors, Folder: folders }[type]);

  function makeDocClass(type, Impl) {
    return class {
      static get documentName() { return type; }
      static async create(data, options = {}) {
        const list = Array.isArray(data) ? data : [data];
        const out = [];
        for (const d of list) {
          const doc = new Impl(world, d);
          world.collectionFor(type).set(doc.id, doc);
          log.writes.push({ op: 'create', type, id: doc.id, options });
          Hooks.callAll(`create${type}`, doc, options, gmUser.id);
          out.push(doc);
        }
        return Array.isArray(data) ? out : out[0];
      }
      static async createDocuments(list, options) { return this.create(list, options); }
    };
  }

  const ui = {
    notifications: {
      info: (m) => { log.notifications.info.push(String(m)); },
      warn: (m) => { log.notifications.warn.push(String(m)); },
      error: (m) => { log.notifications.error.push(String(m)); },
    },
    windows: {},
  };

  Object.assign(globalThis, {
    game,
    Hooks,
    ui,
    CONST,
    JournalEntry: makeDocClass('JournalEntry', BenchJournal),
    Actor: makeDocClass('Actor', BenchActor),
    Folder: makeDocClass('Folder', BenchFolder),
    fromUuid: async (uuid) => {
      const [type, id] = String(uuid).split('.');
      return world.collectionFor(type)?.get(id) || null;
    },
    foundry: {
      utils: {
        randomID,
        expandObject,
        getProperty,
        deepClone: clone,
        mergeObject: (a, b) => mergeInto(clone(a) || {}, expandObject(b)),
        escapeHTML: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
      },
      applications: {
        api: {
          ApplicationV2: class { render() { return this; } close() {} },
          HandlebarsApplicationMixin: (b) => b,
          DialogV2: { confirm: async () => world.answerConfirm ?? false, prompt: async () => null, wait: async () => null },
        },
        ux: { TextEditor: { implementation: { enrichHTML: async (s) => s }, cleanHTML: (s) => s } },
      },
    },
    TextEditor: { enrichHTML: async (s) => s, cleanHTML: (s) => s },
  });

  return world;
}
