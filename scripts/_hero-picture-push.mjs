/**
 * Chronicle Sync - a hero's Foundry pictures going to Chronicle (pure)
 *
 * The portrait becomes the page picture and the token the page's
 * `token_image`, even when both are one file: the token Foundry shows is then
 * the portrait, and Chronicle says so too rather than keeping an older token. A stock picture (Foundry's mystery man, a system icon)
 * is no choice, so it is never sent; nor is a file sync itself wrote from
 * Chronicle, or one already sent, both recorded in the `heroPictures` flag.
 * Only a world file is read: an outside address would be another site's
 * picture, which the module never fetches.
 */

import { isStockPicture } from './_creature-pictures.mjs';
import { HERO_PICTURES_FLAG } from './_hero-pictures.mjs';
import { FLAG_SCOPE } from './constants.mjs';

/** Pending-change key: the actor's portrait or token picture changed. */
export const PICTURES_CHANGED = 'chroniclePictures';

/** Whether a Foundry actor diff changes the portrait or the token picture. */
export function changesPictures(change) {
  return change?.img !== undefined || change?.prototypeToken?.texture?.src !== undefined;
}

/** Picture types Chronicle keeps as media; an SVG can carry script. */
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Whether a picture path is a file in this Foundry install. A browser reads a
 * backslash as a slash, so one could make a path another site's address;
 * those and control characters are refused outright.
 */
export function isWorldFile(path) {
  const p = String(path ?? '').trim();
  if (!p || /[\\\u0000-\u001f\u007f]/.test(p) || p.startsWith('//') || p.includes('..')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(p);
}

/**
 * The address to read a world file from, or '' when it would leave this
 * Foundry: the resolved address must be on the page's own origin.
 * @param {string} route - the file's route (`foundry.utils.getRoute`).
 * @param {string} origin - the page's origin.
 */
export function sameOriginUrl(route, origin) {
  try {
    const url = new URL(route, `${origin}/`);
    return url.origin === origin ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * The pictures to send: `{ role, path }` for the portrait (`img`) and the
 * token (`token`).
 * @param {{img?: string, token?: string, applied?: object|null}} p
 * @returns {Array<{role: 'img'|'token', path: string}>}
 */
export function picturesToPush({ img, token, applied }) {
  const out = [];
  const wanted = (path, pathKey) => isWorldFile(path) && !isStockPicture(path) && applied?.[pathKey] !== path;
  if (wanted(img, 'imgPath')) out.push({ role: 'img', path: img });
  if (wanted(token, 'tokenPath')) out.push({ role: 'token', path: token });
  return out;
}

/** Whether a fetched picture may be sent: a raster type, within `max` bytes. */
export function sendablePicture(blob, max) {
  return !!blob && RASTER.has(String(blob.type).split(';')[0].trim().toLowerCase()) && blob.size > 0 && blob.size <= max;
}

/** The file name a picture is uploaded under: the path's last part. */
export function pictureName(path) {
  return String(path).split('?')[0].split('/').pop() || 'picture';
}

/**
 * The flag update recording a sent picture, so the next pull sees Chronicle's
 * new media as already applied and the next push skips the file.
 * @param {object|null} applied
 * @param {'img'|'token'} role
 * @param {string} mediaId
 * @param {string} path
 */
export function sentFlag(applied, role, mediaId, path) {
  const done = { ...(applied || {}), [role]: mediaId, [`${role}Path`]: path };
  return { [`flags.${FLAG_SCOPE}.${HERO_PICTURES_FLAG}`]: done };
}
