/**
 * The player copy of a shadowed map picture. Chronicle smudges the shadowed
 * areas into a separate picture and names it in the map row's
 * `player_image_url`. The module syncs with the owner's key, which still reads
 * the original, so the GM fetches the copy and stores it in Foundry; the page
 * every player can read then points only at that stored file. The original's
 * address must never reach the page or its flags while the map has a shadow.
 */

/** Folder under Foundry's `data` source holding the stored player copies. */
export const PLAYER_IMAGE_DIR = 'chronicle-sync/maps';

/**
 * Parse the sync API address of a player copy and check it belongs to this
 * campaign and map, so a tampered row can't make the GM's key fetch some
 * other route.
 * @param {*} url the map row's `player_image_url`
 * @param {string} campaignId
 * @param {string} mapId
 * @returns {{ path: string, version: string }|null} `path` is relative to the
 *   campaign (what `ChronicleAPI` takes); null when absent or malformed.
 */
export function parsePlayerImageUrl(url, campaignId, mapId) {
  if (typeof url !== 'string' || !url || !campaignId || !mapId) return null;
  const m = /^\/api\/v1\/campaigns\/([^/?#]+)\/maps\/([^/?#]+)\/player-image\?v=([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (!m || m[1] !== campaignId || m[2] !== mapId) return null;
  return { path: `/maps/${encodeURIComponent(mapId)}/player-image?v=${m[3]}`, version: m[3] };
}

/**
 * The file name a player copy is stored under. The version is part of it, so
 * a shadow edit writes a new file and no client shows a cached old one.
 * @param {string} mapId
 * @param {string} version
 * @returns {string|null} null when the id can't make a safe file name.
 */
export function playerImageFileName(mapId, version) {
  if (typeof mapId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(mapId)) return null;
  if (typeof version !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(version)) return null;
  return `${mapId}-${version}.jpg`;
}

/**
 * A stable signature of a map's shadow areas, to notice when they change
 * (the player copy then has a new version to fetch).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}[]} areas
 * @returns {string}
 */
export function shadowSignature(areas) {
  return (areas || [])
    .map((a) => [a.minX, a.minY, a.maxX, a.maxY].join(','))
    .sort()
    .join(';');
}
