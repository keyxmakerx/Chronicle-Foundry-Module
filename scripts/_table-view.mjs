/**
 * "At this table", the Journal tab's first view (#258): the pages tied to
 * the scene on screen, then recent and pinned pages, then every category as
 * a chip; typing searches every page. Pure: what the tab lists, worked out
 * from plain rows. `tools/test-table-view.mjs`.
 */

/** Most pages one group lists before "Show all N". */
export const GROUP_LIMIT = 8;
/** Most recent pages remembered per user. */
export const RECENT_LIMIT = 12;

/**
 * @typedef {object} JournalRow
 * @property {string} id
 * @property {string} name
 * @property {string} [category] - Chronicle category name; "" for a journal only in Foundry
 * @property {string} [folder] - the journal's folder name below its category
 * @property {string} [entityId]
 * @property {boolean} [setAside] - in the set-aside folder
 * @property {string[]} [tags]
 */

/**
 * @param {object} input
 * @param {JournalRow[]} input.journals - what this user can see
 * @param {{journalId?: string|null, noteJournalIds?: string[], tokens?: Array<{entityId: string, count: number}>}|null} input.scene
 * @param {string[]} input.recent - journal ids, newest first
 * @param {string[]} input.pinned - journal ids
 * @param {string} [input.query]
 * @param {string} [input.chip] - a category name, ONLY_FOUNDRY or SET_ASIDE
 * @returns {{mode: 'search'|'chip'|'table', groups: Array<{key: string, rows: object[], total: number}>, chips: Array<{key: string, label: string, count: number}>}}
 */
export function tableView({ journals, scene, recent, pinned, query, chip }) {
  const byId = new Map(journals.map((j) => [j.id, j]));
  const byEntity = new Map(journals.filter((j) => j.entityId && !j.setAside).map((j) => [j.entityId, j]));
  const chips = categoryChips(journals);
  const row = (j, why) => ({ id: j.id, name: j.name, where: whereOf(j), ...(why && { why }) });

  const q = String(query ?? '').trim().toLowerCase();
  if (q) {
    const hits = journals
      .filter((j) => [j.name, j.category, j.folder, ...(j.tags || [])].some((s) => String(s ?? '').toLowerCase().includes(q)))
      .sort((a, b) => rank(a, q) - rank(b, q) || a.name.localeCompare(b.name));
    return { mode: 'search', groups: [{ key: 'matches', rows: hits.map((j) => row(j)), total: hits.length }], chips };
  }

  if (chip) {
    const rows = journals.filter((j) => chipOf(j) === chip)
      .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name));
    return { mode: 'chip', groups: [{ key: 'chip', rows: rows.map((j) => row(j)), total: rows.length }], chips };
  }

  const groups = [];
  const seen = new Set();
  const take = (key, list) => {
    const rows = list.filter((r) => r && !seen.has(r.id));
    rows.forEach((r) => seen.add(r.id));
    if (rows.length) groups.push({ key, rows, total: rows.length });
  };
  if (scene) {
    const list = [];
    const sceneJournal = scene.journalId && byId.get(scene.journalId);
    if (sceneJournal) list.push(row(sceneJournal, { kind: 'scene' }));
    for (const t of scene.tokens || []) {
      const j = byEntity.get(t.entityId);
      if (j) list.push(row(j, { kind: 'tokens', count: t.count }));
    }
    for (const id of scene.noteJournalIds || []) {
      const j = byId.get(id);
      if (j) list.push(row(j, { kind: 'note' }));
    }
    take('scene', list);
  }
  take('recent', (recent || []).map((id) => byId.get(id)).filter(Boolean).slice(0, GROUP_LIMIT).map((j) => row(j)));
  take('pinned', (pinned || []).map((id) => byId.get(id)).filter(Boolean).map((j) => row(j)));
  return { mode: 'table', groups, chips };
}

/** Chip key for journals only in Foundry, and for pages set aside. */
export const ONLY_FOUNDRY = ':foundry';
export const SET_ASIDE = ':set-aside';

function chipOf(j) {
  if (j.setAside) return SET_ASIDE;
  return j.category ? j.category : ONLY_FOUNDRY;
}

/**
 * One chip per category name, so two Chronicle categories that share a
 * name (two "Faction" types) read as one; then Foundry-only and set aside.
 */
function categoryChips(journals) {
  const counts = new Map();
  for (const j of journals) counts.set(chipOf(j), (counts.get(chipOf(j)) || 0) + 1);
  const named = [...counts.keys()].filter((k) => !k.startsWith(':')).sort((a, b) => a.localeCompare(b));
  return [...named, ONLY_FOUNDRY, SET_ASIDE]
    .filter((k) => counts.get(k))
    .map((k) => ({ key: k, label: k, count: counts.get(k) }));
}

function whereOf(j) {
  return [j.category, j.folder && j.folder !== j.category ? j.folder : ''].filter(Boolean).join(' / ');
}

/** Names that start with the query come first, then names containing it, then the rest. */
function rank(j, q) {
  const n = j.name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  return 2;
}

/**
 * The recent list after opening a journal: newest first, no repeats, capped.
 * @param {string[]} list
 * @param {string} id
 * @returns {string[]}
 */
export function pushRecent(list, id) {
  if (!id) return list || [];
  return [id, ...(list || []).filter((x) => x !== id)].slice(0, RECENT_LIMIT);
}

/** Foundry's CONST.TOKEN_DISPOSITIONS.SECRET, used for disguised and mimic tokens. */
const SECRET_DISPOSITION = -2;

/**
 * Tokens on a scene, as Chronicle page ids with how many tokens each has.
 * A token counts for its actor's own page and for the page linked to it. A
 * hidden or Secret-disposition token counts only for the GM, so a player's
 * list never gives away an ambush or a disguise.
 * @param {Array<{entityId?: string|null, linkedEntityId?: string|null, hidden?: boolean, disposition?: number}>} tokens
 * @param {boolean} isGM
 * @returns {Array<{entityId: string, count: number}>} most tokens first
 */
export function tokenPages(tokens, isGM) {
  const counts = new Map();
  for (const t of tokens || []) {
    if (!isGM && (t?.hidden || t?.disposition === SECRET_DISPOSITION)) continue;
    for (const id of new Set([t?.entityId, t?.linkedEntityId].filter(Boolean))) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].map(([entityId, count]) => ({ entityId, count })).sort((a, b) => b.count - a.count);
}
