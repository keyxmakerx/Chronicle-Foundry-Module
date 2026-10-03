/**
 * Looping map decoration (the Arcane frame's breathing runes) rests when
 * the person steps away: after 30 seconds without input, or while the tab
 * is hidden, the element gets `cs-motion-rest`, and the first input or the
 * tab showing again takes it off. Same rule as Chronicle's MotionRest.
 */

export const MOTION_IDLE_MS = 30_000;
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'];

/**
 * Start resting `el` when idle. Returns a stop function that removes every
 * listener and timer.
 * @param {Element} el
 * @param {{ doc?: Document, idleMs?: number, setTimer?: Function, clearTimer?: Function }} [opts]
 * @returns {() => void}
 */
export function startMotionRest(el, opts = {}) {
  const doc = opts.doc || globalThis.document;
  const idleMs = opts.idleMs ?? MOTION_IDLE_MS;
  const setTimer = opts.setTimer || globalThis.setTimeout;
  const clearTimer = opts.clearTimer || globalThis.clearTimeout;
  if (!el || !doc) return () => {};

  let timer = null;
  const rest = () => el.classList.add('cs-motion-rest');
  const wake = () => {
    el.classList.remove('cs-motion-rest');
    if (timer) clearTimer(timer);
    timer = setTimer(rest, idleMs);
  };
  const onVisibility = () => (doc.hidden ? rest() : wake());

  for (const ev of ACTIVITY_EVENTS) doc.addEventListener(ev, wake, { passive: true });
  doc.addEventListener('visibilitychange', onVisibility);
  if (doc.hidden) rest(); else wake();

  return () => {
    if (timer) clearTimer(timer);
    for (const ev of ACTIVITY_EVENTS) doc.removeEventListener(ev, wake);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
