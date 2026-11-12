/**
 * One-pixel blank pictures, one per format sync copies.
 *
 * Foundry gives modules no way to delete a file, but uploading to the same
 * name replaces it. A copied picture that must stop being reachable (a map
 * the GM has since shadowed) is overwritten with one of these, in the same
 * format as its name, so the server accepts it and the address shows nothing.
 */

const BLANKS = {
  png: ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg=='],
  jpg: ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AR//Z'],
  gif: ['image/gif', 'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAgEAAEEBAA7'],
  webp: ['image/webp', 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='],
  avif: ['image/avif', 'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAGGbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAHCAAAAIwACAAAAAQAAAa4AAAAUAAAAQmlpbmYAAAAAAAIAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAABppbmZlAgAAAAACAABhdjAxQWxwaGEAAAAAGmlyZWYAAAAAAAAADmF1eGwAAgABAAEAAADDaXBycAAAAJ1pcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAAA5waXhpAAAAAAEIAAAADGF2MUOBABwAAAAAOGF1eEMAAAAAdXJuOm1wZWc6bXBlZ0I6Y2ljcDpzeXN0ZW1zOmF1eGlsaWFyeTphbHBoYQAAAAAeaXBtYQAAAAAAAAACAAEEAQKDBAACBAEFhgcAAAA/bWRhdBIACgQYAAYVMgoUAAwxAAF1VEgIEgAKCBgABogIaDQgMhUUx4eGZQIIIJ5QAAAASFrZXNYwF2A='],
};

/**
 * The blank picture for a file extension, or null for one sync never copies.
 * @param {string} ext extension without the dot
 * @returns {{mime: string, bytes: Uint8Array}|null}
 */
export function blankPicture(ext) {
  const hit = BLANKS[String(ext || '').toLowerCase()];
  if (!hit) return null;
  const bin = globalThis.atob(hit[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: hit[0], bytes };
}
