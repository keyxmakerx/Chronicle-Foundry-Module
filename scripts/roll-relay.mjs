/**
 * Chronicle Sync - shared rolls, the Foundry side. On the active GM's client
 * only (so there is one copy): a Chronicle roll arriving as WS `roll.made` is
 * posted to chat as a real Roll carrying Chronicle's dice, so Dice So Nice
 * animates it; and a roll made in Foundry chat is posted to Chronicle. The
 * rules are in _roll-relay.mjs.
 *
 * Loop guard: messages made here carry the roll flag and are created with
 * syncOptions(); the hook skips either, per message, so two rolls relayed at
 * once cannot clear each other's guard. Chronicle also answers a repeated originId
 * with `duplicate`, so a replay is harmless. Failures are logged, never shown
 * to players.
 */

import { log } from './logger.mjs';
import { FLAG_SCOPE, syncOptions } from './constants.mjs';
import { findLinked } from './_link-fence.mjs';
import {
  ROLL_MESSAGE_TYPE,
  SeenRolls,
  buildChatData,
  characterIdOf,
  hasRollMessage,
  heroSpeaker,
  isRouteMissing,
  judgeIncoming,
  postBodies,
} from './_roll-relay.mjs';
import { chronicleRollAppearance } from './dice-so-nice.mjs';
import { feedDiceMat } from './dice-mat.mjs';

/** True on the one client that should relay: the active GM. */
function _isActiveGM() {
  return !!game.user?.isGM && !!game.users?.activeGM?.isSelf;
}

/** SyncManager module for `roll.made` plus the chat hook for the other way. */
export const rollRelay = {
  _api: null,
  _syncManager: null,
  _hookId: null,
  _seen: new SeenRolls(),
  _routeMissing: false,

  init(api) {
    this._api = api;
    this._routeMissing = false;
    if (this._hookId === null) {
      this._hookId = Hooks.on('createChatMessage', (message, options, userId) => {
        if (options?.chronicleSync) return;
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
    if (!game.user?.isGM) return;
    // The mat takes the roll before chat's judgement: it has its own, and a
    // roll made in Foundry should show there too.
    this._feedMat(msg.payload);
    if (!_isActiveGM()) return;
    return this._postIncoming(msg.payload);
  },

  /** Show a public roll on the Dice mat and, from the active GM, relay it to players. */
  _feedMat(payload) {
    try {
      const rollerId = payload?.rollerId;
      const fid = rollerId ? this._syncManager?.getFoundryUserId?.(rollerId) ?? null : null;
      feedDiceMat(payload, { rollerFoundryId: fid && game.users.get(fid) ? fid : null, relay: _isActiveGM() });
    } catch (err) {
      log.warn('Could not show a Chronicle roll on the Dice mat', err);
    }
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
        speaker: this._heroSpeaker(payload),
        appearance: chronicleRollAppearance(),
      });
      // The Roll class rebuilds each term from its saved results, so nothing is rolled again.
      data.rolls = data.rolls.map((r) => Roll.fromData(r));
      data.sound = CONFIG.sounds?.dice;
      await ChatMessage.create(data, syncOptions());
    } catch (err) {
      log.warn('Could not show a Chronicle roll in chat', err);
    }
  },

  /**
   * A roll Chronicle made from a hero's sheet speaks as the actor linked to
   * that hero, through Foundry's own speaker (its token on the scene when it
   * has one). No linked actor, or any failure, leaves the roller's name.
   */
  _heroSpeaker(payload) {
    const id = characterIdOf(payload);
    if (!id) return null;
    try {
      const actor = findLinked(game.actors, id, FLAG_SCOPE);
      if (!actor) return null;
      return heroSpeaker(ChatMessage.getSpeaker({ actor }), actor);
    } catch (err) {
      log.warn('Could not find the hero for a Chronicle roll; it shows under the player\'s name', err);
      return null;
    }
  },

  /** A chat message was made somewhere in the world. */
  async _onChatMessage(message, userId) {
    if (!this._api || this._routeMissing) return;
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

