/**
 * Chronicle Sync - Stashes request card wiring
 *
 * The card's HTML is built in _stash-cards.mjs; this attaches its buttons when
 * Foundry renders the message. Foundry 13+ renders with
 * `renderChatMessageHTML` (a raw element); Foundry 12 uses `renderChatMessage`
 * (jQuery). Only one of the two is registered so a card never gets two sets
 * of listeners.
 */

import { getStashSync } from './stash-sync.mjs';

/**
 * Wire the buttons of a rendered request card.
 * @param {ChatMessage} message
 * @param {HTMLElement|jQuery} html
 */
function onRenderChatMessage(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.('.chronicle-stash-card');
  if (!card) return;

  const buttons = card.querySelectorAll('button[data-stash-action]');
  // A whisper reaches only GMs, but the buttons still refuse anyone else.
  if (!game.user.isGM) {
    buttons.forEach((b) => b.remove());
    return;
  }
  buttons.forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const action = button.dataset.stashAction;
      const moveId = button.dataset.moveId;
      if (!moveId || (action !== 'approve' && action !== 'decline')) return;
      // One press only: the card is rewritten when the answer lands.
      buttons.forEach((b) => { b.disabled = true; });
      const stash = getStashSync();
      if (!stash) {
        ui.notifications.warn(game.i18n.localize('CHRONICLE.Stashes.Error.GMNotReady'));
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      await stash.answer(moveId, action);
      buttons.forEach((b) => { b.disabled = false; });
    });
  });
}

/** Register the render hook for this Foundry version. */
export function registerStashChat() {
  const generation = game.release?.generation ?? 12;
  if (generation >= 13) Hooks.on('renderChatMessageHTML', onRenderChatMessage);
  else Hooks.on('renderChatMessage', onRenderChatMessage);
}
