/**
 * Local copies of the pictures inside Chronicle page text, kept in the
 * world's own folder (`worlds/<world>/chronicle-media/<uuid>.<ext>`).
 *
 * Chronicle serves media only through signed links that expire after
 * minutes, so a journal cannot point at Chronicle directly: players would
 * see a broken picture soon after every pull. A copy in the world's files is
 * served by Foundry itself, to everyone who can see the journal. Media ids
 * are random UUIDs and a file never changes under its id, so a copy is made
 * once and reused.
 *
 * GM-only pictures are never copied (scripts/_inline-pictures.mjs). The GM's
 * own client shows them from a fresh signed link, swapped in on screen by
 * `watchGMPictures`; the stored HTML keeps the plain Chronicle path.
 *
 * GM only: uploading to the world's files needs the GM's file permission,
 * and the signed links need the GM's API key.
 */

import { getSetting } from './settings.mjs';
import { _isAllowedImageHost, _describeRejection } from './_url-validation.mjs';
import {
  MEDIA_ID_RE, PICTURE_DIR_NAME, extensionForMime, chronicleSrcFor,
} from './_inline-pictures.mjs';

/** A copy larger than this is skipped; Chronicle's own upload limit is lower. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

/** Signed links last 15 minutes on Chronicle; reuse one for 10. */
const SIGNED_LINK_TTL_MS = 10 * 60 * 1000;

/**
 * Foundry's FilePicker across v12 (global) and v13+ (namespaced).
 * @returns {any|null}
 */
function filePicker() {
  const ns = globalThis.foundry?.applications?.apps?.FilePicker;
  return ns?.implementation ?? ns ?? globalThis.FilePicker?.implementation ?? globalThis.FilePicker ?? null;
}

export class PictureStore {
  /**
   * @param {object} deps
   * @param {{get: (path: string) => Promise<any>}} deps.api Chronicle API client.
   * @param {() => string} [deps.worldId]
   * @param {typeof fetch} [deps.fetchFn]
   * @param {() => any} [deps.picker] FilePicker class.
   */
  constructor({ api, worldId, fetchFn, picker } = {}) {
    this._api = api;
    this._worldId = worldId ?? (() => globalThis.game?.world?.id ?? '');
    this._fetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
    this._picker = picker ?? filePicker;
    /** @type {Map<string, string>|null} media id → local path, null until listed */
    this._known = null;
    /** @type {Map<string, Promise<string>>} */
    this._inFlight = new Map();
    /** @type {Map<string, {url: string, at: number}>} */
    this._signed = new Map();
    this._dirReady = null;
  }

  /** The world-relative folder the copies live in. */
  get dir() {
    return `worlds/${this._worldId()}/${PICTURE_DIR_NAME}`;
  }

  /**
   * Make sure each id has a local copy. Never throws: a picture that can't
   * be copied keeps its Chronicle path and is retried on the next pull.
   * @param {string[]} ids
   * @returns {Promise<Map<string, string>>} id → local path, for the ids copied
   */
  async ensure(ids) {
    const out = new Map();
    const wanted = (ids || []).filter((id) => MEDIA_ID_RE.test(id));
    if (wanted.length === 0) return out;
    await this._listExisting();
    for (const id of wanted) {
      const path = await this._ensureOne(id);
      if (path) out.set(id, path);
    }
    return out;
  }

  /** @private */
  async _listExisting() {
    if (this._known) return;
    const known = new Map();
    try {
      const res = await this._picker()?.browse?.('data', this.dir);
      for (const file of res?.files || []) {
        const m = /([0-9a-f-]{36})\.[a-z0-9]+$/i.exec(decodeURIComponent(String(file)));
        if (m && MEDIA_ID_RE.test(m[1])) known.set(m[1].toLowerCase(), file);
      }
      this._dirReady = Promise.resolve(true);
    } catch {
      // No folder yet: made on the first copy.
    }
    this._known = known;
  }

  /** @private */
  async _ensureDir() {
    if (!this._dirReady) {
      this._dirReady = (async () => {
        try {
          await this._picker()?.createDirectory?.('data', this.dir, {});
        } catch (err) {
          // Already there is fine; anything else surfaces on the upload.
          if (!/EEXIST|exists/i.test(String(err?.message || err))) {
            console.warn('Chronicle: could not create the picture folder', err);
          }
        }
        return true;
      })();
    }
    return this._dirReady;
  }

  /** @private */
  _ensureOne(id) {
    const known = this._known?.get(id);
    if (known) return Promise.resolve(known);
    if (!this._inFlight.has(id)) {
      const p = this._copy(id)
        .catch((err) => {
          console.warn(`Chronicle: could not copy picture ${id}`, err);
          return '';
        })
        .finally(() => this._inFlight.delete(id));
      this._inFlight.set(id, p);
    }
    return this._inFlight.get(id);
  }

  /** @private */
  async _copy(id) {
    const meta = await this._api.get(`/media/${id}`);
    const ext = extensionForMime(meta?.mime_type);
    if (!ext) return '';
    if (Number(meta?.file_size) > MAX_PICTURE_BYTES) return '';

    const url = this._absolute(meta?.url || '');
    if (!url) return '';
    // No redirects: the bytes must come from the Chronicle host itself.
    const res = await this._fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!res?.ok) return '';
    const blob = await res.blob();
    if (!blob || blob.size > MAX_PICTURE_BYTES) return '';
    if (extensionForMime(blob.type) !== ext) return '';

    await this._ensureDir();
    const file = new File([blob], `${id}.${ext}`, { type: blob.type });
    const up = await this._picker()?.upload?.('data', this.dir, file, {}, { notify: false });
    const path = up?.path || '';
    if (path) this._known?.set(id, path);
    return path;
  }

  /**
   * A media link from Chronicle made absolute, only on the Chronicle host.
   * @private
   */
  _absolute(link) {
    const apiUrl = getSetting('apiUrl');
    if (!link) return '';
    if (/^https?:/i.test(link)) {
      if (_isAllowedImageHost(link, apiUrl)) return link;
      console.warn(_describeRejection('inline_picture', link, apiUrl));
      return '';
    }
    const base = String(apiUrl || '').replace(/\/+$/, '');
    return base ? `${base}${link.startsWith('/') ? '' : '/'}${link}` : '';
  }

  /**
   * A fresh signed link for one picture, for the GM's own screen only.
   * @param {string} id
   * @returns {Promise<string>}
   */
  async signedLink(id) {
    if (!MEDIA_ID_RE.test(id)) return '';
    const hit = this._signed.get(id);
    if (hit && Date.now() - hit.at < SIGNED_LINK_TTL_MS) return hit.url;
    try {
      const meta = await this._api.get(`/media/${id}`);
      const url = this._absolute(meta?.url || '');
      if (url) this._signed.set(id, { url, at: Date.now() });
      return url;
    } catch {
      return '';
    }
  }
}

/**
 * Show GM-only pictures on the GM's screen. They are stored with the plain
 * Chronicle path, which Foundry can't load; this swaps a fresh signed link
 * into each such <img> as it appears. Editors are left alone, so the
 * swapped link is never typed into a saved page.
 * @param {PictureStore} store
 * @returns {() => void} stop watching
 */
export function watchGMPictures(store) {
  const root = globalThis.document?.body;
  const MO = globalThis.MutationObserver;
  if (!root || !MO) return () => {};
  const apiUrl = () => getSetting('apiUrl');

  const fix = (img) => {
    if (img.closest?.('[contenteditable="true"], .ProseMirror')) return;
    if (!img.closest?.('section.secret')) return;
    const plain = chronicleSrcFor(img.getAttribute('src'), apiUrl());
    if (!plain) return;
    const id = plain.slice('/media/'.length);
    store.signedLink(id).then((url) => {
      if (url && img.getAttribute('src') !== url) img.setAttribute('src', url);
    });
  };
  const scan = (node) => {
    if (node?.nodeType !== 1) return;
    if (node.tagName === 'IMG') fix(node);
    else node.querySelectorAll?.('section.secret img').forEach(fix);
  };

  const obs = new MO((records) => {
    for (const r of records) r.addedNodes.forEach(scan);
  });
  obs.observe(root, { childList: true, subtree: true });
  return () => obs.disconnect();
}
