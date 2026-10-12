/**
 * Chronicle Sync - creature pictures (pure)
 *
 * A creature page's art is its page picture (`image_path`) and its token the
 * `token_image` field; both are Chronicle media ids, copied into the world by
 * the picture store. The portrait prefers the art and the token prefers the
 * token, each falling back to the other, then to the module's generic monster
 * token. A picture is set only when Chronicle's choice changes, so a token the
 * GM swapped in Foundry stays until the page's picture changes. An actor made
 * before pictures synced keeps any picture the GM gave it.
 */

import { MEDIA_ID_RE } from './_inline-pictures.mjs';
import { FLAG_SCOPE } from './constants.mjs';

export const TOKEN_FIELD = 'token_image';
export const GENERIC_TOKEN = 'modules/chronicle-sync/assets/generic-monster-token.svg';
/** Actor flag: the picture choice last applied, `{ img, token }`. */
export const PICTURES_FLAG = 'creaturePictures';
const GENERIC = 'generic';

/** A media id from a stored value; older pages hold "2026/03/<id>.jpg". */
export function mediaId(value) {
  const s = String(value ?? '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  return MEDIA_ID_RE.test(s) ? s.toLowerCase() : '';
}

/** Which media each role wants: an id, or 'generic'. */
export function pictureChoice(entity) {
  const art = mediaId(entity?.image_path);
  const token = mediaId(entity?.fields_data?.[TOKEN_FIELD]);
  return { img: art || token || GENERIC, token: token || art || GENERIC };
}

/** The ids the store must copy for this choice. */
export function pictureIds(choice) {
  return [...new Set([choice.img, choice.token].filter((k) => k !== GENERIC))];
}

/** A picture Foundry or the system put there, not one a GM chose. */
export function isStockPicture(path) {
  const p = String(path ?? '');
  return p === '' || /mystery-man/i.test(p) || p.startsWith('systems/');
}

/**
 * The actor changes for a choice. `local` maps id to the copied path; a role
 * whose copy failed is left as it is and retried on the next change.
 * `applied` is the choice last written (the actor's flag); `current` is the
 * actor's pictures now, `{ img, token }`, absent for a new actor.
 */
export function picturePlan({ choice, local, applied, current }) {
  const changes = {};
  const done = { ...(applied || {}) };
  const path = (key) => (key === GENERIC ? GENERIC_TOKEN : local?.get(key) || '');
  for (const [role, target] of [['img', 'img'], ['token', 'prototypeToken.texture.src']]) {
    if (applied && applied[role] === choice[role]) continue;
    if (!applied?.[role] && current && !isStockPicture(current[role])) {
      done[role] = choice[role];
      continue;
    }
    const p = path(choice[role]);
    if (!p) continue;
    changes[target] = p;
    done[role] = choice[role];
  }
  if (Object.keys(done).some((k) => done[k] !== applied?.[k])) changes[`flags.${FLAG_SCOPE}.${PICTURES_FLAG}`] = done;
  return changes;
}
