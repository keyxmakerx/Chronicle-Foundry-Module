/**
 * Chronicle Sync — HTML sanitization helper (FM-SEC-CHUNK-3)
 *
 * Defense-in-depth sanitization for Chronicle-supplied HTML at journal /
 * note ingress. Closes M-3 as a SECOND layer on top of Chronicle's
 * already-shipped server-side sanitization (bluemonday UGCPolicy at the
 * service layer; see C-SECURITY-AUDIT §1.3 — 8 plugins sanitize
 * `EntryHTML` on write).
 *
 * Why a second layer:
 *   - Catches a future ingress path on Chronicle that forgets to call
 *     `sanitize.HTML` (regression on the server side).
 *   - Catches old database entries that pre-date a sanitization rule
 *     strengthening (Chronicle sanitizes on WRITE, not on read).
 *   - Catches a hypothetical bypass of Chronicle's sanitizer (e.g., a
 *     direct DB write tool that skips the service layer).
 *
 * Mechanism: delegate to Foundry's `TextEditor.cleanHTML` — the same
 * sanitizer Foundry runs at render time. Running it at INGRESS pins the
 * on-disk content to whatever Foundry considered safe at the time of
 * sync; future Foundry-renderer changes that loosen sanitization can't
 * reach back into already-stored data.
 *
 * Operator escape: setting `skipIncomingSanitization` (default false —
 * sanitization ON) bypasses this layer for high-trust deployments where
 * Foundry's `cleanHTML` strips legitimate inline styling Chronicle
 * deliberately ships. The world setting is GM-configurable per-world.
 *
 * Per FM-SECURITY-AUDIT §2 M-3, §4 Chunk 3, §0.5 D1=(c); cross-references
 * C-SECURITY-AUDIT §1.3 (Chronicle's primary sanitization).
 */

import { MODULE_ID } from './constants.mjs';

/**
 * Look up Foundry's HTML sanitizer across v12 / v13+ namespaces. The
 * function moved from a global `TextEditor` (v12) into
 * `foundry.applications.ux.TextEditor` (v13+). Either may be aliased
 * back to the global in some versions, so we probe both.
 *
 * @returns {((html: string) => string) | null}
 */
function _resolveCleanHTML() {
  try {
    const v13 = globalThis.foundry?.applications?.ux?.TextEditor?.cleanHTML;
    if (typeof v13 === 'function') return v13.bind(globalThis.foundry.applications.ux.TextEditor);
  } catch { /* ignore — fall through */ }
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
    // Fail-open: log once-per-session shape would be nicer but we don't
    // have a session-cache here; console.warn is fine because in v12-v14
    // TextEditor.cleanHTML is always available at module-ingest time
    // (SyncManager.start runs on `ready`, well after Foundry's init).
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
