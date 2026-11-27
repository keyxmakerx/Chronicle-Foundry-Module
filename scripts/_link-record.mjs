/**
 * Pure rules for the GM-only record of the Chronicle links sync made.
 *
 * Only sync makes a Chronicle link. The record lives in a world setting,
 * which only a GM can write; on the GM's connect every link is checked
 * against it, and against Chronicle's own sync mappings, which only the GM's
 * key writes. A link neither one confirms was not made by sync.
 *
 * Every client receives world settings, so the record holds only hashes of
 * the links: a player learns how many there are, never which journals or
 * pages, hidden ones included.
 */

/** Document kinds the record covers, each with the flags that form its link. */
export const LINK_KINDS = {
  journals: ['entityId', 'noteId'],
  actors: ['entityId'],
};

/**
 * The link a document carries, or null when it carries none.
 * @param {{getFlag: Function}} doc
 * @param {string} scope the module's flag scope
 * @param {'journals'|'actors'} kind
 * @returns {Record<string, string>|null}
 */
export function linkOf(doc, scope, kind) {
  const out = {};
  for (const key of LINK_KINDS[kind] || []) {
    const v = doc?.getFlag?.(scope, key);
    if (typeof v === 'string' && v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The hash that stands for one document's link in the record.
 * @param {'journals'|'actors'} kind
 * @param {string} id the document's id
 * @param {Record<string, string>} link
 * @returns {Promise<string>}
 */
export async function linkHash(kind, id, link) {
  const parts = [kind, id, ...(LINK_KINDS[kind] || []).map((k) => link?.[k] ?? '')];
  const bytes = new TextEncoder().encode(parts.join('\u0000'));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The record's hashes, whatever the setting holds; null when there is no
 * record yet.
 * @param {unknown} raw
 * @returns {Set<string>|null}
 */
export function readRecord(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.links)) return null;
  return new Set(raw.links.filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
}

/**
 * The setting value for a set of hashes, sorted so the same links always
 * save the same value.
 * @param {Iterable<string>} hashes
 * @returns {{v: number, links: string[]}}
 */
export function recordValue(hashes) {
  return { v: 1, links: [...new Set(hashes)].sort() };
}

/**
 * The documents whose link no GM made: neither the record nor a Chronicle
 * mapping of this document to that page confirms it. A note link (noteId)
 * has no mapping, so only the record confirms it.
 * @param {{kind: string, id: string, name?: string, link: object|null, hash?: string}[]} docs
 * @param {Set<string>} recorded
 * @param {Set<string>|null} mapped `${foundryId}:${entityId}` for each mapping
 * @returns {object[]} the unconfirmed documents, as given
 */
export function unconfirmedLinks(docs, recorded, mapped) {
  const out = [];
  for (const d of docs || []) {
    if (!d?.link || !LINK_KINDS[d.kind]) continue;
    if (d.hash && recorded?.has(d.hash)) continue;
    const pageOnly = d.link.entityId && !d.link.noteId;
    if (pageOnly && mapped?.has(`${d.id}:${d.link.entityId}`)) continue;
    out.push(d);
  }
  return out;
}
