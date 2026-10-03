/**
 * Chronicle stores category icons as bare Font Awesome names (`fa-ship`) and
 * adds the style class itself when it renders them, so the module sends the
 * bare name. A leading style token Chronicle would drop anyway is stripped
 * here; anything else is sent as typed and Chronicle's 400 explains it.
 */

/** Used when no icon is given. */
export const DEFAULT_ICON = 'fa-circle';

// The style tokens Chronicle's sanitize.NormalizeIcon accepts ahead of a name.
const STYLE_TOKENS = new Set(['fa-solid', 'fas', 'fa-regular', 'far', 'fa']);

/**
 * `'fa-solid fa-ship'` → `'fa-ship'`; blank → DEFAULT_ICON.
 * @param {unknown} raw
 * @returns {string}
 */
export function toIconName(raw) {
  const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return DEFAULT_ICON;
  if (parts.length > 1 && STYLE_TOKENS.has(parts[0])) parts.shift();
  return parts.join(' ');
}
