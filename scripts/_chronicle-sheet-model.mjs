/**
 * Pure rules for the Chronicle sheet (`chronicle-sheet.mjs`): which facts a
 * journal may carry, what the sheet's header and contents show, and which
 * journals the sheet is offered to. `tools/test-chronicle-sheet.mjs`.
 */

/** Most facts a journal carries; a page with more shows these and links to Chronicle. */
export const MAX_FACTS = 12;

/** The sheet's id as Foundry stores it in `flags.core.sheetClass`. */
export const CHRONICLE_SHEET_CLASS = 'chronicle-sync.ChronicleJournalSheet';

/** Field types with no single value to show. */
const NO_VALUE_TYPES = new Set(['rule', 'textarea']);

/**
 * The page's field values every reader of the journal may see. A journal's
 * flags reach every client that has it, so a field whose value Chronicle
 * keeps from some readers (GM-only, owner-only) is never included, nor is a
 * field the page's category doesn't define: with no definition there is no
 * way to know who may see it. Values are trimmed to short text.
 * @param {Record<string, unknown>|null|undefined} fieldsData - entity.fields_data
 * @param {Array<{key: string, label?: string, type?: string, gm_only?: boolean, owner_only?: boolean}>|null|undefined} defs - the category's fields
 * @returns {Array<{label: string, value: string}>}
 */
export function playerSafeFacts(fieldsData, defs) {
  if (!fieldsData || typeof fieldsData !== 'object' || !Array.isArray(defs)) return [];
  const out = [];
  for (const def of defs) {
    if (!def?.key || def.gm_only || def.owner_only || NO_VALUE_TYPES.has(def.type)) continue;
    const value = factValue(fieldsData[def.key]);
    if (!value) continue;
    out.push({ label: String(def.label || def.key).slice(0, 60), value });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

function factValue(v) {
  if (v == null || v === false) return '';
  if (v === true) return 'Yes';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
    return v.map(String).map((s) => s.trim()).filter(Boolean).join(', ').slice(0, 160);
  }
  return '';
}

/** Page names sync gives a section with no heading of its own. */
const UNTITLED = new Set(['Content', 'Overview']);

/**
 * What the sheet shows around the pages.
 * @param {object} j
 * @param {string} [j.category] - flag entityType
 * @param {string|null} [j.folder] - the journal's own folder name, when it is not the category's
 * @param {string[]} [j.tags]
 * @param {Array<{label: string, value: string}>} [j.facts]
 * @param {Array<{id: string, name: string, type: string, sort: number, isPlayerNotes?: boolean}>} j.pages - the pages this user can see
 * @param {{overview: string, playerNotes: string}} labels
 * @returns {{eyebrow: string[], tags: string[], facts: Array<{label: string, value: string}>, contents: Array<{pageId: string, label: string}>}}
 */
export function sheetModel({ category, folder, tags, facts, pages }, labels) {
  const eyebrow = [category, folder].map((s) => String(s ?? '').trim()).filter(Boolean);
  if (eyebrow.length === 2 && eyebrow[0] === eyebrow[1]) eyebrow.pop();
  const contents = [...(pages || [])]
    .filter((p) => p?.type === 'text')
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((p) => ({
      pageId: p.id,
      label: p.isPlayerNotes ? labels.playerNotes : UNTITLED.has(p.name) ? labels.overview : String(p.name || labels.overview),
    }));
  return {
    eyebrow,
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t ?? '').trim()).filter(Boolean),
    facts: Array.isArray(facts) ? facts.filter((f) => f?.label && f?.value) : [],
    // One section needs no contents list.
    contents: contents.length > 1 ? contents : [],
  };
}

/**
 * Which linked journals get or lose the sheet. The sheet is offered once per
 * journal, and the offer is recorded, so a GM who picks another sheet for a
 * journal keeps it. Turning the setting off takes the sheet back only from
 * journals that still use it because it was offered.
 * @param {Array<{id: string, linked: boolean, sheetClass: string, offered: boolean}>} journals
 * @param {boolean} enabled - the "Show synced journals as Chronicle pages" setting
 * @returns {Array<{id: string, sheetClass: string, offered: boolean}>} updates to write
 */
export function sheetClassPlan(journals, enabled) {
  const out = [];
  for (const j of journals || []) {
    if (!j?.linked) continue;
    if (enabled && !j.offered) {
      // A sheet the GM already chose for this journal stays.
      if (!j.sheetClass) out.push({ id: j.id, sheetClass: CHRONICLE_SHEET_CLASS, offered: true });
      else out.push({ id: j.id, sheetClass: j.sheetClass, offered: true });
    } else if (!enabled && j.offered && j.sheetClass === CHRONICLE_SHEET_CLASS) {
      out.push({ id: j.id, sheetClass: '', offered: false });
    }
  }
  return out;
}
