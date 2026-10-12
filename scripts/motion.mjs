/**
 * Applies the person's motion level to the page and plays the window
 * opening move on Chronicle's windows. The moves themselves are CSS
 * (styles/chronicle-sync.css, "MOTION"); this sets which ones play.
 */

import { MODULE_ID } from './constants.mjs';
import { growOrigin, motionLevel } from './_motion.mjs';

let lastPress = null;

/** Put the level where the CSS reads it. */
export function applyMotion(level) {
  document.documentElement.dataset.csMotion = motionLevel(level);
}

/** Wire the opening move; call once on init. */
export function registerMotion() {
  document.addEventListener('pointerdown', (e) => {
    lastPress = { x: e.clientX, y: e.clientY, at: Date.now() };
  }, { capture: true, passive: true });

  Hooks.on('renderApplicationV2', (app, element, _context, options) => {
    if (!options?.isFirstRender) return;
    const classes = app.options?.classes ?? [];
    if (!classes.some((c) => typeof c === 'string' && c.startsWith('chronicle-'))) return;
    const el = element instanceof HTMLElement ? element : app.element;
    if (!el) return;
    const origin = growOrigin(lastPress, el.getBoundingClientRect(), Date.now());
    if (origin) el.style.setProperty('--cs-origin', origin);
    el.classList.add('cs-grow');
    el.addEventListener('animationend', () => el.classList.remove('cs-grow'), { once: true });
  });

  applyMotion(game.settings.get(MODULE_ID, 'motion'));
}
