/**
 * "Finish your hero": a hero built in Chronicle names its class there, but
 * Foundry builds a class through the system's own level-up steps, so sync
 * never puts the class item on the sheet itself. The GM's sync records the
 * pick on the actor (flag `classPick`) while the sheet has no class item;
 * the player who owns the actor gets one card offering to run those steps
 * with Chronicle's class chosen, and the sheet carries a line saying what
 * Chronicle picked. Pure; see tools/test-finish-hero.mjs.
 */

/** Actor flag: Chronicle's class pick, set while the sheet has no class item. */
export const CLASS_PICK_FLAG = 'classPick';

const isClassDef = (d) => d && d.key !== 'level'
  && Array.isArray(d.foundry_item_type) && d.foundry_item_type.includes('class')
  && d.foundry_item_single && !d.foundry_item_fields;

/**
 * The class Chronicle picked, with its level (1 when the page has none).
 * The class field is the one mapped to the system's class item (Draw
 * Steel), else the page's `class` field (D&D, where class is not mapped).
 * @param {Array<object>} fieldDefs - the adapter's field defs.
 * @param {object|null} fieldsData
 * @returns {{name: string, level: number}|null}
 */
export function classPick(fieldDefs, fieldsData) {
  const data = fieldsData && typeof fieldsData === 'object' ? fieldsData : {};
  const key = (fieldDefs || []).find(isClassDef)?.key ?? 'class';
  const raw = data[key];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Math.trunc(Number(data.level));
  return { name: raw.trim(), level: Number.isFinite(n) && n >= 1 ? n : 1 };
}

/**
 * The flag value the actor should carry: the pick while it has no class
 * item, else null (nothing to finish).
 * @param {Array<{type?: string}>} items - the actor's embedded items.
 * @param {{name: string, level: number}|null} pick
 * @returns {{name: string, level: number}|null}
 */
export function pickToFinish(items, pick) {
  if (!pick) return null;
  const hasClass = (items || []).some((it) => it?.type === 'class');
  return hasClass ? null : pick;
}

/** Whether two flag values differ (null and a missing flag are the same). */
export function pickChanged(current, next) {
  const a = current && typeof current === 'object' ? current : null;
  const b = next && typeof next === 'object' ? next : null;
  if (!a || !b) return a !== b;
  return a.name !== b.name || a.level !== b.level;
}

/**
 * Whether this client should offer the card for this actor: a player (not
 * the GM) who owns it, it still needs finishing, and the card was not
 * already shown this session.
 * @param {object} p
 * @param {boolean} p.isGM
 * @param {boolean} p.isOwner
 * @param {object|null} p.pick - the actor's flag.
 * @param {boolean} p.shown - already offered this session.
 * @returns {boolean}
 */
export function offersCard({ isGM, isOwner, pick, shown }) {
  return !isGM && !!isOwner && !!pick?.name && !shown;
}

/** Actor flag: subclass names Chronicle holds that the sheet has no item for. */
export const SUBCLASS_PICK_FLAG = 'subclassPick';

const isSubclassDef = (d) => d && Array.isArray(d.foundry_item_type)
  && d.foundry_item_type.includes('subclass') && d.foundry_item_single && !d.foundry_item_fields;

/**
 * The subclass names Chronicle picked (a conduit's two domains arrive as one
 * field joined with ", "). Empty when no field maps the subclass item.
 * @param {Array<object>} fieldDefs
 * @param {object|null} fieldsData
 * @returns {string[]}
 */
export function subclassPicks(fieldDefs, fieldsData) {
  const def = (fieldDefs || []).find(isSubclassDef);
  const raw = def && fieldsData && typeof fieldsData === 'object' ? fieldsData[def.key] : null;
  if (typeof raw !== 'string') return [];
  return raw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The flag value: the picked names the sheet holds no subclass item of, once
 * it has its class (a subclass is added on top of one), else null.
 * @param {Array<{type?: string, name?: string}>} items
 * @param {string[]} names
 * @returns {string[]|null}
 */
export function subclassesToFinish(items, names) {
  const list = items || [];
  if (!names?.length || !list.some((it) => it?.type === 'class')) return null;
  const held = new Set(list.filter((it) => it?.type === 'subclass').map((it) => String(it.name ?? '').trim().toLowerCase()));
  const missing = names.filter((n) => !held.has(n.toLowerCase()));
  return missing.length ? missing : null;
}

/** Whether two subclass flag values differ (null and a missing flag are the same). */
export function subclassPickChanged(current, next) {
  const a = Array.isArray(current) && current.length ? current : null;
  const b = Array.isArray(next) && next.length ? next : null;
  if (!a || !b) return a !== b;
  return a.length !== b.length || a.some((n, i) => n !== b[i]);
}
