/**
 * Pure logic for the Encounters roster (scripts/encounters.mjs).
 *
 * A planned fight is a list of creature rows with a count; the roster shows
 * one row per creature instance. Placed tokens carry a module flag
 * {encounterId, rowId, n}, and the scene is the only record of what is
 * placed or hidden, so state is always derived from the tokens handed in.
 * Nothing here reveals anything: only the helpers named for Show/Hide and
 * Show all return token ids to unhide, and the caller acts on them only when
 * the GM presses the button. tools/test-encounter-roster.mjs pins it.
 */

/** Token flag (under the module scope) tying a token to its roster row. */
export const ENCOUNTER_TOKEN_FLAG = 'encounterToken';

const GROUPS = 'ABCDEFGH';
const STARTS = ['seen', 'hidden', 'later'];
const MAX_COUNT = 50;
const str = (v) => (typeof v === 'string' ? v : '');

/** One planned creature as Chronicle sends it, with safe values filled in. */
function creature(raw, index) {
  const group = str(raw?.group).trim().toUpperCase();
  // An unknown start must not place or reveal anything: treat it as later.
  const start = STARTS.includes(raw?.start) ? raw.start : 'later';
  const count = Number.isFinite(raw?.count) ? Math.max(1, Math.min(MAX_COUNT, Math.floor(raw.count))) : 1;
  return {
    id: str(raw?.id) || `c${index}`,
    entityId: str(raw?.entityId),
    name: str(raw?.name).trim() || 'Creature',
    count,
    group: group.length === 1 && GROUPS.includes(group) ? group : '',
    start,
  };
}

/** One encounter from GET /encounters/:id, or null when it has no id. */
export function parseEncounter(raw) {
  const id = str(raw?.id);
  if (!id) return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    id,
    name: str(raw?.name) || str(raw?.page?.name),
    pageName: str(raw?.page?.name),
    ready: raw?.ready === true,
    heroes: list(raw?.heroes).map((h) => ({ id: str(h?.id), name: str(h?.name) })),
    creatures: list(raw?.creatures).map(creature),
    version: Number.isFinite(raw?.version) ? raw.version : 0,
  };
}

/** The identity of one roster row: its creature row and which copy it is. */
export const rowKey = (rowId, n) => `${rowId}#${n}`;

/**
 * One roster row per creature instance: a row with count 3 becomes three,
 * named "Hobgoblin Soldier 1", "... 2", "... 3".
 */
export function expandRows(creatures) {
  const rows = [];
  for (const c of creatures) {
    for (let n = 1; n <= c.count; n++) {
      rows.push({
        key: rowKey(c.id, n),
        rowId: c.id,
        n,
        entityId: c.entityId,
        baseName: c.name,
        name: c.count > 1 ? `${c.name} ${n}` : c.name,
        group: c.group,
        start: c.start,
      });
    }
  }
  return rows;
}

/** A token flag value if it is a well-formed reference, else null. */
export function tokenRef(value) {
  if (!value || typeof value !== 'object') return null;
  const { encounterId, rowId, n } = value;
  if (typeof encounterId !== 'string' || !encounterId) return null;
  if (typeof rowId !== 'string' || !rowId) return null;
  if (!Number.isInteger(n) || n < 1) return null;
  return { encounterId, rowId, n };
}

/** The tokens this encounter placed, from {id, hidden, ref} scene tokens. */
export function encounterTokens(encounterId, tokens) {
  return tokens.filter((t) => t?.ref && t.ref.encounterId === encounterId);
}

/**
 * Each row with its live state: 'out' (no token), 'seen' or 'hidden'. When a
 * row somehow has two tokens, a visible one is not allowed to mask a hidden
 * one: the row reads hidden if any of its tokens is.
 */
export function rosterState(encounterId, rows, tokens) {
  const byKey = new Map();
  for (const t of encounterTokens(encounterId, tokens)) {
    const k = rowKey(t.ref.rowId, t.ref.n);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  return rows.map((row) => {
    const found = byKey.get(row.key) ?? [];
    const hid = found.find((t) => t.hidden);
    const token = hid ?? found[0] ?? null;
    return {
      ...row,
      state: !token ? 'out' : token.hidden ? 'hidden' : 'seen',
      tokenId: token?.id ?? null,
    };
  });
}

/** Rows "Set up the start" places: planned seen or hidden, and not on the scene yet. */
export function startRows(stateRows) {
  return stateRows.filter((r) => r.state === 'out' && (r.start === 'seen' || r.start === 'hidden'));
}

/**
 * Whether a row's token is placed hidden. Only a creature planned to start
 * seen is placed visible; one placed later arrives hidden too, so the GM
 * shows it when it appears and nothing is ever revealed by placing it.
 */
export function placeHidden(row) {
  return row.start !== 'seen';
}

/** Ids of this encounter's hidden tokens: what "Show all hidden" would reveal, and nothing else. */
export function hiddenTokenIds(encounterId, tokens) {
  return encounterTokens(encounterId, tokens).filter((t) => t.hidden).map((t) => t.id);
}

/** Ids of this encounter's tokens: what "Undo placing" removes, and nothing else. */
export function placedTokenIds(encounterId, tokens) {
  return encounterTokens(encounterId, tokens).map((t) => t.id);
}

// ---- Finding the actor for a row ---------------------------------------

const norm = (s) => str(s).trim().toLowerCase();

/**
 * The actor to place for a creature row. In order: the actor creature sync
 * linked to the creature's Chronicle page, then an actor of the same name in
 * the creatures folder, then any world actor of that name.
 * @param {{entityId: string, baseName: string}} row
 * @param {Array<{id: string, name: string, linkedEntityId?: string, inCreatureFolder?: boolean}>} actors
 * @returns {{actor: object, via: 'linked'|'folder'|'name'}|null}
 */
export function resolveActor(row, actors) {
  if (row.entityId) {
    const linked = actors.find((a) => a.linkedEntityId === row.entityId);
    if (linked) return { actor: linked, via: 'linked' };
  }
  const name = norm(row.baseName);
  if (!name) return null;
  const same = actors.filter((a) => norm(a.name) === name);
  const inFolder = same.find((a) => a.inCreatureFolder);
  if (inFolder) return { actor: inFolder, via: 'folder' };
  if (same.length) return { actor: same[0], via: 'name' };
  return null;
}

// ---- Free squares ------------------------------------------------------

const cell = (i, j) => `${i},${j}`;

/** Grid cell of a scene point. `grid` is {size, originX, originY}. */
export function pointToCell(x, y, grid) {
  return { i: Math.floor((x - grid.originX) / grid.size), j: Math.floor((y - grid.originY) / grid.size) };
}

/** Top-left scene point of a grid cell. */
export function cellToPoint(i, j, grid) {
  return { x: grid.originX + i * grid.size, y: grid.originY + j * grid.size };
}

/** Every cell the given scene tokens ({x, y, width, height} in squares) cover. */
export function occupiedCells(tokens, grid) {
  const out = new Set();
  for (const t of tokens) {
    const i0 = Math.round((t.x - grid.originX) / grid.size);
    const j0 = Math.round((t.y - grid.originY) / grid.size);
    const w = Math.max(1, Math.ceil(t.width || 1));
    const h = Math.max(1, Math.ceil(t.height || 1));
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out.add(cell(i0 + i, j0 + j));
  }
  return out;
}

/** Offsets within `radius`, nearest first (ring by ring), in a fixed order. */
function offsets(radius) {
  const list = [];
  for (let di = -radius; di <= radius; di++) {
    for (let dj = -radius; dj <= radius; dj++) list.push([di, dj]);
  }
  list.sort((a, b) => {
    const ra = Math.max(Math.abs(a[0]), Math.abs(a[1]));
    const rb = Math.max(Math.abs(b[0]), Math.abs(b[1]));
    return ra - rb || (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2) || a[1] - b[1] || a[0] - b[0];
  });
  return list;
}

/**
 * Put each item on free squares as near the clicked cell as they fit,
 * larger ones first so they are not left without room.
 * @param {Array<{key: string, w?: number, h?: number}>} items
 * @param {{i: number, j: number}} center
 * @param {{occupied?: Set<string>, bounds?: {minI: number, minJ: number, maxI: number, maxJ: number}|null, radius?: number}} [opts]
 * @returns {{placements: Array<{key: string, i: number, j: number}>, unplaced: string[]}}
 */
export function layoutItems(items, center, { occupied = new Set(), bounds = null, radius = 12 } = {}) {
  const taken = new Set(occupied);
  const near = offsets(radius);
  const order = items
    .map((it, index) => ({ ...it, index, w: Math.max(1, Math.ceil(it.w || 1)), h: Math.max(1, Math.ceil(it.h || 1)) }))
    .sort((a, b) => b.w * b.h - a.w * a.h || a.index - b.index);
  const found = new Map();
  const unplaced = [];
  for (const it of order) {
    let spot = null;
    for (const [di, dj] of near) {
      const i = center.i + di;
      const j = center.j + dj;
      if (bounds && (i < bounds.minI || j < bounds.minJ || i + it.w - 1 > bounds.maxI || j + it.h - 1 > bounds.maxJ)) continue;
      let free = true;
      for (let a = 0; a < it.w && free; a++) for (let b = 0; b < it.h; b++) if (taken.has(cell(i + a, j + b))) { free = false; break; }
      if (free) { spot = { i, j }; break; }
    }
    if (!spot) { unplaced.push(it.key); continue; }
    for (let a = 0; a < it.w; a++) for (let b = 0; b < it.h; b++) taken.add(cell(spot.i + a, spot.j + b));
    found.set(it.key, spot);
  }
  // Report in the roster's order whatever order they were fitted in.
  const placements = items.filter((it) => found.has(it.key)).map((it) => ({ key: it.key, ...found.get(it.key) }));
  return { placements, unplaced: items.filter((it) => unplaced.includes(it.key)).map((it) => it.key) };
}

// ---- Combat tracker ------------------------------------------------------

/**
 * Which combat on the scene to add to. An unstarted one is used as it is; a
 * started one is only offered ('ask'); with none, a new one is made.
 * @param {Array<{id: string, started: boolean}>} combats - the scene's combats
 * @returns {{kind: 'add'|'ask'|'new', id?: string}}
 */
export function pickCombat(combats) {
  const open = combats.find((c) => !c.started);
  if (open) return { kind: 'add', id: open.id };
  if (combats.length) return { kind: 'ask', id: combats[0].id };
  return { kind: 'new' };
}

/**
 * Combatants to create for the placed rows, skipping tokens already in the
 * combat. A combatant starts hidden exactly when its token is.
 * @param {Array<object>} stateRows - rosterState output
 * @param {Set<string>} inCombat - token ids that already have a combatant
 */
export function trackerAdditions(stateRows, inCombat) {
  const add = [];
  for (const r of stateRows) {
    if (r.state === 'out' || !r.tokenId || inCombat.has(r.tokenId)) continue;
    add.push({ key: r.key, tokenId: r.tokenId, name: r.name, group: r.group, hidden: r.state === 'hidden' });
  }
  return add;
}

/** Initiative group letters, in order, for the rows being added. */
export function groupLetters(additions) {
  return [...new Set(additions.map((a) => a.group).filter(Boolean))].sort();
}

/**
 * What the roster says about a row and the tracker. 'pending' is a row not
 * on the scene while this fight is in the tracker: it joins when placed.
 */
export function trackerBadge(row, { trackerOn, inCombat }) {
  if (!trackerOn) return '';
  if (row.state === 'out') return 'pending';
  return row.tokenId && inCombat.has(row.tokenId) ? 'in' : 'notIn';
}

/**
 * Updates that bring the combatants of one token in step with its hidden
 * flag; none when they already agree.
 * @param {boolean} hidden - the token's hidden state
 * @param {Array<{id: string, hidden: boolean}>} combatants - that token's
 * @returns {Array<{_id: string, hidden: boolean}>}
 */
export function combatantHiddenUpdates(hidden, combatants) {
  return combatants.filter((c) => !!c.hidden !== !!hidden).map((c) => ({ _id: c.id, hidden: !!hidden }));
}
