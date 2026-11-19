/**
 * Chronicle Sync - GM cards for a player's changes to things that are not theirs
 *
 * The model, text and trust rules are in `_player-asks.mjs`. This posts the
 * whispered card from the GM's client, and on Send re-reads the pages the
 * player's flag ids name before doing the same push the GM's own action
 * would: a new "Has Item" link, a removed link, or a page moved to Chronicle's
 * Trash.
 */

import { FLAG_SCOPE, APPLY_OPTION } from './constants.mjs';
import { HAS_ITEM, hasItemBody } from './_inventory-plan.mjs';
import {
  ASK, ASK_STATE, askFlag, cardHtml, collectCardKeys, confirmModel, findCardMessage,
  modelFromFlag, playersCanView, reviewAsk, settleModel,
} from './_player-asks.mjs';

const FLAG = 'playerAsk';

/** @type {PlayerAsks|null} */
let instance = null;

/** The running service, or null on a client without one. */
export function getPlayerAsks() {
  return instance;
}

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.PlayerAsk.${key}`, data)
  : game.i18n.localize(`CHRONICLE.PlayerAsk.${key}`));

/** The player-ask flag of a chat message. */
export function askFlagOf(message) {
  return message?.getFlag?.(FLAG_SCOPE, FLAG);
}

export class PlayerAsks {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;
    /** @type {Set<string>} Keys whose card is being posted right now. */
    this._posting = new Set();
    /** @type {Set<string>} Keys being answered right now. */
    this._answering = new Set();
    instance = this;
  }

  /** @param {import('./api-client.mjs').ChronicleAPI} api */
  async init(api) {
    this._api = api;
  }

  async onMessage() {}

  destroy() {
    if (instance === this) instance = null;
  }

  static labels() {
    return {
      ItemAdd: t('ItemAdd', { who: '{who}', name: '{name}', where: '{where}' }),
      ItemRemove: t('ItemRemove', { who: '{who}', name: '{name}', where: '{where}' }),
      JournalRemove: t('JournalRemove', { who: '{who}', name: '{name}', where: '{where}' }),
      ActorRemove: t('ActorRemove', { who: '{who}', name: '{name}', where: '{where}' }),
      RealPage: t('RealPage', { page: '{page}' }),
      RealCharacter: t('RealCharacter', { character: '{character}' }),
      Send: t('Send'),
      NotNow: t('NotNow'),
    };
  }

  /** The answered line for a settled model. */
  static answeredLine(model, viewerId = '') {
    const name = (viewerId && model.byId === viewerId) ? t('You') : (model.by || t('TheGM'));
    if (model.state === ASK_STATE.SENT) return t('SentBy', { name });
    if (model.state === ASK_STATE.DECLINED) return t('DeclinedBy', { name });
    if (model.state === ASK_STATE.REFUSED) return t(`Refused.${model.note || 'Other'}`);
    if (model.state === ASK_STATE.FAILED) return t('Failed');
    return '';
  }

  _messages() {
    return game.messages?.contents ?? [];
  }

  /**
   * Post the card for a change, once. A card already in chat, or being
   * posted, is left alone.
   * @param {object} model - from `askModel`.
   */
  async ask(model) {
    if (collectCardKeys(this._messages(), askFlagOf).includes(model.key) || this._posting.has(model.key)) return;
    this._posting.add(model.key);
    try {
      const gmIds = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
      await ChatMessage.create({
        content: cardHtml(model, PlayerAsks.labels(), ''),
        whisper: gmIds,
        speaker: { alias: 'Chronicle' },
        flags: { [FLAG_SCOPE]: { [FLAG]: askFlag(model) } },
      });
    } finally {
      this._posting.delete(model.key);
    }
  }

  async _rewrite(message, model) {
    await message.update({
      content: cardHtml(model, PlayerAsks.labels(), PlayerAsks.answeredLine(model, game.user.id)),
      flags: { [FLAG_SCOPE]: { [FLAG]: askFlag(model) } },
    });
  }

  /**
   * A GM pressed a button.
   * @param {string} key
   * @param {'send'|'decline'} action
   */
  async answer(key, action) {
    if (this._answering.has(key)) return;
    const message = findCardMessage(this._messages(), key, askFlagOf);
    const model = message && modelFromFlag(askFlagOf(message));
    if (!model) return;
    if (model.state !== ASK_STATE.PENDING && model.state !== ASK_STATE.CONFIRM) return;
    this._answering.add(key);
    try {
      const by = game.user.name || '';
      if (action === 'decline') {
        await this._rewrite(message, settleModel(model, ASK_STATE.DECLINED, by, game.user.id));
        return;
      }
      const result = await this._press(model);
      const next = result.state === ASK_STATE.CONFIRM
        ? confirmModel(model, result.reals)
        : settleModel({ ...model, reals: result.reals ?? model.reals }, result.state, by, game.user.id, result.note);
      await this._rewrite(message, next);
    } finally {
      this._answering.delete(key);
    }
  }

  /**
   * Read what the ids really name, then send or ask again.
   * @returns {Promise<{state: string, reals?: object, note?: string}>}
   * @private
   */
  async _press(model) {
    let facts;
    try {
      facts = await this._read(model);
    } catch (err) {
      console.warn('Chronicle: Could not check a player\'s change before sending it', err);
      return { state: ASK_STATE.FAILED };
    }
    if (facts.refused) return { state: ASK_STATE.REFUSED, note: facts.refused, reals: facts.reals };
    const review = reviewAsk(model, facts.reals);
    if (review.action === 'confirm') return { state: ASK_STATE.CONFIRM, reals: review.reals };
    try {
      await this._send(model, facts);
      return { state: ASK_STATE.SENT, reals: review.reals };
    } catch (err) {
      console.warn('Chronicle: Failed to send a player\'s change to Chronicle', err);
      return { state: ASK_STATE.FAILED };
    }
  }

  /**
   * Chronicle's own names for what the player's ids point at, and whether the
   * change may be sent at all.
   * @returns {Promise<{refused?: string, reals: object, relationId?: *}>}
   * @private
   */
  async _read(model) {
    const { link } = model;
    const entity = async (id) => this._api.get(`/entities/${id}`);
    if (model.kind === ASK.JOURNAL_REMOVE || model.kind === ASK.ACTOR_REMOVE) {
      if (!link.entityId) return { refused: 'Other', reals: {} };
      const page = await entity(link.entityId);
      return { reals: { page: page?.name ?? '' } };
    }
    if (!link.entityId) return { refused: 'Other', reals: {} };
    const character = await entity(link.entityId);
    const reals = { character: character?.name ?? '' };
    if (model.kind === ASK.ITEM_ADD) {
      if (!link.targetEntityId) return { refused: 'Other', reals };
      const [page, perms] = await Promise.all([
        entity(link.targetEntityId),
        this._api.get(`/entities/${link.targetEntityId}/permissions`).catch(() => null),
      ]);
      if (!playersCanView(page, perms)) return { refused: 'Hidden', reals };
      reals.page = page?.name ?? '';
      return { reals };
    }
    // ITEM_REMOVE: the link must be one of this character's.
    const relations = await this._api.get(`/entities/${link.entityId}/relations`);
    const list = Array.isArray(relations) ? relations : (relations?.data || []);
    const rel = list.find((r) => r?.relationType === HAS_ITEM && String(r?.id) === String(link.relationId));
    if (!rel) return { refused: 'Gone', reals };
    reals.page = rel.targetEntityName ?? '';
    return { reals, relationId: rel.id };
  }

  /** @private */
  async _send(model, facts) {
    const { link } = model;
    switch (model.kind) {
      case ASK.ITEM_ADD: {
        const relation = await this._api.post(`/entities/${link.entityId}/relations`, hasItemBody({
          targetEntityId: link.targetEntityId, quantity: link.quantity, equipped: link.equipped, name: model.name,
        }));
        const item = game.actors?.get?.(link.actorId)?.items?.get?.(link.itemId);
        if (relation && item) await item.update({ [`flags.${FLAG_SCOPE}.relationId`]: relation.id }, { [APPLY_OPTION]: true });
        break;
      }
      case ASK.ITEM_REMOVE:
        await this._api.delete(`/relations/${facts.relationId}`);
        break;
      default:
        // Chronicle moves a deleted page to its Trash.
        await this._api.delete(`/entities/${link.entityId}`);
    }
  }
}

/** The display name of a Foundry user, for the card. */
export function playerName(userId) {
  return game.users?.get?.(userId)?.name || String(userId ?? '');
}
