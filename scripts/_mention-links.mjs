/**
 * What a Chronicle mention (`<a data-mention-id>` in page text) becomes on
 * screen in Foundry. The saved page keeps Chronicle's own link, so a push
 * sends it back unchanged; only the drawn link is swapped. Its href is a
 * Chronicle path, which inside Foundry would leave the game, so it is never
 * drawn as it is. Pure: `tools/test-mention-links.mjs`.
 */

export const MENTION_SELECTOR = 'a[data-mention-id]';

/**
 * The name to show: Chronicle writes "@Name"; Foundry's links carry no "@".
 * @param {string} text
 * @returns {string}
 */
export function mentionLabel(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.replace(/^@/, '').trim() || t;
}

/**
 * The Chronicle address for a mention, only on the Chronicle site itself.
 * @param {string|null|undefined} href - as Chronicle saved it, usually a site path
 * @param {string|null|undefined} siteBase - the apiUrl setting
 * @returns {string|null}
 */
export function chronicleMentionUrl(href, siteBase) {
  const base = String(siteBase ?? '').trim().replace(/\/+$/, '');
  const h = String(href ?? '').trim();
  if (!base || !h) return null;
  let site;
  try {
    site = new URL(base);
  } catch {
    return null;
  }
  if (site.protocol !== 'https:' && site.protocol !== 'http:') return null;
  let url;
  try {
    url = h.startsWith('/') && !h.startsWith('//') ? new URL(base + h) : new URL(h);
  } catch {
    return null;
  }
  return url.origin === site.origin ? url.href : null;
}

/**
 * Decide how one mention is drawn for this user.
 * - The mentioned page has a journal here the user may read: a Foundry link to it.
 * - Otherwise, for the GM: a link that opens the page in Chronicle.
 * - Otherwise: the name as plain text, so a player never gets a dead link
 *   or a hint of a page they can't see.
 * @param {{id: string, text: string, href?: string|null}} mention
 * @param {object} ctx
 * @param {(entityId: string) => ({id: string, canRead: boolean}|null)} ctx.journalFor
 * @param {boolean} ctx.isGM
 * @param {string|null} [ctx.siteBase]
 * @returns {{kind: 'journal', label: string, journalId: string}
 *   | {kind: 'chronicle', label: string, url: string}
 *   | {kind: 'text', label: string}}
 */
export function mentionTarget(mention, { journalFor, isGM, siteBase }) {
  const label = mentionLabel(mention?.text);
  const id = String(mention?.id ?? '').trim();
  const journal = id ? journalFor(id) : null;
  if (journal?.canRead) return { kind: 'journal', label, journalId: journal.id };
  if (isGM) {
    const url = chronicleMentionUrl(mention?.href, siteBase);
    if (url) return { kind: 'chronicle', label, url };
  }
  return { kind: 'text', label };
}
