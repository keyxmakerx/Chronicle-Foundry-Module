/**
 * The GM's view of GM-only text in synced journals.
 *
 * A saved page holds only a placeholder for each secret block that came from
 * Chronicle (scripts/_gm-secrets.mjs), so players never receive the text.
 * On the GM's client this fills each placeholder, as it appears on screen,
 * with the content from Chronicle. It changes only what is drawn, never the
 * page, and skips the editor, where the placeholder must stay as it is.
 *
 * Watches the whole document rather than a sheet's render hook, so it
 * works for every journal sheet in v12 to v14 and for pages shown inline.
 * Revealing such a block to players shows them only the placeholder.
 */

import { PLACEHOLDER_ID_PREFIX } from './_gm-secrets.mjs';
import { _sanitizeIncomingHTML } from './_html-sanitizer.mjs';

const SELECTOR = `section.secret[id^="${PLACEHOLDER_ID_PREFIX}"]`;
const FILLED = 'data-chronicle-shown';

/**
 * Start filling placeholders on screen. GM clients only.
 * @param {(id: string) => Promise<string|null>|string|null} lookup -
 *   placeholder id -> its GM-only HTML, or null when unknown
 * @returns {() => void} stops watching
 */
export function watchGMSecrets(lookup) {
  const root = globalThis.document?.body;
  const MO = globalThis.MutationObserver;
  if (!root || !MO) return () => {};

  const fill = (sec) => {
    if (sec.hasAttribute(FILLED)) return;
    if (sec.closest?.('[contenteditable="true"], .ProseMirror, textarea')) return;
    sec.setAttribute(FILLED, 'pending');
    Promise.resolve(lookup(sec.id)).then((html) => {
      if (html == null || !sec.isConnected) {
        sec.removeAttribute(FILLED);
        return;
      }
      sec.setAttribute(FILLED, '1');
      // Foundry's own controls inside the block (its Reveal button) stay.
      for (const child of [...sec.children]) if (child.tagName !== 'BUTTON') child.remove();
      sec.insertAdjacentHTML('afterbegin', _sanitizeIncomingHTML(html));
    }).catch(() => sec.removeAttribute(FILLED));
  };
  const scan = (node) => {
    if (node?.nodeType !== 1) return;
    if (node.matches?.(SELECTOR)) fill(node);
    node.querySelectorAll?.(SELECTOR).forEach(fill);
  };

  scan(root);
  const obs = new MO((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
  });
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}
