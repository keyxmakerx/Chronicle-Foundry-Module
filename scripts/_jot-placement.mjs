/**
 * Chronicle Sync - where the jot tab and jot panel sit on screen
 *
 * Both can be dragged anywhere. Pure helpers, so the clamping and the saved
 * shape are unit-tested off-DOM (tools/test-jot-placement.mjs).
 */

/** Pixels a press must travel before it counts as a drag, not a click. */
export const DRAG_THRESHOLD = 4;

/** Whether a pointer that moved (dx, dy) since the press is dragging. */
export function pastThreshold(dx, dy) {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

function point(p) {
  if (!p || typeof p !== 'object') return null;
  const left = Number(p.left);
  const top = Number(p.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Read the saved placement. Anything unreadable means "not moved yet", so
 * a bad value only puts things back in their corner.
 * @param {string} raw - the client setting's JSON
 * @returns {{tab: {left:number, top:number}|null, panel: {left:number, top:number}|null}}
 */
export function parsePlacement(raw) {
  let v = null;
  try { v = JSON.parse(raw || '{}'); } catch { v = null; }
  return { tab: point(v?.tab), panel: point(v?.panel) };
}

/** The placement with one part replaced, as the setting's JSON. */
export function withPlacement(raw, part, pos) {
  const cur = parsePlacement(raw);
  cur[part] = point(pos);
  return JSON.stringify(cur);
}

/**
 * Keep a box fully on screen, so a window resize or a smaller screen never
 * leaves the tab or the panel's handle out of reach.
 */
export function clampBox(pos, size, viewport) {
  const maxLeft = Math.max(0, viewport.width - size.width);
  const maxTop = Math.max(0, viewport.height - size.height);
  return {
    left: Math.round(Math.min(Math.max(0, pos.left), maxLeft)),
    top: Math.round(Math.min(Math.max(0, pos.top), maxTop)),
  };
}

/**
 * Where the panel opens when it hasn't been moved: just above the tab,
 * right edges lined up, or below it when the tab sits near the top.
 */
export function panelBesideTab(tab, size, viewport, gap = 4) {
  const above = tab.top - gap - size.height;
  const top = above >= 0 ? above : tab.top + tab.height + gap;
  return clampBox({ left: tab.left + tab.width - size.width, top }, size, viewport);
}
