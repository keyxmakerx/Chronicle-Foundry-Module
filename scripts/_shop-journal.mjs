/**
 * Which Foundry journals are Chronicle shops. Chronicle knows a shop by its
 * entity type's slug, `shop`; the type's display name can be renamed, so the
 * name is only a fallback for journals synced before the slug was recorded.
 * A shop's journal page carries the shop's door (`addJournalDoor`).
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

// The shop's door, as Chronicle draws it on a shop page: an arched door
// with planks, two straps and a ring pull.
const JOURNAL_DOOR_SVG = '<svg viewBox="0 0 64 96" aria-hidden="true">'
  + '<path class="leaf" d="M6 94V34A26 26 0 0 1 58 34V94Z" stroke="currentColor" stroke-width="2.5"/>'
  + '<path d="M19 12V94M32 8V94M45 12V94" stroke="currentColor" stroke-width="1.4"/>'
  + '<path d="M10 46H40M10 74H40" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>'
  + '<circle cx="50" cy="60" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>'
  + '<path d="M2 94.5H62" stroke="currentColor" stroke-width="2.5"/></svg>';

/**
 * The shop's door, centred at the top of its journal page, with the shop's
 * name and "Step inside" under it. Pressing it walks straight into the room.
 * Added once per render; a sheet without a pages area gets none.
 * @param {HTMLElement|null|undefined} root - The journal sheet's element.
 * @param {string} name - The shop's name.
 * @param {string} hint - "Step inside", localized.
 * @param {() => void} open - Walks into the room.
 */
export function addJournalDoor(root, name, hint, open) {
  const pages = root?.querySelector('.journal-entry-pages') ?? root?.querySelector('[data-application-part="pages"]');
  if (!pages || pages.querySelector(':scope > .chronicle-shop-door')) return;
  const door = document.createElement('button');
  door.type = 'button';
  door.className = 'chronicle-shop-door';
  door.setAttribute('aria-haspopup', 'dialog');
  door.innerHTML = `<span class="door">${JOURNAL_DOOR_SVG}</span><span class="name"></span><span class="hint"></span>`;
  door.querySelector('.name').textContent = name;
  door.querySelector('.hint').textContent = hint;
  door.addEventListener('click', (e) => {
    e.preventDefault();
    open();
  });
  pages.prepend(door);
}
