/**
 * Motion for Chronicle's windows: Full plays the moves, Calm turns each into
 * a fade, Off shows the end state. Each person picks their own; Calm is the
 * starting point when their computer asks for reduced motion.
 */

export const MOTION_LEVELS = ['full', 'calm', 'off'];

/**
 * @param {boolean} prefersReduced - the system's reduced-motion request
 * @returns {string} the level a person starts on
 */
export function defaultMotion(prefersReduced) {
  return prefersReduced ? 'calm' : 'full';
}

/** A saved level, or Full for anything unknown. */
export function motionLevel(saved) {
  return MOTION_LEVELS.includes(saved) ? saved : 'full';
}

/**
 * Where a new window should grow from: the point that opened it, as a
 * transform-origin inside the window, when the click was recent and is close
 * enough to read as "out of that button". Otherwise null (grow from centre).
 * @param {{x:number, y:number, at:number}|null} press - the last pointer press
 * @param {{left:number, top:number, width:number, height:number}} rect - the window
 * @param {number} now
 */
export function growOrigin(press, rect, now) {
  if (!press || now - press.at > 600 || !rect.width || !rect.height) return null;
  const clamp = (v, max) => Math.min(Math.max(v, 0), max);
  return `${Math.round(clamp(press.x - rect.left, rect.width))}px ${Math.round(clamp(press.y - rect.top, rect.height))}px`;
}
