/**
 * HTML-escape for text that Chronicle or a user supplied and that Foundry
 * may insert as HTML (ui.notifications on v12, dialog content). Pure, so it
 * runs under node --test.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {any} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/**
 * Text for a ui.notifications message. Foundry v12 inserts the message as
 * HTML and v13+ still treats it as HTML (only sanitised), so escaping keeps
 * a name literal on every version.
 * @param {any} value
 * @returns {string}
 */
export function noticeText(value) {
  return escapeHtml(value);
}
