/**
 * The monsters this world can place, as Chronicle's AI connection reads them
 * (POST /sync/monsters): the world's actors of the system's creature type and
 * the entries of its Actor compendiums, each with the few numbers a DM builds
 * a fight from. Which numbers, and where they live on an actor, come from the
 * system's creature fields in Chronicle (`level`, `role`, `organization`,
 * `ev`), so nothing here knows a game system.
 *
 * Pure: the actors, compendium indexes and CONFIG lookups are passed in.
 * See tools/test-monster-report.mjs.
 */

import { readPath } from './_actor-apply-plan.mjs';

/** Chronicle keeps at most this many; past it the report says it is cut. */
export const MONSTER_REPORT_MAX = 5000;

/** The creature fields a report carries, by Chronicle key. */
const KEYS = ['level', 'role', 'organization', 'ev'];

/**
 * Where each reported number lives on an actor, and the CONFIG list that
 * labels it, from Chronicle's creature fields.
 * @param {{fields?: Array<object>}|null} defs
 * @returns {Object<string, {path: string, choices: string|null}>}
 */
export function monsterPaths(defs) {
  const out = {};
  for (const f of defs?.fields ?? []) {
    if (KEYS.includes(f.key) && f.foundry_path) out[f.key] = { path: f.foundry_path, choices: f.foundry_choices || null };
  }
  return out;
}

/** The index fields to ask a compendium for, so no document is loaded. */
export function indexFields(paths) {
  return ['type', ...Object.values(paths).map((p) => p.path)];
}

/**
 * A value as words: a choice's label when the system lists one, else the
 * value itself. Lists and objects are left out rather than guessed at.
 */
function words(raw, choices, labelOf) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'object') return '';
  if (choices) {
    const label = labelOf(choices, raw);
    if (label) return String(label);
  }
  return String(raw);
}

/**
 * One report entry from an actor or an index entry.
 * @param {object} src - `{name, system, ...}` as the document or index holds it.
 * @param {object} p
 * @param {Object<string, {path: string, choices: string|null}>} p.paths
 * @param {(choicesPath: string, value: *) => string|null} p.labelOf
 * @param {string} [p.pack] - The compendium's label; empty for a world actor.
 * @param {string} [p.page] - The Chronicle page creature sync made it from.
 */
export function monsterEntry(src, { paths, labelOf, pack = '', page = '' }) {
  const out = { name: String(src?.name ?? '').trim() };
  if (pack) out.pack = pack;
  for (const key of KEYS) {
    const p = paths[key];
    if (!p) continue;
    const v = words(readPath(src, p.path), p.choices, labelOf);
    if (v) out[key] = v;
  }
  if (page) {
    out.linked = true;
    out.page = page;
  }
  return out;
}

/**
 * The whole report body. World actors come first, since Foundry places
 * those first; entries of the wrong type and nameless ones are left out.
 * @param {object} p
 * @param {Array<{doc: object, page: string}>} p.actors - `page` is the Chronicle page creature sync made it from, else empty.
 * @param {Array<{label: string, entries: Array<object>}>} p.packs
 * @param {string} p.actorType - The system's creature actor type ("npc").
 * @param {Object<string, {path: string, choices: string|null}>} p.paths
 * @param {(choicesPath: string, value: *) => string|null} p.labelOf
 * @param {number} [p.max]
 * @returns {{monsters: Array<object>, truncated: boolean}}
 */
export function buildMonsterReport({ actors, packs, actorType, paths, labelOf, max = MONSTER_REPORT_MAX }) {
  const monsters = [];
  let truncated = false;
  const add = (entry) => {
    if (!entry.name) return;
    if (monsters.length >= max) { truncated = true; return; }
    monsters.push(entry);
  };
  for (const a of actors) {
    if (a.doc?.type !== actorType) continue;
    add(monsterEntry(a.doc, { paths, labelOf, page: a.page }));
  }
  for (const pk of packs) {
    for (const e of pk.entries) {
      if (e?.type !== actorType) continue;
      add(monsterEntry(e, { paths, labelOf, pack: pk.label }));
    }
  }
  return { monsters, truncated };
}

/**
 * The compendium entries a fight row can fall back on, by name.
 * @param {Array<{label: string, entries: Array<object>}>} packs
 * @param {string} actorType
 * @returns {Array<{name: string, uuid: string, pack: string}>}
 */
export function compendiumChoices(packs, actorType) {
  const out = [];
  for (const pk of packs) {
    for (const e of pk.entries) {
      if (e?.type === actorType && e.name && e.uuid) out.push({ name: e.name, uuid: e.uuid, pack: pk.label });
    }
  }
  return out;
}
