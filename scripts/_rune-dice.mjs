/**
 * Pure rules behind the rune dice in Dice So Nice (scripts/dice-so-nice.mjs):
 * reading the shipped set list, turning it into Dice So Nice registrations,
 * and choosing the look of one die from the roller's Chronicle picks.
 *
 * The set list is a data file, so a new set or a moved file is a data change,
 * and a bad entry drops only itself. No Foundry globals here, so
 * tools/test-rune-dice.mjs can pin every rule off-DOM.
 */

/** Where the set list lives, relative to the module folder. */
export const MANIFEST_PATH = 'assets/dice/rune/manifest.json';

/** Every file a set names must sit under this folder of the module. */
export const ASSET_ROOT = 'assets/dice/rune/';

/** Ids Dice So Nice sees: one colorset per set, one dice system per set with faces. */
export const ID_PREFIX = 'chronicle-rune';

/** The group players see in Dice So Nice's dice and theme lists. */
export const GROUP = 'Chronicle Rune';

/** Die types Chronicle rolls; Dice So Nice knows each one. */
export const DIE_TYPES = Object.freeze(['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100']);

/** Materials Dice So Nice accepts in a colorset; anything else is left to the player. */
export const MATERIALS = Object.freeze([
  'plastic', 'metal', 'glass', 'wood', 'chrome', 'stone', 'velvet', 'resin', 'frosted', 'pristine', 'iridescent',
]);

/** Face labels are 2D images; a model replaces the whole die. */
const LABEL_EXT = /\.(png|webp|jpe?g)$/i;
const MODEL_EXT = /\.(glb|gltf)$/i;

const SET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOUR_KEYS = ['foreground', 'background', 'outline', 'edge'];

/** How many faces each die type needs labels for. */
const FACES = Object.freeze({ d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 10 });

/**
 * A file path a set may name: relative, inside ASSET_ROOT, no `..`, no scheme,
 * with a known extension. Anything else could point Dice So Nice at a file we
 * don't ship.
 * @param {*} p
 * @param {RegExp} ext
 * @returns {string|null}
 */
export function safeAssetPath(p, ext) {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s.startsWith(ASSET_ROOT) || s.includes('..') || s.includes('\\') || /[?#:]/.test(s)) return null;
  if (!ext.test(s)) return null;
  return s;
}

/**
 * Read the shipped set list. Never throws: a broken file is one problem, a
 * broken set is one problem and the other sets still load.
 * @param {*} raw - parsed JSON
 * @returns {{version: number, sets: object[], problems: {code: string, set?: string, detail?: string}[]}}
 */
export function readManifest(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sets)) {
    return { version: 0, sets: [], problems: [{ code: 'ManifestShape' }] };
  }
  const version = Number.isInteger(raw.version) ? raw.version : 0;
  if (version !== 1) problems.push({ code: 'ManifestVersion', detail: String(raw.version) });

  const sets = [];
  const seen = new Set();
  for (const entry of raw.sets) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!SET_ID.test(id)) {
      problems.push({ code: 'SetId', detail: String(entry?.id ?? '') });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ code: 'SetDuplicate', set: id });
      continue;
    }
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 60) : id;

    const colours = {};
    for (const key of COLOUR_KEYS) {
      const v = entry.colours?.[key];
      if (v == null) continue;
      if (typeof v === 'string' && HEX.test(v)) colours[key] = v;
      else problems.push({ code: 'SetColour', set: id, detail: key });
    }

    let material = null;
    if (entry.material != null) {
      if (MATERIALS.includes(entry.material)) material = entry.material;
      else problems.push({ code: 'SetMaterial', set: id, detail: String(entry.material) });
    }

    const faces = {};
    for (const [type, list] of Object.entries(entry.faces ?? {})) {
      if (!DIE_TYPES.includes(type)) {
        problems.push({ code: 'FaceType', set: id, detail: type });
        continue;
      }
      const paths = Array.isArray(list) ? list.map((p) => safeAssetPath(p, LABEL_EXT)) : [];
      if (paths.length !== FACES[type] || paths.some((p) => !p)) {
        problems.push({ code: 'FaceList', set: id, detail: type });
        continue;
      }
      faces[type] = paths;
    }

    const models = {};
    for (const [type, p] of Object.entries(entry.models ?? {})) {
      const path = DIE_TYPES.includes(type) ? safeAssetPath(p, MODEL_EXT) : null;
      if (path) models[type] = path;
      else problems.push({ code: 'ModelPath', set: id, detail: type });
    }

    sets.push({ id, name, colours, material, faces, models });
  }
  return { version, sets, problems };
}

/** @param {string} setId */
export const colorsetId = (setId) => `${ID_PREFIX}-${setId}`;
/** @param {string} setId */
export const systemId = (setId) => `${ID_PREFIX}-${setId}`;

/**
 * Turn the read sets into what Dice So Nice is handed. Paths are prefixed with
 * the module folder so Dice So Nice loads them from where Foundry serves us.
 * @param {object[]} sets - from readManifest
 * @param {string} moduleRoot - e.g. "modules/chronicle-sync/"
 * @returns {{colorsets: object[], systems: object[], presets: object[], files: string[]}}
 */
export function buildRegistrations(sets, moduleRoot) {
  let root = moduleRoot || '';
  if (root && !root.endsWith('/')) root += '/';
  const colorsets = [];
  const systems = [];
  const presets = [];
  const files = new Set();
  for (const s of sets ?? []) {
    const cs = { name: colorsetId(s.id), description: s.name, category: GROUP, ...s.colours };
    if (s.material) cs.material = s.material;
    colorsets.push(cs);

    const types = new Set([...Object.keys(s.faces), ...Object.keys(s.models)]);
    if (!types.size) continue;
    systems.push({ id: systemId(s.id), name: s.name, group: GROUP });
    for (const type of DIE_TYPES) {
      if (!types.has(type)) continue;
      const preset = { type, system: systemId(s.id), colorset: colorsetId(s.id) };
      if (s.faces[type]) {
        preset.labels = s.faces[type].map((p) => root + p);
        preset.labels.forEach((p) => files.add(p));
      }
      if (s.models[type]) {
        preset.modelFile = root + s.models[type];
        files.add(preset.modelFile);
      }
      presets.push(preset);
    }
  }
  return { colorsets, systems, presets, files: [...files] };
}

/**
 * The Dice So Nice look for one die, from its roller's Chronicle picks. The
 * die wears its roller's set; the viewer's own Dice So Nice settings decide
 * the rest. An unknown or unregistered set gives null, so the die keeps the
 * viewer's normal look instead of a broken one.
 * @param {{set?: string, colour?: string}} pick
 * @param {{colorsets: Set<string>, systems: Set<string>}} registered - what actually registered on this client
 * @returns {{colorset: string, system?: string, background?: string}|null}
 */
export function appearanceFor(pick, registered) {
  const setId = typeof pick?.set === 'string' ? pick.set : '';
  if (!SET_ID.test(setId) || !registered?.colorsets?.has(colorsetId(setId))) return null;
  const look = { colorset: colorsetId(setId) };
  if (registered.systems?.has(systemId(setId))) look.system = systemId(setId);
  if (typeof pick.colour === 'string' && HEX.test(pick.colour)) look.background = pick.colour;
  return look;
}
