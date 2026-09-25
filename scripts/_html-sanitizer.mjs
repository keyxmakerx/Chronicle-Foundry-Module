/**
 * Defense-in-depth sanitization for Chronicle-supplied HTML at journal /
 * note ingress, on top of Chronicle's own server-side sanitization. Catches
 * a Chronicle ingress path that skips sanitization, pre-existing rows from
 * before a sanitization rule tightened (Chronicle sanitizes on write, not
 * read), or a bypass of Chronicle's sanitizer.
 *
 * Delegates to Foundry's `TextEditor.cleanHTML`, run at ingress so stored
 * content is pinned to what Foundry considered safe at sync time — a later
 * loosening of Foundry's render-time sanitizer can't reach already-stored
 * data.
 *
 * The `skipIncomingSanitization` world setting (default off) lets an
 * operator disable this layer for high-trust deployments where cleanHTML
 * strips legitimate inline styling.
 */

import { MODULE_ID } from './constants.mjs';

/**
 * Look up Foundry's HTML sanitizer across v12 / v13 / v14+ namespaces:
 * `TextEditor.cleanHTML` moved from a v12 global into
 * `foundry.applications.ux.TextEditor` in v13, then onto that namespace's
 * `.implementation` in v14. Probe most-specific-modern first so we don't
 * touch the deprecated v12 global (which logs a warning on every access)
 * unless nothing else resolves.
 *
 * @returns {((html: string) => string) | null}
 */
function _resolveCleanHTML() {
  const ns = globalThis.foundry?.applications?.ux?.TextEditor;
  // v14+: the static lives on the implementation class.
  try {
    const impl = ns?.implementation?.cleanHTML;
    if (typeof impl === 'function') return impl.bind(ns.implementation);
  } catch { /* ignore — fall through */ }
  // v13: the static lived directly on the namespace object.
  try {
    const direct = ns?.cleanHTML;
    if (typeof direct === 'function') return direct.bind(ns);
  } catch { /* ignore — fall through */ }
  // v12: global TextEditor (deprecated in v13+, slated for removal in v15).
  try {
    const v12 = globalThis.TextEditor?.cleanHTML;
    if (typeof v12 === 'function') return v12.bind(globalThis.TextEditor);
  } catch { /* ignore — fall through */ }
  return null;
}

/**
 * Sanitize an HTML string coming from Chronicle before it lands in a
 * Foundry document. Safe to call with non-string / empty input.
 *
 * Behavior:
 *   - If `skipIncomingSanitization` is true: return input unchanged.
 *   - If TextEditor.cleanHTML is unavailable: return input unchanged +
 *     console.warn (fail-open, because Foundry's render-time sanitizer
 *     is still in place; blocking ingest would break the module).
 *   - If input is not a string: coerce empty / non-string to ''.
 *   - Otherwise: return `TextEditor.cleanHTML(html)`.
 *
 * @param {*} html - Candidate HTML. Strings are sanitized; anything else
 *   is coerced to ''.
 * @returns {string}
 */
export function _sanitizeIncomingHTML(html) {
  if (typeof html !== 'string') return '';
  if (!html) return '';

  // Operator escape: disable this layer for high-trust deployments where
  // cleanHTML strips legitimate content. The check is wrapped because
  // `game.settings` is undefined in unit tests / before `init` ran.
  let skip = false;
  try {
    skip = globalThis.game?.settings?.get?.(MODULE_ID, 'skipIncomingSanitization') === true;
  } catch { /* not registered yet (e.g., very early init) — treat as default: sanitize */ }
  if (skip) return html;

  const clean = _resolveCleanHTML();
  if (!clean) {
    // Fail-open: Foundry's render-time sanitizer still applies, so we warn
    // rather than block ingest.
    console.warn(
      'Chronicle Sync [html-sanitizer]: TextEditor.cleanHTML not found; ' +
      'storing Chronicle HTML without ingress sanitization. Foundry render-time ' +
      'sanitization still applies. Verify Foundry version is v12+.'
    );
    return html;
  }

  try {
    return clean(html);
  } catch (err) {
    console.warn('Chronicle Sync [html-sanitizer]: cleanHTML threw; storing raw HTML', err);
    return html;
  }
}
