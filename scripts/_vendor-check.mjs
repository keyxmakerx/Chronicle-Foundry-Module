/**
 * Whether this module's copies of Chronicle's page code (vendor/chronicle/)
 * are the files the connected Chronicle serves. Chronicle reports a digest
 * per copy from `GET /vendored-assets` on the sync API; the module compares
 * them with its own manifest and only reports. Nothing is ever loaded from
 * the server. `tools/test-vendor-check.mjs`.
 */

import { VENDOR_MANIFEST } from './_vendor-manifest.mjs';

/** The engines in the order the Health pane names them. */
export const ENGINES = ['cutscenes', 'shop', 'sky', 'crafting'];

export const VENDOR_ASSETS_PATH = '/vendored-assets';

// Chronicle's list is about two dozen files; the caps keep a bad answer
// from costing more than a glance.
export const MAX_ASSETS = 100;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_RE = /^[0-9a-f]{12}$/;

/**
 * Chronicle's `assets` map, checked: file-name keys of at most 64
 * characters, 12-hex values, at most MAX_ASSETS entries looked at. Bad
 * entries are dropped one by one.
 * @param {unknown} body - the endpoint's JSON
 * @returns {Readonly<Record<string, string>>|null} null when there is no map
 */
export function parseVendoredAssets(body) {
  const raw = body?.assets ?? body?.data?.assets;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.create(null);
  let seen = 0;
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    if (++seen > MAX_ASSETS) break;
    const v = raw[key];
    if (NAME_RE.test(key) && typeof v === 'string' && DIGEST_RE.test(v)) out[key] = v;
  }
  return Object.freeze(out);
}

/**
 * The engines with at least one copy whose digest differs from Chronicle's.
 * A copy Chronicle doesn't list is ignored, and no list at all (an older
 * Chronicle) is no difference.
 * @param {Record<string, {engine: string, digest: string}>} manifest
 * @param {Record<string, string>|null|undefined} assets
 * @returns {string[]} engine ids, in ENGINES order
 */
export function compareEngines(manifest, assets) {
  if (!assets || typeof assets !== 'object') return [];
  const off = new Set();
  for (const [file, entry] of Object.entries(manifest ?? {})) {
    if (Object.hasOwn(assets, file) && assets[file] !== entry?.digest) off.add(entry?.engine);
  }
  return [...ENGINES.filter((e) => off.delete(e)), ...[...off].filter(Boolean)];
}

/**
 * Reads Chronicle's list through the module's API client (with its key)
 * and compares it with the manifest. An older Chronicle answers 404: that
 * is no list, and its entry leaves the error log, as for other optional
 * routes. Any other failure is also no list; the check is advice only.
 * @param {{get: Function, dropLastErrorLogEntry?: Function}} api
 * @param {object} [manifest]
 * @returns {Promise<{reported: boolean, engines: string[]}>}
 */
export async function checkVendoredAssets(api, manifest = VENDOR_MANIFEST) {
  try {
    const assets = parseVendoredAssets(await api.get(VENDOR_ASSETS_PATH));
    return { reported: !!assets, engines: compareEngines(manifest, assets) };
  } catch (err) {
    if (err?.status === 404) api.dropLastErrorLogEntry?.({ status: 404, path: VENDOR_ASSETS_PATH });
    return { reported: false, engines: [] };
  }
}
