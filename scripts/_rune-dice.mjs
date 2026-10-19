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

/**
 * The rune set ids Chronicle's rolls carry. A listed set outside these still
 * loads, but no Chronicle roll will ever ask for it, so the check flags it.
 */
export const RUNE_SET_IDS = Object.freeze([
  'jewelled', 'confetti', 'acrylic', 'cage', 'heartlight', 'gothic',
  'obsidian', 'moonstone', 'oak', 'nebula', 'bone', 'scale',
]);

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

/** A set with no colours listed still gets one theme, so its dice can register. */
const DEFAULT_COLOUR = 'default';

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
    if (!RUNE_SET_IDS.includes(id)) problems.push({ code: 'SetUnknown', set: id });
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 60) : id;

    // Each set comes in several colours, each its own key, the same keys
    // Chronicle's roll carries; the first is the set's default.
    const colours = [];
    const seenColour = new Set();
    for (const c of Array.isArray(entry.colours) ? entry.colours : []) {
      const cid = typeof c?.id === 'string' ? c.id.trim() : '';
      if (!SET_ID.test(cid) || seenColour.has(cid)) {
        problems.push({ code: 'ColourId', set: id, detail: String(c?.id ?? '') });
        continue;
      }
      seenColour.add(cid);
      const values = {};
      for (const key of COLOUR_KEYS) {
        const v = c[key];
        if (v == null) continue;
        if (typeof v === 'string' && HEX.test(v)) values[key] = v;
        else problems.push({ code: 'SetColour', set: id, detail: `${cid}.${key}` });
      }
      const cname = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 60) : cid;
      colours.push({ id: cid, name: cname, values });
    }
    if (entry.colours != null && !Array.isArray(entry.colours)) problems.push({ code: 'SetColour', set: id, detail: 'colours' });
    if (!colours.length) colours.push({ id: DEFAULT_COLOUR, name, values: {} });

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

/**
 * One Dice So Nice theme per set colour. The double dash keeps "a-b" + "c"
 * apart from "a" + "b-c".
 * @param {string} setId
 * @param {string} colourId
 */
export const colorsetId = (setId, colourId) => `${ID_PREFIX}-${setId}--${colourId}`;
/** @param {string} setId */
export const systemId = (setId) => `${ID_PREFIX}-${setId}`;

/**
 * Turn the read sets into what Dice So Nice is handed. Paths are prefixed with
 * the module folder so Dice So Nice loads them from where Foundry serves us.
 * @param {object[]} sets - from readManifest
 * @param {string} moduleRoot - e.g. "modules/chronicle-sync/"
 * @returns {{colorsets: object[], setOf: Map<string, string>, systems: object[], presets: object[], files: string[]}} `setOf` maps each theme to its set
 */
export function buildRegistrations(sets, moduleRoot) {
  let root = moduleRoot || '';
  if (root && !root.endsWith('/')) root += '/';
  const colorsets = [];
  const setOf = new Map();
  const systems = [];
  const presets = [];
  const files = new Set();
  for (const s of sets ?? []) {
    for (const c of s.colours) {
      const cs = { name: colorsetId(s.id, c.id), description: c.id === DEFAULT_COLOUR ? s.name : `${s.name}: ${c.name}`, category: GROUP, ...c.values };
      if (s.material) cs.material = s.material;
      colorsets.push(cs);
      setOf.set(cs.name, s.id);
    }

    const types = new Set([...Object.keys(s.faces), ...Object.keys(s.models)]);
    if (!types.size) continue;
    systems.push({ id: systemId(s.id), name: s.name, group: GROUP });
    for (const type of DIE_TYPES) {
      if (!types.has(type)) continue;
      const preset = { type, system: systemId(s.id), colorset: colorsetId(s.id, s.colours[0].id) };
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
  return { colorsets, setOf, systems, presets, files: [...files] };
}

/**
 * The Dice So Nice look for one die, from its roller's Chronicle picks: the
 * roller's set in the roller's colour. A colour that didn't register here
 * falls back to the set's first registered colour; a set that didn't register
 * gives null, so the die keeps the viewer's own look instead of a broken one.
 * @param {{set?: string, colour?: string}} pick
 * @param {{colorsets: Set<string>, systems: Set<string>, defaults: Map<string, string>}} registered - what registered on this client; `defaults` maps a set to its first registered theme
 * @returns {{colorset: string, system?: string}|null}
 */
export function appearanceFor(pick, registered) {
  const setId = typeof pick?.set === 'string' ? pick.set : '';
  if (!SET_ID.test(setId) || !registered?.colorsets) return null;
  const wanted = typeof pick.colour === 'string' && SET_ID.test(pick.colour) ? colorsetId(setId, pick.colour) : '';
  const colorset = registered.colorsets.has(wanted) ? wanted : registered.defaults?.get(setId);
  if (!colorset) return null;
  const look = { colorset };
  if (registered.systems?.has(systemId(setId))) look.system = systemId(setId);
  return look;
}

/** The Dice So Nice trigger a Chronicle crit die carries; players bind effects to its results. */
export const CRIT_TRIGGER = 'chronicle-crit';

/** Chronicle's crits, by the key a die's `succ` / `fail` pick carries. */
export const CRITS = Object.freeze([
  { id: 'storm', name: 'Storm call', kind: 'succ' },
  { id: 'phoenix', name: 'Phoenix', kind: 'succ' },
  { id: 'dawn', name: 'Dawnbreak', kind: 'succ' },
  { id: 'starfall', name: 'Starfall', kind: 'succ' },
  { id: 'bloom', name: 'Wildbloom', kind: 'succ' },
  { id: 'hoard', name: "Dragon's hoard", kind: 'succ' },
  { id: 'grasp', name: 'Eldritch grasp', kind: 'fail' },
  { id: 'frost', name: 'Frostbite', kind: 'fail' },
  { id: 'shatter', name: 'Shatter', kind: 'fail' },
  { id: 'hex', name: 'Hex', kind: 'fail' },
  { id: 'crows', name: 'Murder of crows', kind: 'fail' },
  { id: 'abyss', name: 'The abyss', kind: 'fail' },
]);

/** Chronicle's default picks, used when a crit die names none or an unknown one. */
export const DEFAULT_CRIT = Object.freeze({ succ: 'phoenix', fail: 'grasp' });

/**
 * Dice So Nice's own effects stand in for the rune crits, which are drawn on
 * Chronicle's stage and don't run inside Dice So Nice. These lines only reach
 * players who never saved their effect settings; anyone can rebind them.
 */
const STAND_IN = Object.freeze({ succ: 'PlayAnimationParticleSparkles', fail: 'PlayAnimationDark' });

/**
 * What registers the crits: the trigger with one named result per crit, and
 * the stand-in effect lines for new players.
 * @returns {{trigger: {id: string, name: string, results: {id: string, name: string}[]}, defaults: object[]}}
 */
export function critRegistrations() {
  const byKind = (kind) => CRITS.filter((c) => c.kind === kind).map((c) => c.id);
  return {
    trigger: { id: CRIT_TRIGGER, name: 'Chronicle crit', results: CRITS.map((c) => ({ id: c.id, name: c.name })) },
    defaults: ['succ', 'fail'].map((kind) => ({ diceType: CRIT_TRIGGER, onResult: byKind(kind), specialEffect: STAND_IN[kind] })),
  };
}

/**
 * The Dice So Nice `sfx` option for one die of a Chronicle roll: its roller's
 * crit pick when the die crits, else null. An unknown pick plays the default
 * crit of that kind, so a crit never goes silent over a renamed key.
 * @param {{crit?: 'succ'|'fail'|null, succ?: string, fail?: string}} die
 * @returns {{id: string, result: string}|null}
 */
export function critSfx(die) {
  const kind = die?.crit;
  if (kind !== 'succ' && kind !== 'fail') return null;
  const pick = die[kind];
  const known = CRITS.some((c) => c.id === pick && c.kind === kind);
  return { id: CRIT_TRIGGER, result: known ? pick : DEFAULT_CRIT[kind] };
}
