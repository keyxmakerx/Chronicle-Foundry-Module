/**
 * Decisions for showing a member's Chronicle profile picture as their Foundry
 * user avatar. Pure: the file copy and the user update live in
 * `avatar-sync.mjs`.
 *
 * Chronicle's picture link is signed and expires in minutes, so Foundry can't
 * keep it; the picture is copied into the world's files and the copy's path
 * becomes the avatar. A picture change makes a new media id, so the id in the
 * link is the picture's identity.
 *
 * A player's own choice in Foundry wins: we remember the path we applied, and
 * an avatar that differs from it (or a non-default one when we've applied
 * nothing yet) was set by the user and is left alone.
 */

import { MEDIA_ID_RE } from './_inline-pictures.mjs';

/** Folder, inside the world's own folder, holding the avatar copies. */
export const AVATAR_DIR_NAME = 'chronicle-avatars';

/** User flag key (under the module's scope) holding `{ id, path }`. */
export const AVATAR_FLAG = 'avatar';

const THUMB_LINK_RE = /^\/media\/([0-9a-f-]{36})\/thumb\/\d+(?:[?#].*)?$/i;

/**
 * The media id inside a member's `avatar_url`, or null when there is no
 * picture or the link isn't a Chronicle thumbnail path (so nothing else is
 * ever fetched).
 * @param {unknown} avatarUrl
 * @returns {string|null}
 */
export function avatarMediaId(avatarUrl) {
  const m = THUMB_LINK_RE.exec(String(avatarUrl || ''));
  return m && MEDIA_ID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

/**
 * What to do for one matched user.
 *
 * @param {object} p
 * @param {string|null} p.mediaId - The member's current picture id, or null for none.
 * @param {string} p.current - The Foundry user's avatar now.
 * @param {{id: string, path: string}|null} p.applied - What we last applied.
 * @param {string} p.defaultAvatar - Foundry's placeholder avatar path.
 * @param {boolean} p.copyExists - Whether the file at `applied.path` is still there.
 * @returns {'apply'|'clear'|'keep'|'skip'}
 *   apply: copy the picture and set it; clear: back to the placeholder;
 *   keep: already showing; skip: the user's own avatar, leave it.
 */
export function decideAvatar({ mediaId, current, applied, defaultAvatar, copyExists }) {
  const mine = applied?.path && current === applied.path;
  if (applied?.path && !mine) return 'skip';
  if (!applied?.path && current && current !== defaultAvatar) return 'skip';
  if (!mediaId) return mine ? 'clear' : 'keep';
  if (mine && applied.id === mediaId && copyExists) return 'keep';
  return 'apply';
}

/**
 * A Chronicle link made absolute, only on the configured Chronicle host.
 * @param {string} link
 * @param {string} apiUrl
 * @returns {string} '' when the link is not acceptable
 */
export function absoluteChronicleLink(link, apiUrl, isAllowedHost) {
  if (!link || !apiUrl) return '';
  if (/^https?:/i.test(link)) return isAllowedHost(link, apiUrl) ? link : '';
  if (!link.startsWith('/')) return '';
  return `${String(apiUrl).replace(/\/+$/, '')}${link}`;
}
