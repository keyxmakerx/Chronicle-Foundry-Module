/**
 * Chronicle Sync - token art on hover (pure)
 *
 * Hovering a token shows its actor's full picture beside the cursor, when
 * that picture is a real one and not just the token again. The GM can switch
 * it off for one token (token flag) or for the world; each person can switch
 * previews off for themselves. A hidden token, or one whose disposition is
 * Secret, never shows its art to a player: Secret is Foundry's "give nothing
 * away" disposition, used for disguised and mimic tokens.
 */

import { GENERIC_TOKEN, isStockPicture } from './_creature-pictures.mjs';

/** Token flag: `false` when the GM switched this token's preview off. */
export const HOVER_ART_FLAG = 'hoverArt';
/** Foundry's CONST.TOKEN_DISPOSITIONS.SECRET. */
export const SECRET_DISPOSITION = -2;
/** How long the cursor rests on a token before its art shows, in ms. */
export const HOVER_DELAY_MS = 350;
/** Gap between the cursor and the preview, in px. */
export const CURSOR_GAP = 18;

/**
 * The art a token could show, ignoring who is looking: the actor's portrait
 * when it is a real picture that differs from the token's own image.
 * @param {{actorImg?: string, tokenSrc?: string}} p
 * @returns {string} the path, or '' when there is nothing more to show
 */
export function tokenArt({ actorImg, tokenSrc }) {
  const img = String(actorImg ?? '').trim();
  if (isStockPicture(img) || img === GENERIC_TOKEN) return '';
  if (img === String(tokenSrc ?? '').trim()) return '';
  return img;
}

/**
 * The art this viewer sees on hover, or ''.
 * @param {object} p
 * @param {string} [p.actorImg] - the token's actor portrait
 * @param {string} [p.tokenSrc] - the token's own image
 * @param {*} [p.flag] - the token's HOVER_ART_FLAG value
 * @param {number} [p.disposition]
 * @param {boolean} [p.hidden] - the token is hidden from players
 * @param {boolean} p.isGM
 * @param {boolean} p.worldOn - the GM's world switch
 * @param {boolean} p.clientOn - this person's own switch
 */
export function hoverArtFor(p) {
  if (!p.clientOn || !p.worldOn) return '';
  if (p.flag === false) return '';
  if (!p.isGM && (p.hidden || p.disposition === SECRET_DISPOSITION)) return '';
  return tokenArt(p);
}

/**
 * Where the preview goes: below and right of the cursor, flipped to the
 * other side of it on an edge, and kept inside the window.
 * @param {{x: number, y: number}} cursor
 * @param {{width: number, height: number}} box - the preview's size
 * @param {{width: number, height: number}} view - the window's size
 * @returns {{left: number, top: number}}
 */
export function previewPlace(cursor, box, view, gap = CURSOR_GAP) {
  let left = cursor.x + gap;
  let top = cursor.y + gap;
  if (left + box.width > view.width) left = cursor.x - gap - box.width;
  if (top + box.height > view.height) top = cursor.y - gap - box.height;
  left = Math.max(0, Math.min(left, view.width - box.width));
  top = Math.max(0, Math.min(top, view.height - box.height));
  return { left: Math.round(left), top: Math.round(top) };
}
