/**
 * Boots the real module against a fake Foundry world and a real Chronicle.
 *
 * `openWorld` is "the GM loads the world": a new SyncManager with the real
 * sync modules, connected over REST and WebSocket. `closeWorld` is "the GM
 * closes Foundry": hooks and socket go away, documents and settings stay, so
 * the next `openWorld` starts from exactly what Foundry would have saved.
 */

import { installFoundry } from './fake-foundry.mjs';
import { CHRONICLE_URL } from './chronicle.mjs';
import { buildChronicleFields } from '../scripts/adapters/generic-adapter.mjs';
import { ITEMS_CHANGED } from '../scripts/_actor-field-diff.mjs';

// The module narrates on console.debug/log; keep the bench output to results
// unless asked (BENCH_VERBOSE=1). Warnings and errors still print.
if (!process.env.BENCH_VERBOSE) {
  console.debug = () => {};
  console.log = () => {};
}

/** Requests the module has sent and not yet seen answered. */
const traffic = { inflight: 0, last: Date.now(), requests: [] };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  // A site-root path is Foundry serving one of the open world's files.
  if (typeof url === 'string' && url.startsWith('/')) {
    const file = traffic.files?.get(url.slice(1));
    return file?.blob
      ? new Response(file.blob, { status: 200, headers: { 'content-type': file.type } })
      : new Response('', { status: 404 });
  }
  const isModule = String(init?.headers?.Authorization || init?.headers?.authorization || '').includes(traffic.moduleKey || '\u0000');
  if (!isModule) return realFetch(url, init);
  // "Chronicle can't be reached": the request never leaves, as on a dropped network.
  if (traffic.offline) throw new TypeError('fetch failed');
  traffic.inflight += 1;
  traffic.last = Date.now();
  const entry = { method: init.method || 'GET', url: String(url).replace(CHRONICLE_URL, '').replace(/^\/api\/v1\/campaigns\/[^/]+/, ''), body: init.body, status: 0 };
  traffic.requests.push(entry);
  // A scenario can act at the moment a request leaves, while it is in flight.
  traffic.onSend?.(entry);
  try {
    const res = await realFetch(url, init);
    entry.status = res.status;
    return res;
  } finally {
    traffic.inflight -= 1;
    traffic.last = Date.now();
  }
};

let modulesLoaded = null;
async function loadModule() {
  // The module reads Foundry globals at import time in a few places, so the
  // first world must be installed before this runs.
  modulesLoaded ??= Promise.all([
    import('../scripts/settings.mjs'),
    import('../scripts/sync-manager.mjs'),
    import('../scripts/journal-sync.mjs'),
    import('../scripts/actor-sync.mjs'),
    import('../scripts/item-sync.mjs'),
    import('../scripts/map-sync.mjs'),
    import('../scripts/creature-sync.mjs'),
    import('../scripts/player-asks.mjs'),
  ]).then(([settings, sm, js, as, is, ms, cs, pa]) => ({
    registerSettings: settings.registerSettings,
    SyncManager: sm.SyncManager,
    JournalSync: js.JournalSync,
    ActorSync: as.ActorSync,
    ItemSync: is.ItemSync,
    MapSync: ms.MapSync,
    CreatureSync: cs.CreatureSync,
    PlayerAsks: pa.PlayerAsks,
  }));
  return modulesLoaded;
}

/**
 * A minimal game-system adapter: Chronicle `fields_data.hp` is Foundry
 * `system.hp`, and the name follows the entity.
 */
export const benchAdapter = {
  systemId: 'bench',
  actorType: 'character',
  characterTypeSlug: 'character',
  // Same shape the generic adapter builds from a system's single-item fields.
  identityFields: ['ancestry', 'kit'].map((key) => ({
    key, type: 'string', foundry_collection: 'items', foundry_item_type: [key], foundry_item_single: true,
  })),
  // `hp` is the one mapped scalar, so it is what a layer's effect can change.
  // `subclass` is mapped to its item as Draw Steel maps it, so a subclass
  // picked in Chronicle can be noted for the player to add.
  fieldDefs: [
    { key: 'hp', type: 'number', foundry_path: 'system.hp' },
    { key: 'subclass', type: 'string', foundry_collection: 'items', foundry_item_type: ['subclass'], foundry_item_single: true, foundry_item_join: true },
  ],
  fromChronicleFields(entity) {
    const out = {};
    if (entity?.name) out.name = entity.name;
    const hp = entity?.fields_data?.hp;
    if (hp !== undefined && hp !== null) out['system.hp'] = hp;
    return out;
  },
  toChronicleFields(actor) {
    return actor.system?.hp === undefined ? {} : { hp: actor.system.hp };
  },
  // The item types those fields read, so adding, editing or removing one in
  // Foundry pushes it as the generic adapter does.
  itemFieldTypes: new Set(['ancestry', 'kit', 'subclass']),
  toChronicleFieldsChanged(actor, change) {
    const out = change?.system?.hp === undefined ? {} : { hp: change.system.hp };
    const items = change?.[ITEMS_CHANGED];
    if (items) {
      for (const def of benchAdapter.identityFields) {
        const got = buildChronicleFields(actor, [def]);
        if (def.key in got) out[def.key] = got[def.key];
        else if (items[def.key] === 'deleted') out[def.key] = '';
      }
      // The subclass is Foundry-led, so it is pushed but never swapped.
      const sub = benchAdapter.fieldDefs.find((d) => d.key === 'subclass');
      Object.assign(out, buildChronicleFields(actor, [sub]));
    }
    return Object.keys(out).length ? out : null;
  },
};

/**
 * A system's creature fields, standing in for an installed package the same
 * way `benchAdapter` does: the fantasy campaign's own Creature type, its
 * `challenge_rating` as `system.cr`, and `hp` as Foundry-owned current
 * Stamina.
 */
export const benchCreatureFields = {
  system_id: 'bench',
  preset_slug: 'creature',
  foundry_actor_type: 'npc',
  foundry_pull_fields: ['hp'],
  fields: [
    { key: 'challenge_rating', label: 'Challenge Rating', type: 'string', foundry_path: 'system.cr' },
    { key: 'hp', label: 'HP', type: 'number', foundry_path: 'system.hp' },
  ],
};

/**
 * A system's item fields once the campaign's Items have switched to them,
 * standing in for the Draw Steel package the same way. The bench campaign's
 * Items have only Type, Rarity and Requires Attunement, and the sync API
 * cannot add fields, so Type carries the treasure's category and Rarity its
 * words here; keywords are covered by tools/test-treasure-item.mjs. The
 * CONFIG list is the slice of Draw Steel's that these fields read.
 */
export const benchItemFields = {
  system_id: 'bench',
  foundry_item_type: 'treasure',
  fields: [
    { key: 'type', label: 'Type', foundry_path: 'system.category', foundry_choices: 'DRAW_STEEL.equipment.categories' },
    { key: 'rarity', label: 'Effect', foundry_path: 'system.description.value', foundry_format: 'html_section' },
  ],
};
export const benchItemConfig = {
  DRAW_STEEL: { equipment: { categories: { consumable: {}, trinket: {}, leveled: {}, artifact: {} } } },
};

/** A new, empty Foundry world wired to `seed`'s campaign. */
export function newWorld(seed, { settings = {}, systemId } = {}) {
  const world = installFoundry({
    systemId,
    settings: {
      apiUrl: CHRONICLE_URL,
      apiKey: seed.moduleKey,
      campaignId: seed.campaignId,
      syncEnabled: true,
      syncJournals: true,
      syncCharacters: false,
      syncMaps: false,
      syncCalendar: false,
      ...settings,
    },
  });
  world.seed = seed;
  // Same name as the Chronicle owner, so member matching links them.
  world.game.user.name = seed.displayName;
  traffic.moduleKey = seed.moduleKey;
  return world;
}

/** The GM opens the world: start sync and wait for the first pull to finish. */
export async function openWorld(world, { modules = ['journals'], itemFields = null } = {}) {
  const m = await loadModule();
  // Re-install this world's globals (another scenario may have run since).
  Object.assign(globalThis, world.globals ??= {
    game: globalThis.game, Hooks: globalThis.Hooks, ui: globalThis.ui, CONST: globalThis.CONST,
    JournalEntry: globalThis.JournalEntry, Actor: globalThis.Actor, Folder: globalThis.Folder,
    foundry: globalThis.foundry, ChatMessage: globalThis.ChatMessage, fromUuid: globalThis.fromUuid, TextEditor: globalThis.TextEditor,
  });
  traffic.moduleKey = world.seed.moduleKey;
  traffic.files = world.files;
  if (!world.settingsRegistered) {
    m.registerSettings();
    world.settingsRegistered = true;
  }
  const sm = new m.SyncManager();
  if (modules.includes('journals')) sm.registerModule(new m.JournalSync());
  if (modules.includes('actors')) {
    // The one stand-in on the module side: a game system's field mapping.
    // Real adapters come from an installed system package, which a fresh
    // bench Chronicle has none of; everything else is the real ActorSync.
    const actors = new m.ActorSync();
    actors._loadAdapter = async () => benchAdapter;
    sm.registerModule(actors);
  }
  if (modules.includes('creatures')) {
    const creatures = new m.CreatureSync();
    creatures._loadDefs = async () => benchCreatureFields;
    sm.registerModule(creatures);
  }
  if (modules.includes('items')) {
    const items = new m.ItemSync();
    if (itemFields) {
      // Stands in for item-fields after the campaign's switch, as above.
      items._loadItemFields = async function () {
        this._itemFields = itemFields.fields;
        this._itemType = itemFields.foundry_item_type;
      };
    }
    sm.registerModule(items);
  }
  if (modules.includes('playerAsks')) sm.registerModule(world.playerAsks = new m.PlayerAsks());
  if (modules.includes('maps')) sm.registerModule(new m.MapSync());
  world.syncManager = sm;
  await sm.start();
  await waitFor(() => sm._initialSyncDone, 20000, 'initial sync');
  await settle();
  return sm;
}

/** The GM closes Foundry. */
export async function closeWorld(world) {
  await settle();
  world.syncManager?.stop();
  world.syncManager = null;
}

/** Resolve once `fn()` is truthy, or fail with `what` after `ms`. */
export async function waitFor(fn, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Wait until the module has been quiet for longer than its longest debounce
 * (2 s), so every push and every WebSocket-driven apply has landed.
 */
export async function settle(quietMs = 2600) {
  // Quiet is measured from the later of the last request and this call, so
  // an edit made just before settling still gets its debounced push.
  const start = Date.now();
  await waitFor(
    () => traffic.inflight === 0 && Date.now() - Math.max(traffic.last, start) >= quietMs,
    60000,
    'module to go quiet',
  );
}

/** Requests the module sent while `fn` ran. */
export async function recordRequests(fn) {
  const start = traffic.requests.length;
  await fn();
  return traffic.requests.slice(start);
}

export { traffic };
