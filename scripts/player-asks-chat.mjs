/**
 * Chronicle Sync - player-change card wiring
 *
 * The card's HTML is built in _player-asks.mjs; this attaches its buttons when
 * Foundry renders the message. Foundry 13+ renders with `renderChatMessageHTML`
 * (a raw element), 12 with `renderChatMessage` (jQuery); only one is registered
 * so a card never gets two sets of listeners.
 */

import { getPlayerAsks, askFlagOf } from './player-asks.mjs';
import { trustedCardKey } from './_player-asks.mjs';

function onRenderChatMessage(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.('.chronicle-ask-card');
  if (!card) return;
  const buttons = card.querySelectorAll('button[data-ask-action]');
  // Any player can post a message with card markup, so only a GM-authored
  // message is a card, and its key comes from the flag, never the markup.
  const key = trustedCardKey(message, askFlagOf);
  if (!game.user.isGM || !key) {
    buttons.forEach((b) => b.remove());
    return;
  }
  buttons.forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const action = button.dataset.askAction;
      if (action !== 'send' && action !== 'decline') return;
      buttons.forEach((b) => { b.disabled = true; });
      const asks = getPlayerAsks();
      if (!asks) {
        ui.notifications.warn(game.i18n.localize('CHRONICLE.PlayerAsk.NotReady'));
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      try {
        await asks.answer(key, action);
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
  });
}

/** Register the render hook for this Foundry version. */
export function registerPlayerAsksChat() {
  const generation = game.release?.generation ?? 12;
  if (generation >= 13) Hooks.on('renderChatMessageHTML', onRenderChatMessage);
  else Hooks.on('renderChatMessage', onRenderChatMessage);
}
