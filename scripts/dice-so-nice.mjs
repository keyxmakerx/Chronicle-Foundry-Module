/**
 * Chronicle Sync - Dice So Nice bridge
 *
 * Registers the rune dice with Dice So Nice on every client that runs it, and
 * keeps a record of what happened so the Health pane can say what broke. A
 * client without Dice So Nice (not installed, off, the /stream page, the
 * canvas turned off) registers nothing and rolls show in chat as Foundry's
 * normal roll card.
 *
 * Only Dice So Nice's documented calls on `game.dice3d` are used, and plain
 * objects are passed, so nothing here imports a file from Dice So Nice's
 * folder. Every call is wrapped: a failure is recorded, never thrown into a
 * roll or into Foundry's startup.
 */

import { MODULE_ID } from './constants.mjs';
import { log } from './logger.mjs';
import { DSN_ID, OPTIONAL_API, REQUIRED_API, judgeDiceSoNice } from './_dice-so-nice-check.mjs';
import { MANIFEST_PATH, appearanceFor, buildRegistrations, readManifest } from './_rune-dice.mjs';

/** After our ready, how long Dice So Nice gets to start before the check calls it stuck. */
const START_GRACE_MS = 30000;

/** The file check asks for at most this many files at once. */
const FILE_CHECK_BATCH = 8;

const state = {
  readyAt: 0,
  hookFired: false,
  manifest: null,
  registration: null,
  files: null,
  registered: { colorsets: new Set(), systems: new Set(), defaults: new Map() },
};

const moduleRoot = () => `modules/${MODULE_ID}/`;

/** Register the hook. Call from `init`: Dice So Nice starts after Foundry's ready. */
export function registerDiceSoNice() {
  Hooks.once('diceSoNiceReady', (dice3d) => {
    state.hookFired = true;
    onDiceReady(dice3d).catch((err) => log.warn('Dice So Nice: registration stopped', err));
  });
  Hooks.once('ready', () => { state.readyAt = Date.now(); });
}

async function loadManifest() {
  try {
    const res = await fetch(foundry.utils.getRoute(moduleRoot() + MANIFEST_PATH), { cache: 'no-cache' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, sets: [] };
    const read = readManifest(await res.json());
    return { ok: true, problems: read.problems, setCount: read.sets.length, sets: read.sets };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), sets: [] };
  }
}

async function onDiceReady(dice3d) {
  const missing = REQUIRED_API.filter((m) => typeof dice3d?.[m] !== 'function');
  if (missing.length) {
    log.warn(`Dice So Nice: calls missing (${missing.join(', ')}); rune dice not registered`);
    return;
  }
  const manifest = await loadManifest();
  state.manifest = manifest;
  for (const p of manifest.problems ?? []) log.warn('Dice So Nice: rune dice list', p);
  if (!manifest.ok) {
    log.warn(`Dice So Nice: rune dice list unreadable (${manifest.error})`);
    return;
  }

  const plan = buildRegistrations(manifest.sets, moduleRoot());
  const errors = [];
  const attempt = async (step, id, fn) => {
    try {
      await fn();
      return true;
    } catch (err) {
      errors.push({ step, id, message: String(err?.message || err).slice(0, 200) });
      log.warn(`Dice So Nice: ${step} ${id} failed`, err);
      return false;
    }
  };

  for (const cs of plan.colorsets) {
    if (!(await attempt('colorset', cs.name, () => dice3d.addColorset(cs, 'default')))) continue;
    state.registered.colorsets.add(cs.name);
    const set = plan.setOf.get(cs.name);
    if (!state.registered.defaults.has(set)) state.registered.defaults.set(set, cs.name);
  }
  for (const sys of plan.systems) {
    if (await attempt('system', sys.id, () => dice3d.addSystem(sys, 'default'))) state.registered.systems.add(sys.id);
  }
  let presets = 0;
  for (const p of plan.presets) {
    if (!state.registered.systems.has(p.system)) continue;
    if (await attempt('preset', `${p.system}/${p.type}`, () => dice3d.addDicePreset(p))) presets++;
  }
  if (typeof dice3d.preloadPresets === 'function') {
    for (const id of state.registered.systems) await attempt('preload', id, () => dice3d.preloadPresets(id));
  }

  state.registration = {
    colorsets: state.registered.colorsets.size,
    systems: state.registered.systems.size,
    presets,
    errors,
    files: plan.files,
  };
}

/**
 * The Dice So Nice look for one die, for a chat roll built from a Chronicle
 * roll. Null when Dice So Nice isn't running here or the set didn't register;
 * the die then keeps the viewer's own look.
 * @param {{set?: string, colour?: string}} pick
 */
export function diceAppearance(pick) {
  if (!game.dice3d) return null;
  return appearanceFor(pick, state.registered);
}

/** Facts for the check, as this client sees them now. */
function gatherFacts() {
  const mod = game.modules.get(DSN_ID);
  const api = game.dice3d;
  const methods = api ? [...REQUIRED_API, ...OPTIONAL_API].filter((m) => typeof api[m] === 'function') : [];
  let enabled;
  try {
    if (typeof api?.isEnabled === 'function') enabled = !!api.isEnabled();
  } catch {
    enabled = undefined;
  }
  let noCanvas = false;
  try {
    noCanvas = !!game.settings.get('core', 'noCanvas');
  } catch {
    noCanvas = false;
  }
  return {
    installed: !!mod,
    active: !!mod?.active,
    version: mod?.version || '',
    streamView: game.view === 'stream',
    noCanvas,
    hasApi: !!api,
    ready: state.hookFired,
    waitedLong: state.readyAt > 0 && Date.now() - state.readyAt > START_GRACE_MS,
    methods,
    enabled,
    manifest: state.manifest
      ? { ok: state.manifest.ok, error: state.manifest.error, problems: state.manifest.problems, setCount: state.manifest.setCount }
      : null,
    registration: state.registration,
    files: state.files,
  };
}

/**
 * Ask Foundry's server for every file the rune dice name. GM-started from the
 * Health pane only, because it makes one request per file.
 */
export async function checkDiceFiles() {
  // Without Dice So Nice the list was never read; read it now so the GM can
  // still see whether the shipped files are where the list says.
  if (!state.manifest) state.manifest = await loadManifest();
  const list = state.registration?.files ?? buildRegistrations(state.manifest.sets ?? [], moduleRoot()).files;
  const out = [];
  for (let i = 0; i < list.length; i += FILE_CHECK_BATCH) {
    const batch = list.slice(i, i + FILE_CHECK_BATCH);
    out.push(...await Promise.all(batch.map(async (path) => {
      try {
        const res = await fetch(foundry.utils.getRoute(path), { method: 'HEAD', cache: 'no-cache' });
        return { path, ok: res.ok, status: res.status };
      } catch {
        return { path, ok: false, status: 0 };
      }
    })));
  }
  state.files = out;
  return out;
}

/**
 * The Health pane's view: judged rows with their words filled in.
 * @returns {{state: string, rows: {level: string, text: string, fix: string}[], facts: object}}
 */
export function diceSoNiceReport() {
  const facts = gatherFacts();
  const judged = judgeDiceSoNice(facts);
  const say = (key, data) => {
    const full = `CHRONICLE.Dice.Check.${key}`;
    return game.i18n.has(full) ? game.i18n.format(full, data) : '';
  };
  const rows = judged.rows.map((r) => {
    const data = { ...r.data };
    if (r.code === 'ManifestProblem') data.problem = say(`Problem.${r.data.problem}`, r.data) || r.data.problem;
    return { level: r.level, text: say(r.code, data) || r.code, fix: say(`${r.code}Fix`, data) };
  });
  return { state: judged.state, rows, facts };
}
