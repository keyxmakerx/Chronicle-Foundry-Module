/**
 * Chronicle mentions in synced journals, drawn as links that work in
 * Foundry. Every user's client swaps each `<a data-mention-id>` on screen
 * for a Foundry link to the mentioned page's journal (`_mention-links.mjs`
 * decides which kind). The saved page is never changed, so pushes send
 * Chronicle's mention back as it came.
 *
 * Watches the whole document, like `gm-secret-view.mjs`, so it covers every
 * journal sheet in v12 to v14, pages shown inline and secret blocks the GM's
 * view fills in. Editors are skipped: they must show the saved text.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { MENTION_SELECTOR, mentionTarget } from './_mention-links.mjs';

const DONE = 'data-chronicle-mention';

/** The linked journal for a Chronicle page id, and whether this user may read it. */
function journalFor(entityId) {
  const journal = game.journal?.find?.((j) => j.getFlag?.(FLAG_SCOPE, 'entityId') === entityId);
  if (!journal) return null;
  const canRead = game.user?.isGM || journal.testUserPermission?.(game.user, 'OBSERVER') === true;
  return { id: journal.id, canRead };
}

function siteBase() {
  try {
    return getSetting('apiUrl') || null;
  } catch {
    return null;
  }
}

/** The element that replaces one mention on screen. */
function drawn(a) {
  const target = mentionTarget(
    { id: a.getAttribute('data-mention-id'), text: a.textContent, href: a.getAttribute('href') },
    { journalFor, isGM: game.user?.isGM === true, siteBase: siteBase() },
  );
  if (target.kind === 'journal') {
    const journal = game.journal.get(target.journalId);
    const link = journal?.toAnchor?.({ name: target.label });
    if (link) return link;
  }
  if (target.kind === 'chronicle') {
    const link = document.createElement('a');
    link.href = target.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'chronicle-mention-out';
    link.title = game.i18n.localize('CHRONICLE.Mentions.OpenInChronicle');
    link.textContent = target.label;
    return link;
  }
  const span = document.createElement('span');
  span.className = 'chronicle-mention-text';
  span.textContent = target.label;
  return span;
}

/**
 * Start drawing mentions as Foundry links. Every user.
 * @returns {() => void} stops watching
 */
export function watchMentionLinks() {
  const root = globalThis.document?.body;
  const MO = globalThis.MutationObserver;
  if (!root || !MO) return () => {};

  const swap = (a) => {
    if (a.hasAttribute(DONE)) return;
    if (a.closest?.('[contenteditable="true"], .ProseMirror, textarea')) return;
    try {
      const el = drawn(a);
      el.setAttribute(DONE, '1');
      a.replaceWith(el);
    } catch (err) {
      // A link that can't be drawn stays as it is rather than breaking the page.
      a.setAttribute(DONE, 'failed');
      console.warn('Chronicle Sync | Could not draw a mention link', err);
    }
  };
  const scan = (node) => {
    if (node?.nodeType !== 1) return;
    if (node.matches?.(MENTION_SELECTOR)) swap(node);
    node.querySelectorAll?.(MENTION_SELECTOR).forEach(swap);
  };

  scan(root);
  const obs = new MO((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
  });
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}
