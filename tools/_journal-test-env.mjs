/**
 * Foundry global stubs for tests that drive JournalSync / ActorSync / SyncManager.
 * Import this before the module under test.
 */
globalThis.CONST = globalThis.CONST || {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
globalThis.foundry = globalThis.foundry || {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (b) => b } },
};

export const settings = {
  syncJournals: true,
  syncCharacters: true,
  journalCreateTypeId: 0,
  conflictResolution: 'chronicle',
  syncExclusions: '{"excludedTypes":[],"excludedEntities":[]}',
  dmOnlyHidden: true,
  defaultOwnership: 2,
  syncPermissions: true,
  userMappings: '{}',
  skipIncomingSanitization: false,
  apiUrl: 'http://chronicle.test',
  lastSyncTime: '',
};

export const notes = { warn: [], info: [], error: [] };

globalThis.game = {
  settings: {
    get: (_m, k) => settings[k],
    set: async (_m, k, v) => { settings[k] = v; },
    register: () => {},
    registerMenu: () => {},
  },
  i18n: { localize: (k) => k, format: (k, d) => `${k}${d ? JSON.stringify(d) : ''}` },
  modules: { get: () => null },
  user: { id: 'gm', isGM: true },
  users: { get: () => null, contents: [] },
  folders: { find: () => null, contents: [] },
  actors: { contents: [] },
  journal: { contents: [], find: () => null, get: () => null },
};
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {} };
globalThis.ui = {
  notifications: {
    warn: (m) => notes.warn.push(m),
    info: (m) => notes.info.push(m),
    error: (m) => notes.error.push(m),
  },
};
globalThis.Folder = { create: async () => ({ id: 'folder-1' }) };

/** In-memory journal collection backed by an array; `find` mirrors Foundry's. */
export function installJournals(list) {
  globalThis.game.journal = {
    contents: list,
    find: (fn) => list.find(fn) || null,
    get: (id) => list.find((j) => j.id === id) || null,
  };
  return list;
}

/** A journal stand-in that records its updates and applies flag writes. */
export function makeJournal({ id = 'j1', name = 'Journal', flags = {}, pages = [], folder = null, ownership = { default: 2 }, log = [] } = {}) {
  const j = {
    id, name, pages, folder, ownership, flags,
    updates: log,
    getFlag: (_s, k) => j.flags[k],
    setFlag: async (_s, k, v) => { j.flags[k] = v; },
    update: async (data, options) => {
      j.updates.push({ data, options });
      for (const [k, v] of Object.entries(data)) {
        const m = k.match(/^flags\.[^.]+\.(.+)$/);
        if (m) j.flags[m[1]] = v;
        else if (k === 'name') j.name = v;
      }
    },
  };
  return j;
}
