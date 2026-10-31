/**
 * The end-of-combat spoils prompt, as pure decisions.
 *
 * When the GM ends a Foundry combat, the defeated creatures that belong to a
 * Chronicle page can leave what their drop lists say in the party's spoils
 * tray. Nothing drops until the GM confirms. A combat whose creatures belong
 * to a planned encounter with stages still to come is held, and asked about
 * once the last stage is done or the GM says the whole fight is over.
 * Chronicle drops again on every call, so one confirmed prompt is one call.
 * Unit-tested by tools/test-spoils-prompt.mjs.
 */

/** Where an actor's hit points or Stamina may sit, after creature sync's own path. */
export const HP_PATHS = Object.freeze(['system.attributes.hp.value', 'system.stamina.value', 'system.hp.value']);

// Chronicle caps a fight's copies and clips names; these keep a body small.
const MAX_ROWS = 100;
const MAX_NAME = 200;
// Creatures held for one encounter between combats.
const MAX_HELD = 200;

const str = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/** The first finite number among an actor's hit point values, or null. */
export function firstHp(values) {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * Whether a combatant is defeated: marked defeated in the tracker, or its
 * Stamina or hit points at 0 or below. `hp` is null when the actor has none.
 */
export function isDefeated({ marked, hp }) {
  return marked === true || (typeof hp === 'number' && Number.isFinite(hp) && hp <= 0);
}

/**
 * One row per Chronicle page (or per name, for creatures with no page), with
 * how many were in the fight and how many went down. A creature is counted
 * once however many combats it was in (held ones come back as defeated);
 * player-owned actors are heroes, never spoils; rows nobody went down in are
 * left out.
 * @param {Array<{id: string, name: string, pageId?: string, defeated: boolean, playerOwned?: boolean}>} creatures
 * @returns {Array<{key: string, pageId: string, name: string, down: number, copies: number}>}
 */
export function fightRows(creatures) {
  const seen = new Map();
  for (const c of Array.isArray(creatures) ? creatures : []) {
    const id = str(c?.id);
    if (!id || c.playerOwned) continue;
    const have = seen.get(id);
    if (have) {
      have.defeated ||= c.defeated === true;
      have.pageId ||= str(c.pageId);
      continue;
    }
    seen.set(id, { pageId: str(c.pageId), name: str(c.name).trim(), defeated: c.defeated === true });
  }
  const rows = new Map();
  for (const c of seen.values()) {
    const key = c.pageId ? `page:${c.pageId}` : `name:${c.name.toLowerCase()}`;
    const row = rows.get(key) ?? { key, pageId: c.pageId, name: c.name, down: 0, copies: 0 };
    row.copies += 1;
    if (c.defeated) row.down += 1;
    rows.set(key, row);
  }
  return [...rows.values()].filter((r) => r.down > 0);
}

/**
 * The defeated creatures to keep for an encounter while its stages are still
 * to come, from any list `fightRows` takes.
 * @returns {Array<{id: string, name: string, pageId: string, defeated: true}>}
 */
export function heldCreatures(creatures) {
  const out = new Map();
  for (const c of Array.isArray(creatures) ? creatures : []) {
    const id = str(c?.id);
    if (!id || c.playerOwned || c.defeated !== true || out.has(id)) continue;
    out.set(id, { id, name: str(c.name).slice(0, MAX_NAME), pageId: str(c.pageId), defeated: true });
  }
  return [...out.values()].slice(0, MAX_HELD);
}

/** How many of an encounter's stages haven't started in this fight. */
export function stagesToCome(stages, memory) {
  const started = new Set(Array.isArray(memory?.started) ? memory.started : []);
  return (Array.isArray(stages) ? stages : []).filter((s) => !started.has(s?.id)).length;
}

/**
 * What each page's drop list leaves, from Chronicle's tray read, in the
 * mockup's words: "2 Troll tooth · Drake hide (harvest)". Item names the GM
 * may see, since the prompt is the GM's alone.
 * @param {{drops?: Array, items?: Array}} page - `GET /crafting/spoils`
 * @returns {Map<string, {page: string, lines: string[], also: string}>}
 */
export function dropSummaries(page) {
  const names = new Map((Array.isArray(page?.items) ? page.items : []).map((i) => [str(i?.id), str(i?.name)]));
  const out = new Map();
  for (const d of Array.isArray(page?.drops) ? page.drops : []) {
    const id = str(d?.pageId);
    if (!id) continue;
    const lines = (Array.isArray(d.lines) ? d.lines : []).map((l) => {
      const item = names.get(str(l?.itemId)) || '';
      const qty = count(l?.qty);
      return { item, harvest: l?.mode === 'harvest', qty: qty > 1 ? qty : 0, study: l?.study === true };
    });
    out.set(id, { page: str(d.page), lines, also: str(d.alsoName) });
  }
  return out;
}

/**
 * One drop list as a line of text. `words` holds the localized pieces:
 * `harvest`, `study`, `anItem`, and `also` with a `{name}` slot.
 */
export function dropText(drop, words) {
  const parts = (drop?.lines ?? []).map((l) => {
    let s = l.item || words.anItem;
    if (l.qty) s = `${l.qty} ${s}`;
    if (l.harvest) s += ` ${words.harvest}`;
    if (l.study) s += ` ${words.study}`;
    return s;
  });
  const also = drop?.also ? words.also.replace('{name}', drop.also) : '';
  return [parts.join(' · '), also].filter(Boolean).join(', ');
}

/**
 * The prompt's rows: one per row the fight left, with what its page drops
 * when it has a drop list. `can` is false for a creature with no page or a
 * page with no drop list; those are shown but can't be ticked.
 * @returns {Array<{key: string, name: string, down: number, can: boolean, why: ''|'NoPage'|'NoDrops', drop: object|null}>}
 */
export function promptRows(rows, summaries) {
  return rows.map((r) => {
    const drop = r.pageId ? summaries.get(r.pageId) ?? null : null;
    const why = !r.pageId ? 'NoPage' : drop ? '' : 'NoDrops';
    return { key: r.key, name: drop?.page || r.name, down: r.down, can: !why, why, drop };
  });
}

/**
 * Chronicle's fight body for the ticked rows, or null when none can drop.
 * `name` is the fight's name as the tray shows it.
 */
export function fightBody(name, rows, ticked) {
  const creatures = rows
    .filter((r) => r.pageId && ticked.has(r.key))
    .slice(0, MAX_ROWS)
    .map((r) => ({ pageId: r.pageId, name: r.name.slice(0, MAX_NAME), down: r.down, copies: Math.max(r.copies, r.down) }));
  return creatures.length ? { name: str(name).slice(0, MAX_NAME), creatures } : null;
}

/**
 * Check Chronicle's answer to a fight: the lines it wrote for the Director
 * and how many spoils went in.
 * @returns {{lines: string[], spoils: number}}
 */
export function fightResult(res) {
  const lines = (Array.isArray(res?.lines) ? res.lines : []).filter((l) => typeof l === 'string' && l).slice(0, MAX_ROWS + 1);
  return { lines, spoils: count(res?.spoils) };
}
