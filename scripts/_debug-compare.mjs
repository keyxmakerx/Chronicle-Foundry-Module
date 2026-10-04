/**
 * Side-by-side comparison of one character's money and items as Chronicle
 * holds them and as the Foundry actor shows them. Read-only: this only
 * describes differences, it never decides to change either side.
 *
 * Pure — see tools/test-debug-compare.mjs.
 */

export const ROW_STATUS = Object.freeze({
  MATCH: 'match',
  DIFFERENT: 'different',
  MISSING: 'missing',
  FOUNDRY_ONLY: 'foundry-only',
});

/** Two money amounts within half a cent are the same amount. */
const MONEY_EPSILON = 0.005;

/** @returns {number|null} the finite number in `v`, or null. */
function toNumber(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Whole numbers as-is, otherwise at most two decimals. */
export function formatAmount(n) {
  if (n === null || n === undefined) return '';
  return String(Math.round(n * 100) / 100);
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param {object} input
 * @param {{moneyLabel?: string, money?: *, items?: Array<{itemId: string, name: string, quantity: number}>}} input.chronicle
 *   `moneyLabel` empty means the character's system has no money field.
 * @param {{moneyPath?: string, money?: *, items?: Array<{id?: string, name: string, entityId?: string|null, quantity?: number}>}} input.foundry
 *   `items` are the Foundry items worth comparing (inventory-like ones).
 * @returns {{rows: Array<{kind: 'money'|'item', thing: string, chronicle: string, foundry: string, status: string}>, differences: number}}
 */
export function compareSideBySide({ chronicle = {}, foundry = {} } = {}) {
  const rows = [];

  if (chronicle.moneyLabel) {
    const c = toNumber(chronicle.money);
    const f = toNumber(foundry.money);
    let status = ROW_STATUS.MATCH;
    if (f === null) status = ROW_STATUS.MISSING;
    else if (c === null || Math.abs(c - f) > MONEY_EPSILON) status = ROW_STATUS.DIFFERENT;
    rows.push({
      kind: 'money', thing: chronicle.moneyLabel,
      chronicle: formatAmount(c), foundry: formatAmount(f), status,
    });
  }

  const fItems = (foundry.items || []).map((it) => ({ ...it, claimed: false }));
  for (const ci of chronicle.items || []) {
    const wantQty = toNumber(ci.quantity) ?? 1;
    // A Foundry item belongs to a Chronicle item by its linked entity id; an
    // unlinked one by name, so a hand-added copy still lines up.
    let matches = fItems.filter((f) => !f.claimed && f.entityId && String(f.entityId) === String(ci.itemId));
    if (!matches.length) {
      matches = fItems.filter((f) => !f.claimed && !f.entityId && norm(f.name) === norm(ci.name));
    }
    matches.forEach((m) => { m.claimed = true; });
    const have = matches.reduce((sum, m) => sum + (toNumber(m.quantity) ?? 1), 0);
    let status = ROW_STATUS.MATCH;
    if (!matches.length) status = ROW_STATUS.MISSING;
    else if (have !== wantQty) status = ROW_STATUS.DIFFERENT;
    rows.push({
      kind: 'item', thing: ci.name || String(ci.itemId),
      chronicle: String(wantQty), foundry: matches.length ? String(have) : '', status,
    });
  }

  // Foundry-only items, merged by name so three "Torch" stacks read as one row.
  const only = new Map();
  for (const f of fItems) {
    if (f.claimed) continue;
    const key = norm(f.name);
    const entry = only.get(key) || { name: f.name || '?', qty: 0 };
    entry.qty += toNumber(f.quantity) ?? 1;
    only.set(key, entry);
  }
  for (const e of only.values()) {
    rows.push({ kind: 'item', thing: e.name, chronicle: '', foundry: String(e.qty), status: ROW_STATUS.FOUNDRY_ONLY });
  }

  return { rows, differences: rows.filter((r) => r.status !== ROW_STATUS.MATCH).length };
}

const MONEY_GUESS = /^(gold|gp|money|wealth|coins?|currency|funds|cash)$/i;

/**
 * The system field that holds a character's money.
 * @param {Array<{key: string, label?: string, foundry_path?: string}>} fields - the system's character fields.
 * @param {string} [moneyKey] - the key Chronicle's stash view names, when it answered.
 * @param {boolean} [viewAnswered] - the stash view answered; an empty `moneyKey` then
 *   means the system has no money field, so nothing is guessed from names.
 * @returns {{key: string, label: string, foundryPath: string}|null}
 */
export function findMoneyField(fields, moneyKey = '', viewAnswered = false) {
  if (viewAnswered && !moneyKey) return null;
  const list = Array.isArray(fields) ? fields : [];
  const hit = moneyKey
    ? list.find((f) => f?.key === moneyKey)
    : list.find((f) => MONEY_GUESS.test(String(f?.key ?? '')) || MONEY_GUESS.test(String(f?.label ?? '')));
  if (!hit) return moneyKey ? { key: moneyKey, label: moneyKey, foundryPath: '' } : null;
  return { key: hit.key, label: hit.label || hit.key, foundryPath: hit.foundry_path || '' };
}
