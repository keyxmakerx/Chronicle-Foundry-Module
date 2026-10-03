/**
 * Chronicle Sync - Stashes (GM side)
 *
 * Runs only where the API key lives, the GM client. It:
 *  - probes once whether Chronicle offers Stashes and shares the verdict with
 *    players through a world setting;
 *  - answers players' Stashes windows over the module socket, calling
 *    Chronicle as the player (see _stash-relay.mjs for the rules);
 *  - posts a whispered request card to the GMs for each pending request, and
 *    updates it in place when the request is answered;
 *  - re-pulls the linked actors a move touched through the existing actor and
 *    item sync paths.
 *
 * Only the active GM answers, posts and refreshes, so two GMs never double up.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { getSetting, getUserMappings, setSetting } from './settings.mjs';
import {
  buildMovePayload,
  isFeatureMissing,
  touchedCharacterIds,
  unwrapRequests,
} from './_stash-model.mjs';
import { probeVerdict, shouldStoreVerdict } from './_stash-probe.mjs';
import {
  STASH_MSG,
  isAnsweringGM,
  planDirect,
  planRelay,
  relayErrorFrom,
} from './_stash-relay.mjs';
import { encryptReply, isPublicJwk } from './_stash-crypto.mjs';
import { removalFromMove } from './_stash-reconcile.mjs';
import {
  CARD_STATE,
  collectCardMoveIds,
  findCardMessage,
  cardFlag,
  cardHtml,
  cardsToPost,
  modelFromFlag,
  requestCardModel,
  settleCardModel,
} from './_stash-cards.mjs';

export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

/** Coalesces refreshes of the same actor requested in a burst. */
const REFRESH_DEBOUNCE_MS = 400;

/** @type {StashSync|null} */
let instance = null;

/** The running GM-side Stashes service, or null on a client without one. */
export function getStashSync() {
  return instance;
}

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.Stashes.${key}`, data)
  : game.i18n.localize(`CHRONICLE.Stashes.${key}`));

/** The stash-request flag of a chat message. */
export function cardFlagOf(message) {
  return message?.getFlag?.(FLAG_SCOPE, 'stashRequest');
}

export class StashSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;
    /** @type {true|false|null} Definitive probe result, null until known. */
    this._verdict = null;
    /** @type {Set<string>} Move ids whose card is being posted right now. */
    this._posting = new Set();
    /** @type {Promise<void>} Serializes card syncs so they never overlap. */
    this._cardChain = Promise.resolve();
    /** @type {Set<string>} Entity ids waiting for a coalesced refresh. */
    this._refreshQueue = new Set();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._refreshTimer = null;
    /** @type {Map<string, Set<string>>} Items to remove per character at the next refresh. */
    this._removals = new Map();
    instance = this;
  }

  // --- Sync module hooks -------------------------------------------------

  /** @param {import('./api-client.mjs').ChronicleAPI} api */
  async init(api) {
    this._api = api;
  }

  /** Probe, then make sure every pending request has a card. */
  async onInitialSync() {
    if (!this._api) return;
    await this.probe();
    if (this._verdict === true) await this.syncCards();
  }

  /**
   * Live events carry ids only (names would leak hidden characters), so a
   * listener fetches what it needs through the API.
   * @param {object} msg - a WebSocket message.
   */
  async onMessage(msg) {
    const type = msg?.type;
    if (typeof type !== 'string' || this._verdict !== true) return;
    if (type !== 'downtime.changed' && !type.startsWith('stash.')) return;
    if (!this._isActive()) return;
    const payload = msg.payload ?? {};

    switch (type) {
      case 'stash.requested':
        this._tellWindows({ ids: [] });
        await this.syncCards();
        break;
      case 'stash.settled':
        await this._onSettled(payload);
        this._tellWindows({ ids: [] });
        break;
      case 'stash.moved':
      case 'stash.money_changed': {
        const ids = touchedCharacterIds(payload);
        this.refreshCharacters(ids);
        this._tellWindows({ ids });
        break;
      }
      case 'downtime.changed':
        this._broadcast({ type: STASH_MSG.DOWNTIME, open: payload.open === true });
        Hooks.callAll('chronicleStashChanged', { kind: 'downtime', open: payload.open === true });
        break;
    }
  }

  destroy() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (instance === this) instance = null;
  }

  // --- Availability ------------------------------------------------------

  /** Whether this client may do GM-side work right now. */
  _isActive() {
    return isAnsweringGM(game.user, game.users?.activeGM);
  }

  /**
   * Ask Chronicle once whether Stashes exists here. A 404 (older Chronicle, or
   * the Armory addon off) is a quiet "no"; any other failure leaves the
   * answer unknown so a blip cannot switch the feature off.
   * @returns {Promise<true|false|null>}
   */
  async probe() {
    if (this._verdict !== null || !this._api) return this._verdict;
    let attempt = {};
    try {
      await this._api.get('/stashes/downtime');
    } catch (err) {
      attempt = { error: err };
      if (isFeatureMissing(err)) {
        // Expected on a Chronicle without stashes: keep it out of the error log.
        this._api.dropLastErrorLogEntry?.({ path: '/stashes/downtime', status: 404 });
      }
    }
    const verdict = probeVerdict(attempt);
    if (verdict === null) return null;
    this._verdict = verdict;
    if (this._isActive() && shouldStoreVerdict(getSetting('stashesAvailable'), verdict)) {
      try {
        await setSetting('stashesAvailable', verdict);
      } catch (err) {
        console.warn('Chronicle: could not share Stashes availability', err);
      }
    }
    return verdict;
  }

  /** Whether Stashes can be used from the GM client. */
  isAvailable() {
    return this._verdict === true;
  }

  // --- API calls ---------------------------------------------------------

  /**
   * Run a planned call against Chronicle.
   * @param {{method: string, path: string, body?: object}} call
   * @returns {Promise<any>}
   */
  async execute(call) {
    if (!this._api) throw Object.assign(new Error('not ready'), { status: 0 });
    return call.method === 'POST' ? this._api.post(call.path, call.body ?? {}) : this._api.get(call.path);
  }

  // --- Socket relay ------------------------------------------------------

  /**
   * Answer one player's request.
   * @param {object} msg - the socket message.
   * @param {string} senderId - Foundry user id supplied by the socket layer.
   */
  async handleRequest(msg, senderId) {
    if (!this._isActive() || typeof msg?.requestId !== 'string') return;
    // No usable key to encrypt the answer to: nothing is sent.
    if (!isPublicJwk(msg.publicKey)) return;
    const reply = (body) => this._reply(senderId, msg.requestId, msg.publicKey, body);

    if (!this._api || this._verdict !== true) {
      return reply({ ok: false, error: { code: 'gm_not_ready', message: t('Error.GMNotReady') } });
    }
    // The sender is whatever the socket layer says; nothing in the payload
    // can name another member.
    const plan = planRelay(msg, {
      senderId,
      mappings: getUserMappings(),
      senderOwns: (entityId) => this._userOwns(senderId, entityId),
      buildMove: buildMovePayload,
    });
    if (!plan.ok) return reply({ ok: false, error: plan.error });
    try {
      const data = await this.execute(plan.call);
      if (msg.action === 'move') this._afterMove(data);
      reply({ ok: true, data });
    } catch (err) {
      reply({ ok: false, error: relayErrorFrom(err) });
    }
  }

  /**
   * Run a request from the GM's own window. It acts as the key holder, so no
   * relay checks apply.
   * @returns {Promise<{ok: boolean, data?: any, error?: object}>}
   */
  async runDirect(msg) {
    if (!this._api || this._verdict !== true) {
      return { ok: false, error: { code: 'gm_not_ready', message: t('Error.GMNotReady') } };
    }
    const plan = planDirect(msg, { buildMove: buildMovePayload });
    if (!plan.ok) return { ok: false, error: plan.error };
    try {
      const data = await this.execute(plan.call);
      if (msg.action === 'move') this._afterMove(data);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: relayErrorFrom(err) };
    }
  }

  /**
   * Does this Foundry user own the actor linked to a Chronicle character?
   * @param {string} foundryUserId
   * @param {string} entityId
   * @returns {boolean}
   */
  _userOwns(foundryUserId, entityId) {
    const user = game.users.get(foundryUserId);
    const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId);
    if (!user || !actor) return false;
    return actor.testUserPermission(user, 'OWNER');
  }

  /**
   * Send a reply to one user. The module channel may reach every client, so
   * the body is encrypted to the key the asking window sent; `recipients` is
   * passed only as a best-effort narrowing, never relied on.
   */
  async _reply(userId, requestId, publicKey, body) {
    try {
      const envelope = await encryptReply(publicKey, body);
      game.socket.emit(SOCKET_CHANNEL, { type: STASH_MSG.REPLY, requestId, toUserId: userId, envelope }, { recipients: [userId] });
    } catch (err) {
      console.warn('Chronicle: could not encrypt a stash reply', err?.message);
    }
  }

  /** Send a non-secret notice (ids, the downtime switch) to every client. */
  _broadcast(body) {
    game.socket.emit(SOCKET_CHANNEL, body);
  }

  /**
   * Tell open windows to reload. Players' clients get a bare hint with no
   * ids (a hidden character's id must not reach them); this GM client's own
   * windows get the ids so they can skip unrelated reloads.
   */
  _tellWindows({ ids }) {
    this._broadcast({ type: STASH_MSG.REFRESH });
    Hooks.callAll('chronicleStashChanged', { kind: 'refresh', characterIds: ids });
  }

  /** After a move answer: re-pull the characters it touched. */
  _afterMove(result) {
    const move = result?.move;
    if (!move || result.status !== 'applied') return;
    const ids = [move.from, move.to]
      .filter((e) => e?.kind === 'character' && e.id)
      .map((e) => String(e.id));
    this.refreshCharacters(ids, removalFromMove(result));
  }

  // --- Chat cards --------------------------------------------------------

  /**
   * Post a card for every pending request that has none. Safe to call often
   * (startup, reconnect, each `stash.requested`): calls are serialized and a
   * move id already carded or being posted is skipped.
   * @returns {Promise<void>}
   */
  syncCards() {
    this._cardChain = this._cardChain.then(() => this._syncCards()).catch((err) => {
      console.warn('Chronicle: stash request cards failed', err);
    });
    return this._cardChain;
  }

  async _syncCards() {
    if (!this._isActive() || this._verdict !== true) return;
    let requests;
    try {
      requests = unwrapRequests(await this._api.get('/stashes/requests'));
    } catch (err) {
      // 403 means the key holder cannot approve; nothing to card then.
      console.debug('Chronicle: could not read stash requests', err?.status);
      return;
    }
    const todo = cardsToPost(requests, this._cardMoveIds(), this._posting);
    for (const line of todo) {
      const id = String(line.id);
      this._posting.add(id);
      try {
        await this._postCard(requestCardModel(line));
      } finally {
        this._posting.delete(id);
      }
    }
  }

  /** Move ids that already have a card in chat. */
  _cardMoveIds() {
    return collectCardMoveIds(game.messages?.contents ?? [], cardFlagOf);
  }

  _findCard(moveId) {
    return findCardMessage(game.messages?.contents ?? [], moveId, cardFlagOf);
  }

  /** The card's localized strings. */
  static cardLabels() {
    return {
      Title: t('Card.Title'), Who: t('Card.Who'), What: t('Card.What'), Where: t('Card.Where'),
      Money: t('Card.Money'), Approve: t('Card.Approve'), Decline: t('Card.Decline'),
    };
  }

  /** The "Approved by X" line for a model. */
  static answeredLine(model) {
    const name = model.by || t('Card.TheGM');
    if (model.state === CARD_STATE.APPROVED) return t('Card.ApprovedBy', { name });
    if (model.state === CARD_STATE.DECLINED) return t('Card.DeclinedBy', { name });
    if (model.state === CARD_STATE.FAILED) return t('Card.Failed');
    return '';
  }

  /**
   * Whispered to GM users only, never public: a request names hidden stashes
   * and characters.
   */
  async _postCard(model) {
    const gmIds = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
    await ChatMessage.create({
      content: cardHtml(model, StashSync.cardLabels(), StashSync.answeredLine(model)),
      whisper: gmIds,
      speaker: { alias: 'Chronicle' },
      flags: { [FLAG_SCOPE]: { stashRequest: cardFlag(model) } },
    });
  }

  /** Rewrite a card to its answered state. No card, or already answered: no-op. */
  async _settleCard(moveId, status, by) {
    const message = this._findCard(moveId);
    if (!message) return;
    const model = modelFromFlag(message.getFlag(FLAG_SCOPE, 'stashRequest'));
    if (!model) return;
    const next = settleCardModel(model, status, by);
    if (next === model) return;
    await message.update({
      content: cardHtml(next, StashSync.cardLabels(), StashSync.answeredLine(next)),
      flags: { [FLAG_SCOPE]: { stashRequest: cardFlag(next) } },
    });
  }

  /** `stash.settled`: someone answered, here or on the website. */
  async _onSettled(payload) {
    if (payload?.moveId === undefined) return;
    await this._settleCard(payload.moveId, payload.status, this._nameFor(payload.decidedBy));
  }

  /**
   * Display name for a Chronicle user id: campaign member, else the mapped
   * Foundry user, else empty (the card then says "the GM").
   */
  _nameFor(chronicleUserId) {
    if (!chronicleUserId) return '';
    const members = this._syncManager?.getMembers?.() ?? [];
    const member = members.find((m) => String(m.user_id ?? m.id ?? '') === String(chronicleUserId));
    if (member?.display_name) return member.display_name;
    const fid = getUserMappings()[chronicleUserId];
    return (fid && game.users.get(fid)?.name) || '';
  }

  /**
   * Approve or turn down a request from its card button. GM only; the server
   * checks again.
   * @param {string} moveId
   * @param {'approve'|'decline'} action
   */
  async answer(moveId, action) {
    if (!game.user.isGM || (action !== 'approve' && action !== 'decline')) return;
    try {
      const result = await this.execute({
        method: 'POST',
        path: `/stashes/requests/${encodeURIComponent(moveId)}/${action}`,
        body: {},
      });
      await this._settleCard(moveId, result?.status ?? result?.move?.status, game.user.name);
      this._afterMove(result);
    } catch (err) {
      ui.notifications.warn(t('Card.AnswerFailed'));
      console.warn('Chronicle: answering a stash request failed', err?.status);
      // Another answer may have landed first; bring the card in line.
      this.syncCards();
    }
  }

  // --- Refresh -----------------------------------------------------------

  /**
   * Re-pull linked actors from Chronicle through the existing actor and item
   * sync paths, coalescing a burst for the same character into one pass.
   * @param {string[]} entityIds
   * @param {{characterId: string, itemId: string}|null} [removal] - an item a
   *   just-applied move took from a character; the only thing a refresh may
   *   delete.
   */
  refreshCharacters(entityIds, removal = null) {
    if (!this._isActive()) return;
    for (const id of entityIds ?? []) if (id) this._refreshQueue.add(String(id));
    if (removal) {
      const set = this._removals.get(removal.characterId) ?? new Set();
      set.add(removal.itemId);
      this._removals.set(removal.characterId, set);
    }
    if (this._refreshTimer || this._refreshQueue.size === 0) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      const ids = [...this._refreshQueue];
      this._refreshQueue.clear();
      const removals = this._removals;
      this._removals = new Map();
      this._refreshNow(ids, removals).catch((err) => console.warn('Chronicle: stash refresh failed', err));
    }, REFRESH_DEBOUNCE_MS);
  }

  async _refreshNow(entityIds, removals = new Map()) {
    const mods = this._syncManager?._modules ?? [];
    const actorSync = mods.find((m) => typeof m.refreshFromChronicle === 'function');
    const itemSync = mods.find((m) => typeof m.refreshInventory === 'function');
    for (const entityId of entityIds) {
      const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId);
      if (!actor) continue;
      try {
        await actorSync?.refreshFromChronicle(entityId);
        await itemSync?.refreshInventory(actor, { removeItemIds: [...(removals.get(entityId) ?? [])] });
      } catch (err) {
        console.warn(`Chronicle: could not refresh "${actor.name}" after a stash move`, err);
      }
    }
  }
}
