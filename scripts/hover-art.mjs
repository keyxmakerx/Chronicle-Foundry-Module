/**
 * Chronicle Sync - token art on hover
 *
 * Rest the cursor on a token and its actor's full picture appears beside the
 * cursor, following it until the cursor leaves the token. The GM gets a token
 * HUD button to switch it off for that token, and a world setting for all of
 * them; each person has their own setting and an unbound shortcut to hide
 * previews. Rules live in _hover-art.mjs.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { HOVER_ART_FLAG, HOVER_DELAY_MS, hoverArtFor, previewPlace, tokenArt } from './_hover-art.mjs';

const state = { el: null, img: null, timer: null, token: null, x: 0, y: 0 };

/** Settings; call on init. */
export function registerHoverArtSettings() {
  game.settings.register(MODULE_ID, 'hoverArtWorld', {
    name: 'CHRONICLE.HoverArt.World.Name',
    hint: 'CHRONICLE.HoverArt.World.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => hidePreview(),
  });
  game.settings.register(MODULE_ID, 'hoverArt', {
    name: 'CHRONICLE.HoverArt.Client.Name',
    hint: 'CHRONICLE.HoverArt.Client.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => hidePreview(),
  });
}

/** Flip this person's own switch (the shortcut). */
export async function toggleHoverArt() {
  const on = !game.settings.get(MODULE_ID, 'hoverArt');
  await game.settings.set(MODULE_ID, 'hoverArt', on);
  ui.notifications?.info(game.i18n.localize(on ? 'CHRONICLE.HoverArt.TurnedOn' : 'CHRONICLE.HoverArt.TurnedOff'));
}

/** Hooks; call on ready. */
export function registerHoverArt() {
  Hooks.on('hoverToken', _onHover);
  Hooks.on('renderTokenHUD', _onRenderHud);
  Hooks.on('canvasTearDown', hidePreview);
  Hooks.on('deleteToken', (doc) => { if (state.token?.document === doc) hidePreview(); });
  Hooks.on('updateToken', (doc) => { if (state.token?.document === doc) hidePreview(); });
  window.addEventListener('pointermove', _onMove, { passive: true });
  // A press starts a drag, a pan or a click: the preview would be in the way.
  window.addEventListener('pointerdown', hidePreview, { capture: true, passive: true });
  window.addEventListener('blur', hidePreview);
}

function _artFor(token) {
  const doc = token?.document;
  if (!doc) return '';
  return hoverArtFor({
    actorImg: token.actor?.img,
    tokenSrc: doc.texture?.src,
    flag: doc.getFlag(FLAG_SCOPE, HOVER_ART_FLAG),
    disposition: doc.disposition,
    hidden: doc.hidden,
    isGM: game.user.isGM,
    worldOn: game.settings.get(MODULE_ID, 'hoverArtWorld'),
    clientOn: game.settings.get(MODULE_ID, 'hoverArt'),
  });
}

function _onHover(token, hovered) {
  try {
    if (!hovered) {
      if (state.token === token) hidePreview();
      return;
    }
    hidePreview();
    const src = _artFor(token);
    if (!src) return;
    state.token = token;
    state.timer = setTimeout(() => _show(src, token.name), HOVER_DELAY_MS);
  } catch (err) {
    console.warn('Chronicle Sync | Token art preview unavailable', err);
    hidePreview();
  }
}

function _show(src, name) {
  state.timer = null;
  if (!state.el) {
    const el = document.createElement('div');
    el.className = 'chronicle-hover-art';
    el.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    // A picture that fails to load just doesn't show.
    img.addEventListener('error', hidePreview);
    img.addEventListener('load', () => { if (state.el) _place(); });
    el.appendChild(img);
    document.body.appendChild(el);
    state.el = el;
    state.img = img;
  }
  state.img.title = name ?? '';
  state.img.src = src;
  state.el.hidden = false;
  state.el.classList.remove('cs-peek');
  void state.el.offsetWidth;
  state.el.classList.add('cs-peek');
  _place();
}

function _place() {
  const el = state.el;
  if (!el || el.hidden) return;
  const r = el.getBoundingClientRect();
  const { left, top } = previewPlace(
    { x: state.x, y: state.y },
    { width: r.width, height: r.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function _onMove(e) {
  state.x = e.clientX;
  state.y = e.clientY;
  if (state.el && !state.el.hidden) _place();
}

/** Take the preview away, and forget a pending one. */
export function hidePreview() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.token = null;
  if (state.el) state.el.hidden = true;
}

/** GM: a HUD button switching this token's preview off and on. */
function _onRenderHud(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector('.col.right');
  const token = hud?.object;
  if (!col || !token) return;
  col.querySelectorAll('.chronicle-hover-art-hud').forEach((el) => el.remove());
  // Only tokens with art to show get the button.
  if (!tokenArt({ actorImg: token.actor?.img, tokenSrc: token.document.texture?.src })) return;
  const on = token.document.getFlag(FLAG_SCOPE, HOVER_ART_FLAG) !== false;
  const tag = col.querySelector('.control-icon')?.tagName === 'BUTTON' ? 'button' : 'div';
  const el = document.createElement(tag);
  if (tag === 'button') el.type = 'button';
  el.className = `control-icon chronicle-hover-art-hud${on ? ' active' : ''}`;
  const label = game.i18n.localize(on ? 'CHRONICLE.HoverArt.HudOn' : 'CHRONICLE.HoverArt.HudOff');
  el.dataset.tooltip = label;
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-pressed', String(on));
  el.innerHTML = '<i class="fa-solid fa-image-portrait"></i>';
  el.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      if (on) await token.document.setFlag(FLAG_SCOPE, HOVER_ART_FLAG, false);
      else await token.document.unsetFlag(FLAG_SCOPE, HOVER_ART_FLAG);
      hud.render?.();
    } catch (err) {
      console.warn('Chronicle Sync | Token art switch failed', err);
      ui.notifications?.warn(game.i18n.localize('CHRONICLE.HoverArt.SwitchFailed'));
    }
  });
  col.appendChild(el);
}
