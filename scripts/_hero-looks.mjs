/**
 * Pure rules for the Chronicle hero sheet (scripts/hero-looks.mjs): which
 * look a hero is drawn in, how Draw Steel's parts are arranged, and the
 * display figures the boxes show. Every number shown comes from Draw Steel's
 * own prepared data; this file only turns it into widths and labels.
 */

/** The looks a hero can be drawn in, first one the default. */
export const HERO_LOOKS = Object.freeze([
  Object.freeze({ id: 'chronicle', label: 'CHRONICLE.HeroSheet.Looks.chronicle' }),
]);

export const DEFAULT_LOOK = HERO_LOOKS[0].id;

/** The actor flag holding a hero's look, under the module's scope. */
export const LOOK_FLAG = 'heroLook';

/**
 * The oldest Draw Steel the sheet is built for. Before 1.1 skills lived at
 * system.hero.skills and the hero templates differ, so the sheet would break.
 */
export const MIN_DRAW_STEEL = '1.1.0';

/**
 * Whether a Draw Steel system version is MIN_DRAW_STEEL or later. Only plain
 * dotted numbers count: a missing or odd version is not offered the sheet.
 * @param {unknown} version  game.system.version
 * @returns {boolean}
 */
export function drawSteelSupported(version) {
  const parse = (v) => (typeof v === 'string' && /^\d+(?:\.\d+){0,2}$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const have = parse(version);
  if (!have) return false;
  const need = parse(MIN_DRAW_STEEL);
  for (let i = 0; i < need.length; i++) {
    const h = have[i] ?? 0;
    if (h !== need[i]) return h > need[i];
  }
  return true;
}

/**
 * The look to draw: the hero's own choice when it is a known look, else the default.
 * @param {unknown} flag
 * @returns {string}
 */
export function resolveLook(flag) {
  return HERO_LOOKS.some((l) => l.id === flag) ? flag : DEFAULT_LOOK;
}

/**
 * Draw Steel's parts in the Chronicle order: header, the always-shown
 * boxes, then the tabs and their panes. Every part keeps its id, because
 * Draw Steel prepares context, refreshes ("stats" on a combat change) and
 * routes drops (onto "projects") by id.
 * @param {Record<string, object>} baseParts  Draw Steel's PARTS
 * @param {{header: object, stats: object}} own  the look's header and stats parts
 * @returns {Record<string, object>}
 */
export function chronicleParts(baseParts, own) {
  const parts = { header: own.header, stats: own.stats };
  for (const [id, part] of Object.entries(baseParts)) {
    if (!(id in parts)) parts[id] = part;
  }
  return parts;
}

/** Tab order on the Chronicle sheet; tabs Draw Steel adds later go last. */
const TAB_ORDER = ['abilities', 'features', 'equipment', 'projects', 'effects', 'biography'];

/**
 * Draw Steel's tab group without the Stats tab, whose boxes sit above the
 * tabs instead, abilities first.
 * @param {{primary?: {tabs?: {id: string}[], initial?: string}}} baseTabs  Draw Steel's TABS
 * @returns {object}
 */
export function chronicleTabs(baseTabs) {
  const primary = baseTabs?.primary ?? {};
  const rank = (id) => {
    const i = TAB_ORDER.indexOf(id);
    return i === -1 ? TAB_ORDER.length : i;
  };
  const tabs = (primary.tabs ?? [])
    .filter((t) => t.id !== 'stats')
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.id) - rank(b.t.id) || a.i - b.i)
    .map(({ t }) => t);
  const initial = tabs.some((t) => t.id === 'abilities') ? 'abilities' : tabs[0]?.id;
  return { ...baseTabs, primary: { ...primary, tabs, initial } };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (part, whole) => Math.round(Math.min(1, Math.max(0, part / whole)) * 1000) / 10;

/**
 * What the Stamina box draws. Thresholds are Draw Steel's: winded at or
 * under `winded`, dying at or under 0, dead at or under `min`.
 * @param {{value?: number|null, max?: number, temporary?: number, winded?: number, min?: number}} stamina
 * @returns {{value: number|null, max: number|null, temporary: number, fill: number, windedAt: number|null, band: string}}
 */
export function staminaView(stamina = {}) {
  const value = num(stamina.value);
  const max = num(stamina.max);
  const winded = num(stamina.winded);
  const min = num(stamina.min);
  const temporary = Math.max(0, num(stamina.temporary) ?? 0);
  let band = 'unknown';
  if (value !== null) {
    if (min !== null && value <= min) band = 'dead';
    else if (value <= 0) band = 'dying';
    else if (winded !== null && value <= winded) band = 'winded';
    else band = 'healthy';
  }
  const hasMax = max !== null && max > 0;
  return {
    value,
    max,
    temporary,
    fill: hasMax && value !== null && value > 0 ? pct(value, max) : 0,
    windedAt: hasMax && winded !== null && winded > 0 ? pct(winded, max) : null,
    band,
  };
}

/**
 * One dot per recovery, filled while it is unspent. A hero with more than
 * `cap` gets the number alone.
 * @param {number} value
 * @param {number} max
 * @param {number} [cap]
 * @returns {boolean[]|null}
 */
export function recoveryDots(value, max, cap = 12) {
  const m = num(max);
  if (m === null || m <= 0 || m > cap) return null;
  const v = Math.max(0, Math.min(m, num(value) ?? 0));
  return Array.from({ length: m }, (_, i) => i < v);
}

/**
 * The conditions a hero has now, named as the token HUD names them. The
 * stamina states are left out, because the Stamina box already says them.
 * @param {Iterable<string>} statusIds  the actor's statuses
 * @param {{id: string, name?: string, img?: string}[]} statusEffects  CONFIG.statusEffects
 * @param {Iterable<string>} [hidden]  ids the Stamina box covers
 * @returns {{id: string, name: string, img: string|null}[]}
 */
export function conditionList(statusIds, statusEffects, hidden = []) {
  const skip = new Set(hidden);
  const known = new Map((statusEffects ?? []).filter((s) => s?.id).map((s) => [s.id, s]));
  const out = [];
  for (const id of statusIds ?? []) {
    if (skip.has(id) || !known.has(id)) continue;
    const s = known.get(id);
    out.push({ id, name: s.name || id, img: s.img || null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
