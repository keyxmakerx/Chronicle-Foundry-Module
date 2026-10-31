/**
 * Chronicle Sync - shared rolls, the Foundry side. On the active GM's client
 * only (so there is one copy): a Chronicle roll arriving as WS `roll.made` is
 * posted to chat as a real Roll carrying Chronicle's dice, so Dice So Nice
 * animates it; and a roll made in Foundry chat is posted to Chronicle. The
 * rules are in _roll-relay.mjs.
 *
 * Loop guard: messages made here carry the roll flag and are posted inside
 * `_syncing`; the hook skips both. Chronicle also answers a repeated originId
 * with `duplicate`, so a replay is harmless. Failures are logged, never shown
 * to players.
 */

import { log } from './logger.mjs';
import {
  ROLL_MESSAGE_TYPE,
  SeenRolls,
  buildChatData,
  hasRollMessage,
  isRouteMissing,
  judgeIncoming,
  postBodies,
} from './_roll-relay.mjs';

/** True on the one client that should relay: the active GM. */
function _isActiveGM() {
  return !!game.user?.isGM && !!game.users?.activeGM?.isSelf;
}

/** SyncManager module for `roll.made` plus the chat hook for the other way. */
export const rollRelay = {
  _api: null,
  _syncManager: null,
  _hookId: null,
  _syncing: false,
  _seen: new SeenRolls(),
  _routeMissing: false,

  init(api) {
    this._api = api;
    this._routeMissing = false;
    if (this._hookId === null) {
      this._hookId = Hooks.on('createChatMessage', (message, _options, userId) => {
        this._onChatMessage(message, userId);
      });
    }
  },

  destroy() {
    if (this._hookId !== null) Hooks.off('createChatMessage', this._hookId);
    this._hookId = null;
    this._api = null;
  },

  onMessage(msg) {
    if (msg?.type !== ROLL_MESSAGE_TYPE) return;
    if (!_isActiveGM()) return;
    return this._postIncoming(msg.payload);
  },

  /** Post a Chronicle roll to chat, once. */
  async _postIncoming(payload) {
    if (!judgeIncoming(payload).ok) return;
    if (!this._seen.add(payload.id) || hasRollMessage(game.messages, payload.id)) return;
    try {
      const gmIds = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
      const rollerFoundryId = payload.rollerId
        ? this._syncManager?.getFoundryUserId?.(payload.rollerId) ?? null
        : null;
      const data = buildChatData(payload, {
        gmIds,
        rollerFoundryId: rollerFoundryId && game.users.get(rollerFoundryId) ? rollerFoundryId : null,
        fallbackAlias: game.i18n.localize('CHRONICLE.Rolls.FallbackName'),
        authorId: game.user.id,
      });
      // The Roll class rebuilds each term from its saved results, so nothing is rolled again.
      data.rolls = data.rolls.map((r) => Roll.fromData(r));
      data.sound = CONFIG.sounds?.dice;
      this._syncing = true;
      try {
        await ChatMessage.create(data);
      } finally {
        this._syncing = false;
      }
    } catch (err) {
      log.warn('Could not show a Chronicle roll in chat', err);
    }
  },

  /** A chat message was made somewhere in the world. */
  async _onChatMessage(message, userId) {
    if (this._syncing || !this._api || this._routeMissing) return;
    if (!_isActiveGM() || this._api.state !== 'connected') return;
    if (!message?.rolls?.length) return;
    const author = game.users.get(userId);
    const bodies = postBodies(message, {
      isGM: (id) => !!game.users.get(id)?.isGM,
      foundryUserId: userId,
      userName: author?.name ?? '',
    });
    for (const body of bodies) {
      if (this._routeMissing) return;
      try {
        await this._api.post('/rolls', body);
      } catch (err) {
        if (isRouteMissing(err)) {
          this._routeMissing = true;
          this._api.dropLastErrorLogEntry?.({ status: 404, path: '/rolls' });
          log.info('This Chronicle has no shared rolls yet; Foundry rolls stay in Foundry.');
          return;
        }
        log.warn('Could not share a Foundry roll with Chronicle', err);
      }
    }
  },
};

