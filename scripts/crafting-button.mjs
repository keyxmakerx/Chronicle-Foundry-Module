/**
 * Chronicle Sync - the "Crafting" button on a character sheet
 *
 * Opens the Satchel on the Crafting tab for that hero. It shows on synced
 * characters the user owns (any of them, for a GM) while Chronicle offers
 * crafting in this world.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { craftingAvailable } from './crafting-relay.mjs';
import { openSatchel } from './satchel.mjs';

const t = (key) => game.i18n.localize(`CHRONICLE.Crafting.${key}`);

/** Whether the current user gets the button on this actor. */
export function canOpenCrafting(actor) {
  if (!actor || !craftingAvailable() || !actor.getFlag(FLAG_SCOPE, 'entityId')) return false;
  return game.user.isGM || actor.testUserPermission(game.user, 'OWNER');
}

export function registerCraftingButton() {
  Hooks.on('renderActorSheet', onRenderActorSheet);
  Hooks.on('renderActorSheetV2', onRenderActorSheet);
}

function onRenderActorSheet(app, html) {
  const actor = app?.actor ?? app?.document;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector?.('.window-header');
  if (!actor || !header) return;

  header.querySelector('.chronicle-craft-button')?.remove();
  if (!canOpenCrafting(actor)) return;

  const v13 = (game.release?.generation ?? 12) >= 13;
  const button = document.createElement(v13 ? 'button' : 'a');
  button.className = v13
    ? 'header-control icon fa-solid fa-flask chronicle-craft-button'
    : 'header-button chronicle-craft-button';
  if (v13) button.type = 'button';
  button.title = t('ButtonTitle');
  button.setAttribute('aria-label', t('ButtonTitle'));
  if (!v13) {
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-flask';
    button.append(icon, ` ${t('Button')}`);
  }
  button.addEventListener('click', (event) => {
    event.preventDefault();
    openSatchel('crafting', { actor });
  });

  const close = header.querySelector('[data-action="close"], .close');
  if (close) close.before(button);
  else header.append(button);
}
