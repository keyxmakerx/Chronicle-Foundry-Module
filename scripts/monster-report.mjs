/**
 * Chronicle Sync - Monsters this world can place.
 *
 * Tells Chronicle which monsters Foundry has (POST /sync/monsters), so the
 * DM's AI builds fights from them instead of writing copies, and lets the
 * Encounters tab bring a compendium monster into the world when a fight
 * names one no world actor answers. A monster is brought in once, into the
 * "Chronicle: From compendiums" folder, and reused by every later fight, so
 * placing never makes doubles. GM only. Pure parts: _monster-report.mjs.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { CREATURE_FLAG } from './creature-sync.mjs';
import { getSetting } from './settings.mjs';
import { log } from './logger.mjs';
import { buildMonsterReport, compendiumChoices, indexFields, monsterPaths } from './_monster-report.mjs';

/** Marks the folder compendium monsters are brought into. */
export const COMPENDIUM_FOLDER_FLAG = 'compendiumFolder';

const state = {
  /** @type {object|null|undefined} The system's creature fields; undefined until read. */
  defs: undefined,
  /** @type {Array<{name: string, uuid: string, pack: string}>} */
  choices: [],
  /** @type {Array<object>|null} Compendium indexes, read again only when asked. */
  packs: null,
};

/** The system's creature fields, read once a session; null when it has none. */
async function loadDefs(api) {
  if (state.defs !== undefined) return state.defs;
  const system = getSetting('detectedSystem');
  if (!system) return null;
  try {
    state.defs = await api.get(`/systems/${system}/creature-fields`);
  } catch (err) {
    // An older Chronicle has no creature-fields route: stop asking. Anything
    // else (a rate limit, a restart) is asked again on the next report.
    if (err?.status === 404) state.defs = null;
    else log.warn('Monster report: could not read creature fields', err);
    return null;
  }
  return state.defs;
}

/** A CONFIG choice's label, localized; null when the list has no such key. */
function labelOf(choicesPath, value) {
  const list = foundry.utils.getProperty(globalThis.CONFIG, choicesPath);
  const entry = list?.[value];
  const label = typeof entry === 'string' ? entry : entry?.label;
  return label ? game.i18n.localize(label) : null;
}

/** Every Actor compendium's index, with only the fields a report needs. */
async function readPacks(fields) {
  const out = [];
  for (const pack of game.packs ?? []) {
    if (pack.documentName !== 'Actor') continue;
    try {
      const index = await pack.getIndex({ fields });
      out.push({ label: pack.metadata?.label ?? pack.title ?? pack.collection, entries: [...index] });
    } catch (err) {
      log.warn(`Monster report: could not read the ${pack.collection} compendium`, err);
    }
  }
  return out;
}

/**
 * The report body, or null when the system has no creature fields (there is
 * then no way to tell a monster from any other actor). Refreshes the list the
 * Encounters tab falls back on. Compendiums seldom change while a world is
 * open, so their indexes are read again only with `fresh` (on connect).
 * @param {import('./api-client.mjs').ChronicleAPI} api
 * @param {{fresh?: boolean}} [opts]
 */
export async function buildMonsterBody(api, { fresh = false } = {}) {
  const defs = await loadDefs(api);
  const actorType = defs?.foundry_actor_type;
  if (!actorType) return null;
  const paths = monsterPaths(defs);
  if (fresh || !state.packs) state.packs = await readPacks(indexFields(paths));
  const packs = state.packs;
  state.choices = compendiumChoices(packs, actorType);
  const actors = (game.actors?.contents ?? []).map((a) => ({ doc: a, page: a.getFlag(FLAG_SCOPE, CREATURE_FLAG) || '' }));
  return buildMonsterReport({ actors, packs, actorType, paths, labelOf });
}

/** The compendium monsters a fight row may be brought in from. */
export function compendiumMonsters() {
  return state.choices;
}

/** The folder compendium monsters go into, made the first time. */
async function compendiumFolder() {
  let folder = game.folders.find((f) => f.type === 'Actor' && f.getFlag(FLAG_SCOPE, COMPENDIUM_FOLDER_FLAG));
  if (!folder) {
    folder = await Folder.create({
      name: game.i18n.localize('CHRONICLE.Encounters.CompendiumFolder'),
      type: 'Actor',
      flags: { [FLAG_SCOPE]: { [COMPENDIUM_FOLDER_FLAG]: true } },
    });
  }
  return folder;
}

/**
 * The world actor for a compendium entry: one already brought in from it,
 * else a new one in the compendium folder.
 * @param {{uuid: string, name: string}} entry
 * @returns {Promise<Actor|null>}
 */
export async function bringInMonster(entry) {
  const have = game.actors.find((a) => a._stats?.compendiumSource === entry.uuid || a.getFlag?.('core', 'sourceId') === entry.uuid);
  if (have) return have;
  const doc = await fromUuid(entry.uuid);
  if (!doc) return null;
  const folder = await compendiumFolder();
  const data = game.actors.fromCompendium(doc);
  data.folder = folder.id;
  return Actor.implementation.create(data);
}
