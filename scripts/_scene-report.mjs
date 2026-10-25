/**
 * What the GM's client tells Chronicle about the world's scenes, so the
 * owner (and the owner's AI) can see which maps already exist in Foundry.
 *
 * Only names, folder paths and two flags travel (POST /sync/scenes), never
 * pictures: most scenes are animated, and Chronicle only needs to know what
 * exists. Pure: no Foundry globals, no network, so it is testable under Node.
 */

/** Server limits on the body. */
export const MAX_SCENES = 2000;
export const MAX_SCENE_NAME_CHARS = 255;
export const MAX_FOLDER_CHARS = 255;

/** @param {unknown} text @param {number} max */
function cap(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A scene's folder path, outermost first ("Act 1 / Caves"); empty at the top.
 * @param {{name?: string, ancestors?: Array<{name?: string}>}|null|undefined} folder - Foundry Folder.
 * @returns {string}
 */
export function folderPath(folder) {
  if (!folder) return '';
  const outer = Array.isArray(folder.ancestors) ? [...folder.ancestors].reverse() : [];
  return [...outer, folder].map((f) => cap(f?.name, MAX_FOLDER_CHARS)).filter(Boolean).join(' / ');
}

/**
 * Build the POST /sync/scenes body: scenes by name, at most MAX_SCENES, with
 * `truncated` set when the world has more.
 *
 * @param {Array<{id: string, name?: string, folder?: string, active?: boolean, navigation?: boolean}>} scenes
 * @returns {{scenes: Array<{id: string, name: string, folder: string, active: boolean, navigation: boolean}>, truncated: boolean}}
 */
export function buildSceneReport(scenes) {
  const list = (Array.isArray(scenes) ? scenes : [])
    .filter((s) => s && s.id)
    .map((s) => ({
      id: String(s.id),
      name: cap(s.name, MAX_SCENE_NAME_CHARS),
      folder: cap(s.folder, MAX_FOLDER_CHARS),
      active: !!s.active,
      navigation: !!s.navigation,
    }))
    // A stable order, so an unchanged world sends an unchanged body.
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { scenes: list.slice(0, MAX_SCENES), truncated: list.length > MAX_SCENES };
}

/**
 * The Foundry hooks after which the scene list may have changed. Folder hooks
 * count because a scene's folder path is part of the report.
 */
export const SCENE_HOOKS = ['createScene', 'updateScene', 'deleteScene', 'createFolder', 'updateFolder', 'deleteFolder'];
