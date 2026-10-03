/**
 * Chronicle Sync - Stashes request card wiring
 *
 * The card's HTML is built in _stash-cards.mjs; this attaches its buttons when
 * Foundry renders the message. Foundry 13+ renders with
 * `renderChatMessageHTML` (a raw element); Foundry 12 uses `renderChatMessage`
 * (jQuery). Only one of the two is registered so a card never gets two sets
 * of listeners.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { StashSync, cardFlagOf, getStashSync } from './stash-sync.mjs';
import { modelFromFlag, trustedCardMoveId } from './_stash-cards.mjs';

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
  // Any player can create a message with card markup, so only a GM-authored
  // message is a request card, and its move id comes from its flag, never
  // from the markup. Anything else gets no working buttons.
  const moveId = trustedCardMoveId(message, cardFlagOf);
  if (!game.user.isGM || !moveId) {
    buttons.forEach((b) => b.remove());
    return;
  }
  // Tell the GM who answered it was them. The stored line names the answerer,
  // and every GM sees the same message.
  const answer = card.querySelector('.chronicle-stash-answer');
  if (answer && game.user.isGM) {
    const model = modelFromFlag(message.getFlag?.(FLAG_SCOPE, 'stashRequest'));
    if (model?.byId && model.byId === game.user.id) answer.textContent = StashSync.answeredLine(model, game.user.id);
  }
  buttons.forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const action = button.dataset.stashAction;
      if ((action !== 'approve' && action !== 'decline')) return;
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
