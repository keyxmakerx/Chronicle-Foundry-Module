/**
 * Fills the item sync makes for a campaign's own pick-list entry (a homebrew
 * ancestry, kit...) from that entry, and plans refreshing it when the entry
 * changes in Chronicle. PURE: no Foundry globals.
 *
 * Entries come from `GET /system-entries`, which only ever returns the player
 * view, so the text is safe for an item players can open. A description that
 * still holds GM-only content is refused anyway and the item stays name-only.
 */
import { FLAG_SCOPE } from './constants.mjs';
import { hasClearSecrets } from './_gm-secrets.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';
import { entryTextHTML } from './_entry-text.mjs';

/**
 * How the description text is turned into HTML. Raised when that changes, so
 * items filled the old way are rewritten even though their entry hasn't.
 */
export const ENTRY_TEXT_FORMAT = 2;

const norm = (s) => String(s ?? '').trim().toLowerCase();

const escapeHTML = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** "signature_trait" -> "Signature trait". */
function label(key) {
  const words = String(key).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A list property's items, shaped like a package entry's traits. */
function listHTML(key, items) {
  const rows = items
    .filter((it) => it && typeof it === 'object' && it.name)
    .map((it) => {
      const cost = Number.isInteger(it.cost) ? ` (${it.cost} ${it.cost === 1 ? 'point' : 'points'})` : '';
      const desc = it.description ? `: ${escapeHTML(it.description)}` : '';
      return `<li><strong>${escapeHTML(it.name)}</strong>${cost}${desc}</li>`;
    });
  return rows.length ? `<h3>${escapeHTML(label(key))}</h3><ul>${rows.join('')}</ul>` : '';
}

/**
 * The item description for an entry: its own text (or summary), then its
 * details. The description is Markdown or HTML (`_entry-text.mjs`), cleaned
 * again here as at every other Chronicle ingress; the scalars and list items
 * are plain text and escaped.
 * @param {object} entry - one `GET /system-entries` row
 * @param {{mentionId?: (name: string) => string|null}} [opts] - see `mentionLookup`
 * @returns {string} HTML
 */
export function entryDescriptionHTML(entry, opts = {}) {
  const parts = [];
  const desc = typeof entry?.description === 'string' ? entryTextHTML(entry.description, opts) : '';
  if (desc) parts.push(_sanitizeIncomingHTML(desc));
  else if (entry?.summary) parts.push(`<p>${escapeHTML(entry.summary)}</p>`);

  const props = entry?.properties && typeof entry.properties === 'object' ? entry.properties : {};
  const scalars = [];
  const lists = [];
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) lists.push(listHTML(key, value));
    else if (['string', 'number', 'boolean'].includes(typeof value) && value !== '') {
      scalars.push(`<li><strong>${escapeHTML(label(key))}:</strong> ${escapeHTML(value)}</li>`);
    }
  }
  if (scalars.length) parts.push(`<ul>${scalars.join('')}</ul>`);
  return parts.concat(lists.filter(Boolean)).join('');
}

/** The entry for this field and name, or null. */
export function findEntry(entries, name) {
  const want = norm(name);
  if (!want || !Array.isArray(entries)) return null;
  return entries.find((e) => e && norm(e.name) === want) ?? null;
}

/**
 * The fields to write for an entry: the description, and flags that record
 * which entry version filled it. Null when the description is not safe to
 * save, so the caller keeps the item name-only.
 * @returns {{system: object, flags: object}|null}
 */
export function entryItemFill(entry, opts = {}) {
  if (!entry) return null;
  const html = entryDescriptionHTML(entry, opts);
  if (hasClearSecrets(html)) return null;
  return {
    system: { description: { value: html } },
    flags: {
      [FLAG_SCOPE]: {
        chronicleMade: true,
        entrySlug: entry.slug ?? '',
        entryUpdatedAt: entry.updatedAt ?? '',
        entryFormat: ENTRY_TEXT_FORMAT,
      },
    },
  };
}

/**
 * Items sync made earlier whose entry has changed since (or that were made
 * before entries could fill them, or filled by an older `ENTRY_TEXT_FORMAT`). Only the first item of the type is looked
 * at, the one the adapter reads, and only while its name still matches the
 * entry: a renamed pick is the swap planner's job.
 * @param {object} args
 * @param {Array<{id: string, name: string, type: string, flags?: object}>} args.items
 * @param {Array<{fieldKey: string, itemType: string}>} args.fields - identity fields
 * @param {object} args.fieldsData - Chronicle `fields_data`
 * @param {Record<string, Array<object>>} args.entriesByField
 * @param {(name: string) => string|null} [args.mentionId] - see `mentionLookup`
 * @returns {Array<{itemId: string, fieldKey: string, update: object}>}
 */
export function planEntryRefresh({ items, fields, fieldsData, entriesByField, mentionId }) {
  const list = Array.isArray(items) ? items : [];
  const data = fieldsData && typeof fieldsData === 'object' ? fieldsData : {};
  const out = [];
  for (const { fieldKey, itemType } of fields ?? []) {
    const first = list.find((it) => it && it.type === itemType);
    const flags = first?.flags?.[FLAG_SCOPE];
    if (!flags?.chronicleMade) continue;
    if (typeof data[fieldKey] !== 'string' || norm(data[fieldKey]) !== norm(first.name)) continue;
    const entry = findEntry(entriesByField?.[fieldKey], first.name);
    if (!entry) continue;
    const current = flags.entryFormat === ENTRY_TEXT_FORMAT;
    if (current && flags.entryUpdatedAt && flags.entryUpdatedAt === entry.updatedAt) continue;
    const fill = entryItemFill(entry, { mentionId });
    if (!fill) continue;
    out.push({
      itemId: first.id,
      fieldKey,
      update: {
        _id: first.id,
        'system.description.value': fill.system.description.value,
        [`flags.${FLAG_SCOPE}.entrySlug`]: fill.flags[FLAG_SCOPE].entrySlug,
        [`flags.${FLAG_SCOPE}.entryUpdatedAt`]: fill.flags[FLAG_SCOPE].entryUpdatedAt,
        [`flags.${FLAG_SCOPE}.entryFormat`]: ENTRY_TEXT_FORMAT,
      },
    });
  }
  return out;
}
