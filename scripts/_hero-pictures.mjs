/**
 * Chronicle Sync - hero pictures (pure)
 *
 * A hero page's portrait is its page picture (`image_path`) and its token the
 * `token_image` field when the page has one; both are Chronicle media ids,
 * copied into the world by the picture store. Each role falls back to the
 * other, and a page with neither changes nothing: sync never clears a Foundry
 * picture and never invents one. A picture is replaced only while it is still
 * a stock default or still the very file sync last wrote, so a portrait or
 * token a GM chose by hand stays.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { mediaId, isStockPicture, TOKEN_FIELD } from './_creature-pictures.mjs';

/** Actor flag: what sync last applied, `{ img, token, imgPath, tokenPath }`. */
export const HERO_PICTURES_FLAG = 'heroPictures';

const ROLES = [
  ['img', 'img', 'imgPath'],
  ['token', 'prototypeToken.texture.src', 'tokenPath'],
];

/** Which media each role wants: an id, or '' when the page has no picture. */
export function heroChoice(entity) {
  const art = mediaId(entity?.image_path);
  const token = mediaId(entity?.fields_data?.[TOKEN_FIELD]);
  return { img: art || token, token: token || art };
}

/** The ids the store must copy for this choice. */
export function heroPictureIds(choice) {
  return [...new Set([choice.img, choice.token].filter(Boolean))];
}

/**
 * The actor changes for a choice. `local` maps id to the copied path; a role
 * whose copy failed is left alone and retried on the next pull. `applied` is
 * the actor's flag; `current` is its pictures now, `{ img, token }`, absent
 * for a new actor.
 */
export function heroPicturePlan({ choice, local, applied, current }) {
  const changes = {};
  const done = { ...(applied || {}) };
  for (const [role, target, pathKey] of ROLES) {
    const want = choice[role];
    if (!want || applied?.[role] === want) continue;
    const path = local?.get(want) || '';
    if (!path) continue;
    const now = current?.[role];
    const ours = applied?.[pathKey] && now === applied[pathKey];
    if (current && !isStockPicture(now) && !ours) {
      // A hand-set picture: note the choice as seen, keep the file.
      done[role] = want;
      done[pathKey] = '';
      continue;
    }
    changes[target] = path;
    done[role] = want;
    done[pathKey] = path;
  }
  if (Object.keys(done).some((k) => done[k] !== applied?.[k])) changes[`flags.${FLAG_SCOPE}.${HERO_PICTURES_FLAG}`] = done;
  return changes;
}
