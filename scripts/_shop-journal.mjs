/**
 * Which Foundry journals are Chronicle shops. Chronicle knows a shop by its
 * entity type's slug, `shop`; the type's display name can be renamed, so the
 * name is only a fallback for journals synced before the slug was recorded.
 * `tools/test-shop-journal.mjs`.
 */

/** Journal flag holding the Chronicle entity type's slug. */
export const TYPE_SLUG_FLAG = 'entityTypeSlug';

/**
 * @param {JournalEntry|null|undefined} journal
 * @param {string} scope - The module's flag scope.
 * @returns {boolean}
 */
export function isShopJournal(journal, scope) {
  if (!journal?.getFlag?.(scope, 'entityId')) return false;
  const slug = journal.getFlag(scope, TYPE_SLUG_FLAG);
  if (slug) return slug === 'shop';
  return String(journal.getFlag(scope, 'entityType') || '').trim().toLowerCase() === 'shop';
}

/**
 * The journal entry a directory context-menu row stands for. Foundry 12
 * passes a jQuery row keyed `documentId`; 13 and later pass the element,
 * keyed `entryId`.
 * @returns {JournalEntry|null}
 */
export function journalFromRow(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  const id = el?.dataset?.entryId || el?.dataset?.documentId;
  return id ? game.journal.get(id) ?? null : null;
}
