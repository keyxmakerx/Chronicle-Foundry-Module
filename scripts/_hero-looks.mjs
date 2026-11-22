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

const isLook = (id) => HERO_LOOKS.some((l) => l.id === id);

/**
 * The look to draw. The GM's world default stands in for a hero with no
 * choice of its own, and replaces every choice while the GM has locked it.
 * An unknown id falls through to the next.
 * @param {unknown} flag  the hero's own choice
 * @param {{worldDefault?: unknown, locked?: boolean}} [world]
 * @returns {string}
 */
export function resolveLook(flag, { worldDefault, locked = false } = {}) {
  const fallback = isLook(worldDefault) ? worldDefault : DEFAULT_LOOK;
  if (locked) return fallback;
  return isLook(flag) ? flag : fallback;
}

/** The other hero sheets the look picker offers, by the ids Foundry stores. */
export const DRAW_STEEL_SHEET = 'draw-steel.DrawSteelHeroSheet';
export const DRAW_STEEL_PLUS_SHEET = 'draw-steel-plus.DrawSteelPlusHeroSheet';
export const DRAW_STEEL_PLUS_MODULE = 'draw-steel-plus';

/**
 * The look picker's rows: each Chronicle look, then Draw Steel Plus while
 * that module is on and its sheet registered, then Draw Steel's own sheet,
 * always, so nobody is stuck on a look they dislike. A lock greys out the
 * Chronicle looks for players; the other sheets stay open to them.
 * @param {{current: string, locked?: boolean, isGM?: boolean, plusActive?: boolean, registered?: (id: string) => boolean}} state
 * @returns {{kind: 'look'|'sheet', id: string, label: string, note: string|null, tag: string|null, checked: boolean, disabled: boolean}[]}
 */
export function pickerRows({ current, locked = false, isGM = false, plusActive = false, registered = () => true }) {
  const lockedOut = locked && !isGM;
  const rows = HERO_LOOKS.map((l) => ({
    kind: 'look',
    id: l.id,
    label: l.label,
    note: lockedOut ? 'CHRONICLE.HeroSheet.Picker.Locked' : null,
    tag: l.id === current ? 'CHRONICLE.HeroSheet.Picker.Now' : null,
    checked: l.id === current,
    disabled: lockedOut && l.id !== current,
  }));
  if (plusActive && registered(DRAW_STEEL_PLUS_SHEET)) {
    rows.push({
      kind: 'sheet', id: DRAW_STEEL_PLUS_SHEET, label: 'CHRONICLE.HeroSheet.Picker.Plus',
      note: 'CHRONICLE.HeroSheet.Picker.PlusNote', tag: 'CHRONICLE.HeroSheet.Picker.Found', checked: false, disabled: false,
    });
  }
  rows.push({
    kind: 'sheet', id: DRAW_STEEL_SHEET, label: 'CHRONICLE.HeroSheet.Picker.DrawSteel',
    note: 'CHRONICLE.HeroSheet.Picker.DrawSteelNote', tag: null, checked: false, disabled: false,
  });
  return rows;
}

/**
 * The portrait menu's rows. Everyone may see the full picture, as Draw
 * Steel's portrait allows; the token is for owners, as in Draw Steel's title
 * bar menu.
 * "Change picture or token" opens the hero's Chronicle page, so it is for an
 * owner, on a linked hero, who has a Chronicle account: the GM, or a player
 * mapped to a Chronicle user (anyone else would land on a sign-in page).
 * Edit mode adds Foundry's file picker first, as Draw Steel's portrait does.
 * @param {{isPlay: boolean, editable: boolean, limited: boolean, isOwner: boolean, isGM: boolean, mapped: boolean, hasTokenArt: boolean, chronicleUrl: string|null}} state
 * @returns {{action: string, label: string, note: string|null}[]}
 */
export function portraitRows(state) {
  const rows = [];
  if (!state.isPlay && state.editable) {
    rows.push({ action: 'editImage', label: 'CHRONICLE.HeroSheet.Portrait.Choose', note: 'CHRONICLE.HeroSheet.Portrait.ChooseNote' });
  }
  rows.push({
    action: 'showPortraitArtwork',
    label: 'CHRONICLE.HeroSheet.Portrait.Full',
    note: state.isGM ? 'CHRONICLE.HeroSheet.Portrait.FullNoteGM' : 'CHRONICLE.HeroSheet.Portrait.FullNote',
  });
  if (state.isOwner && !state.limited && state.hasTokenArt) {
    rows.push({ action: 'showTokenArtwork', label: 'CHRONICLE.HeroSheet.Portrait.Token', note: 'CHRONICLE.HeroSheet.Portrait.TokenNote' });
  }
  if (state.isOwner && state.chronicleUrl && (state.isGM || state.mapped)) {
    rows.push({ action: 'csOpenChronicle', label: 'CHRONICLE.HeroSheet.Portrait.Change', note: 'CHRONICLE.HeroSheet.Portrait.ChangeNote' });
  }
  return rows;
}

/**
 * Where keyboard focus goes in a menu: up and down step past disabled rows
 * and wrap, Home and End jump to the first and last open row.
 * @param {number} index  the focused row, or -1
 * @param {string} key
 * @param {boolean[]} disabled  one per row
 * @returns {number}  the row to focus, or `index` when nothing moves
 */
export function menuFocus(index, key, disabled) {
  const open = disabled.map((d, i) => (d ? -1 : i)).filter((i) => i >= 0);
  if (!open.length) return index;
  if (key === 'Home') return open[0];
  if (key === 'End') return open[open.length - 1];
  const step = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!step) return index;
  // Focus outside the rows: down goes to the first, up to the last.
  if (index < 0 || index >= disabled.length) return step > 0 ? open[0] : open[open.length - 1];
  const n = disabled.length;
  for (let k = 1; k <= n; k++) {
    const i = (((index + step * k) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return index;
}

/**
 * The hero's page in Chronicle, or null when the world isn't connected or
 * the hero isn't linked.
 * @param {{apiUrl?: unknown, campaignId?: unknown, entityId?: unknown}} where
 * @returns {string|null}
 */
export function chroniclePageUrl({ apiUrl, campaignId, entityId }) {
  const base = String(apiUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base) || !campaignId || !entityId) return null;
  return `${base}/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`;
}

/** The parts a folded sheet draws: the card alone. */
export const FOLDED_PARTS = Object.freeze(['card']);

/**
 * The parts a render asks for, fitted to the sheet's state. Folded, every
 * render draws the card alone, whatever it asked for (Draw Steel refreshes
 * "stats" on a combat change). Unfolded, the card is dropped, and so are ids
 * the sheet doesn't have, as Foundry warns on them.
 * @param {unknown} requested  options.parts
 * @param {{folded: boolean, known: Iterable<string>}} sheet
 * @returns {string[]|undefined}  undefined when an unfolded render asked for every part
 */
export function fitRenderParts(requested, { folded, known }) {
  if (folded) return [...FOLDED_PARTS];
  if (!Array.isArray(requested)) return undefined;
  const have = new Set(known);
  return [...new Set(requested.filter((id) => id !== 'card' && have.has(id)))];
}

/** How many heroes' fold states a player's browser keeps. */
export const FOLD_KEEP = 40;

/**
 * A player's fold states after one change: the hero's entry merged and moved
 * to the front, the oldest beyond FOLD_KEEP dropped, so the setting can't grow
 * without end. An unfolded hero with no saved place is removed.
 * @param {Record<string, {folded?: boolean, left?: number, top?: number}>|null|undefined} map
 * @param {string} key  the actor's uuid
 * @param {{folded?: boolean, left?: number, top?: number}} patch
 * @returns {Record<string, {folded: boolean, left?: number, top?: number}>}
 */
export function withFold(map, key, patch) {
  const prev = (map && typeof map === 'object' && map[key]) || {};
  const entry = { folded: !!(patch.folded ?? prev.folded) };
  for (const k of ['left', 'top']) {
    const v = patch[k] ?? prev[k];
    if (typeof v === 'number' && Number.isFinite(v)) entry[k] = Math.round(v);
  }
  const rest = Object.entries(map && typeof map === 'object' ? map : {}).filter(([k]) => k !== key);
  const keep = entry.folded || 'left' in entry ? [[key, entry], ...rest] : rest;
  return Object.fromEntries(keep.slice(0, FOLD_KEEP));
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
