/**
 * Chronicle Sync - Crafting (every client)
 *
 * Where the Crafting tab's calls are answered. On the GM's client a call
 * goes to Chronicle directly, as the GM; on a player's client it goes to the
 * active GM over the module socket, and the GM's client calls Chronicle as
 * that player's own member (_craft-relay.mjs holds who may ask what).
 * Answers show a hero's pack, so they come back encrypted to the asking
 * client alone.
 *
 * The GM side is also a sync module: it asks Chronicle once whether this
 * campaign has crafting, shares the answer with players, whispers each take,
 * harvest, study and finished project to the GMs, and has the actor re-read
 * when a hero's pack changed.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { getSetting, getUserMappings, setSetting } from './settings.mjs';
import { SOCKET_CHANNEL, getStashSync } from './stash-sync.mjs';
import { PendingRequests, chronicleUserFor, isAnsweringGM } from './_stash-relay.mjs';
import { decryptReply, encryptReply, generateRequestKeys } from './_stash-crypto.mjs';
import { shouldStoreVerdict } from './_stash-probe.mjs';
import {
  CRAFT_MESSAGE, changesPack, craftingProbeVerdict, describeCraft, planCraftCall, sanitizeCraftReply, sanitizeCraftRequest,
} from './_craft-relay.mjs';

const t = (key) => game.i18n.localize(`CHRONICLE.Crafting.${key}`);

// A roll or a harvest waits on Chronicle's dice and the Armory.
const pending = new PendingRequests({ timeoutMs: 15000 });

/** Player side: each waiting request's private key and action, by request id. */
const keys = new Map();

/** @type {CraftingSync|null} */
let instance = null;

/** Whether Chronicle offers crafting in this world (shared by the GM client). */
export function craftingAvailable() {
  try {
    return getSetting('craftingAvailable') === true;
  } catch {
    return false;
  }
}

/**
 * Make one of the Crafting tab's calls. `req` is `{action, characterId,
 * projectId?, lineId?, body?}`; the answer is `{status, body}` as the
 * block's own fetch would see it.
 */
export async function craftRequest(req) {
  if (game.user.isGM) {
    if (!instance?._api) return { status: 503, body: { message: t('GMNotReady') } };
    return instance.run(req, null, game.user);
  }
  if (!game.users.activeGM) return { status: 503, body: { message: t('NoGM') } };
  let pair;
  try {
    pair = await generateRequestKeys();
  } catch {
    return { status: 502, body: { message: t('Failed') } };
  }
  const { id, promise } = pending.create();
  keys.set(id, { key: pair.privateKey, action: req.action });
  promise.then(() => keys.delete(id));
  // No user id goes in the payload: the GM's client takes the sender from
  // the socket layer.
  game.socket.emit(SOCKET_CHANNEL, { type: CRAFT_MESSAGE, requestId: id, publicKey: pair.publicJwk, ...req });
  const reply = await promise;
  if (reply?.error) {
    // A take or a roll may still have gone through after the wait ended.
    const key = reply.error.code === 'timeout' ? (req.action === 'view' ? 'NoAnswer' : 'NoAnswerWrite') : 'Failed';
    return { status: 504, body: { message: t(key) } };
  }
  return reply;
}

/**
 * Listen on the module socket. Called once at ready on every client. The
 * second argument Foundry gives a listener is the sender's user id.
 */
export function registerCraftingSocket() {
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (data?.type !== CRAFT_MESSAGE) return;
    if (data.action === 'reply') {
      // Answers count only from a GM, and only the asking client can open one.
      if (game.users.get(senderId)?.isGM === true && data.toUserId === game.user.id) onReply(data);
      return;
    }
    if (isAnsweringGM(game.user, game.users.activeGM)) instance?.handleRequest(data, senderId);
  });
}

async function onReply(data) {
  const waiting = typeof data.requestId === 'string' ? keys.get(data.requestId) : null;
  if (!waiting) return;
  let reply = null;
  try {
    reply = sanitizeCraftReply(await decryptReply(waiting.key, data.envelope), waiting.action);
  } catch (err) {
    console.warn('Chronicle: could not read the GM\'s crafting answer', err?.message);
  }
  pending.settle(data.requestId, reply || { status: 502, body: { message: t('Failed') } });
}

export class CraftingSync {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;
    instance = this;
  }

  /** @param {import('./api-client.mjs').ChronicleAPI} api */
  async init(api) {
    this._api = api;
  }

  async onInitialSync() {
    if (this._api) await this.probe();
  }

  destroy() {
    if (instance === this) instance = null;
  }

  /**
   * Ask Chronicle once whether crafting is on here and share the answer. An
   * older Chronicle or the addon switched off is a quiet "no"; any other
   * failure leaves the stored answer alone, so a blip can't hide the tab.
   */
  async probe() {
    let attempt = {};
    try {
      await this._api.get('/crafting/spoils');
    } catch (err) {
      attempt = { error: err };
      if (err?.status === 404 || err?.status === 403) this._api.dropLastErrorLogEntry?.({ path: '/crafting/spoils', status: err.status });
    }
    const verdict = craftingProbeVerdict(attempt);
    if (!isAnsweringGM(game.user, game.users?.activeGM) || !shouldStoreVerdict(craftingAvailable(), verdict)) return;
    try {
      await setSetting('craftingAvailable', verdict);
    } catch (err) {
      console.warn('Chronicle: could not share crafting availability', err);
    }
  }

  /**
   * Answer one player's request. The member acted for is the one matched to
   * the socket's sender, and the sender must own the character.
   */
  async handleRequest(data, senderId) {
    const req = sanitizeCraftRequest(data);
    if (!req) return;
    const reply = (res) => this._reply(senderId, req, res);
    const user = game.users.get(senderId);
    if (!user || user.isGM) return reply({ status: 403, body: { message: t('NoSender') } });
    if (!this._api) return reply({ status: 503, body: { message: t('GMNotReady') } });
    const acting = chronicleUserFor(getUserMappings(), senderId);
    if (!acting) return reply({ status: 403, body: { message: t('NoMapping') } });
    if (!this._userOwns(user, req.characterId)) return reply({ status: 403, body: { message: t('NotOwner') } });
    const res = await this.run(req, acting, user);
    this._syncManager?.recordUserOutcome?.(senderId, res.status >= 400 ? { status: res.status } : undefined);
    return reply(res);
  }

  /**
   * Make one call to Chronicle. `actingUserId` is the member a player's
   * request is made for, null for the GM's own tab.
   * @returns {Promise<{status: number, body: object|null}>}
   */
  async run(req, actingUserId, user) {
    const call = planCraftCall(req, actingUserId);
    let data;
    try {
      if (call.method === 'GET') data = await this._api.get(call.path);
      else if (call.method === 'DELETE') data = await this._api.delete(call.path);
      else data = await this._api.post(call.path, call.body);
    } catch (err) {
      return { status: err?.status || 502, body: { message: err?.serverMessage || err?.data?.message || t('Failed') } };
    }
    this._after(req, data, user);
    if (call.method === 'DELETE') return { status: 204, body: null };
    return { status: req.action === 'start' ? 201 : 200, body: data ?? {} };
  }

  /** What follows a call that worked: the GMs' whisper and the actor's pack. */
  _after(req, data, user) {
    const line = describeCraft({ action: req.action, who: user?.name, result: data });
    if (line) {
      try {
        const div = document.createElement('div');
        div.textContent = line;
        ChatMessage.create({
          content: `<p>${div.innerHTML}</p>`,
          whisper: ChatMessage.getWhisperRecipients('GM').map((u) => u.id),
          speaker: { alias: 'Chronicle' },
        });
      } catch (err) {
        console.debug('Chronicle: crafting chat line failed', err?.message);
      }
    }
    if (changesPack(req.action, data)) getStashSync()?.refreshCharacters([req.characterId]);
  }

  /** Does this Foundry user own the actor linked to a Chronicle character? */
  _userOwns(user, entityId) {
    const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId);
    return !!actor && actor.testUserPermission(user, 'OWNER');
  }

  /**
   * Send an answer to one user, encrypted to the key the asking client sent;
   * `recipients` only narrows who receives it and is never relied on.
   */
  async _reply(userId, req, res) {
    try {
      const envelope = await encryptReply(req.publicKey, res);
      game.socket.emit(SOCKET_CHANNEL, { type: CRAFT_MESSAGE, action: 'reply', requestId: req.requestId, toUserId: userId, envelope },
        { recipients: [userId] });
    } catch (err) {
      console.warn('Chronicle: could not answer a crafting request', err?.message);
    }
  }
}
