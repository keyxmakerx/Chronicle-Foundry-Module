/**
 * Shows each Chronicle member's profile picture as their Foundry user avatar.
 *
 * GM only: updating another user needs the GM, and the member list comes
 * from the GM's API key. Runs after each member fetch (connect, and the
 * dashboard's refresh); Chronicle sends no event for a profile change.
 * The decisions are in `_avatar-sync.mjs`.
 */

import { MODULE_ID } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { extensionForMime } from './_inline-pictures.mjs';
import { _isAllowedImageHost } from './_url-validation.mjs';
import {
  AVATAR_DIR_NAME, AVATAR_FLAG, avatarMediaId, decideAvatar, absoluteChronicleLink,
} from './_avatar-sync.mjs';

/** An avatar is a small thumbnail; anything bigger is not one. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const FALLBACK_AVATAR = 'icons/svg/mystery-man.svg';

function filePicker() {
  const ns = globalThis.foundry?.applications?.apps?.FilePicker;
  return ns?.implementation ?? ns ?? globalThis.FilePicker?.implementation ?? globalThis.FilePicker ?? null;
}

export class AvatarSync {
  /**
   * @param {object} [deps] All optional; tests inject fakes.
   */
  constructor({ fetchFn, picker, worldId, users, isGM, apiUrl, defaultAvatar } = {}) {
    this._fetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
    this._picker = picker ?? filePicker;
    this._worldId = worldId ?? (() => globalThis.game?.world?.id ?? '');
    this._users = users ?? (() => globalThis.game?.users);
    this._isGM = isGM ?? (() => globalThis.game?.user?.isGM === true);
    this._apiUrl = apiUrl ?? (() => getSetting('apiUrl'));
    this._default = defaultAvatar ?? (() => globalThis.CONST?.DEFAULT_AVATAR ?? FALLBACK_AVATAR);
    /** @type {Set<string>|null} paths in the avatar folder, null until listed */
    this._files = null;
    this._dirReady = false;
  }

  get dir() {
    return `worlds/${this._worldId()}/${AVATAR_DIR_NAME}`;
  }

  /**
   * Bring matched users' avatars in line with their members' pictures. Never
   * throws: a failure for one user is logged and the rest go on.
   * @param {Array<object>} members - `GET /members`
   * @param {Object<string,string>} mappings - Chronicle user id → Foundry user id
   * @param {(member: object) => (string|null)} keyOf - member → mapping key
   */
  async apply(members, mappings, keyOf) {
    if (!this._isGM()) return;
    for (const member of members || []) {
      const key = keyOf(member);
      const user = key && mappings?.[key] ? this._users()?.get?.(mappings[key]) : null;
      if (!user) continue;
      try {
        await this._applyOne(user, member);
      } catch (err) {
        console.warn(`Chronicle: could not update the avatar of ${user.name}`, err);
      }
    }
  }

  /** @private */
  async _applyOne(user, member) {
    const mediaId = avatarMediaId(member.avatar_url);
    const applied = user.getFlag?.(MODULE_ID, AVATAR_FLAG) ?? null;
    if (applied?.path) await this._list();
    const action = decideAvatar({
      mediaId,
      current: user.avatar || '',
      applied,
      defaultAvatar: this._default(),
      copyExists: !!applied?.path && !!this._files?.has(decodeURIComponent(applied.path)),
    });
    if (action === 'apply') {
      const path = await this._copy(mediaId, member.avatar_url);
      if (!path) return;
      await user.update({ avatar: path, [`flags.${MODULE_ID}.${AVATAR_FLAG}`]: { id: mediaId, path } });
    } else if (action === 'clear') {
      await user.update({ avatar: this._default(), [`flags.${MODULE_ID}.-=${AVATAR_FLAG}`]: null });
    }
  }

  /** @private */
  async _list() {
    if (this._files) return;
    const files = new Set();
    try {
      const res = await this._picker()?.browse?.('data', this.dir);
      for (const f of res?.files || []) files.add(decodeURIComponent(String(f)));
      this._dirReady = true;
    } catch {
      // No folder yet: made on the first copy.
    }
    this._files = files;
  }

  /**
   * Copy the picture into the world's files, once per media id.
   * @returns {Promise<string>} the stored path, or '' when it couldn't be copied
   * @private
   */
  async _copy(mediaId, link) {
    await this._list();
    const url = absoluteChronicleLink(link, this._apiUrl(), _isAllowedImageHost);
    if (!url) return '';
    // No redirects and no credentials: the bytes come from the Chronicle host only.
    const res = await this._fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!res?.ok) return '';
    const blob = await res.blob();
    const ext = extensionForMime(blob?.type);
    if (!ext || blob.size > MAX_AVATAR_BYTES) return '';

    if (!this._dirReady) {
      try {
        await this._picker()?.createDirectory?.('data', this.dir, {});
      } catch (err) {
        if (!/EEXIST|exists/i.test(String(err?.message || err))) throw err;
      }
      this._dirReady = true;
    }
    const file = new File([blob], `${mediaId}.${ext}`, { type: blob.type });
    const up = await this._picker()?.upload?.('data', this.dir, file, {}, { notify: false });
    const path = up?.path || '';
    if (path) this._files.add(decodeURIComponent(path));
    return path;
  }
}
