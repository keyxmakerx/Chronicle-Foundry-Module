/**
 * Chronicle Sync - Cut scenes
 *
 * The Director shows a cut scene from Chronicle to chosen players. Players
 * who are only in Foundry get the same full-screen takeover here, played by
 * Chronicle's own engine (vendor/chronicle/cutscene_engine.js, unchanged),
 * and can watch it again from the Satchel while its rewatch window is open.
 *
 * Chronicle sends the showing to the GM's client alone. The active GM's
 * client matches each viewer to a Foundry user and knocks on the clients of
 * those playing now; each asks back with a one-off key and gets the scene
 * encrypted to it, since anything on the module socket may reach every
 * client. The watch-again list goes the same way: the player's client asks,
 * the GM's client reads Chronicle for that player's own member and answers
 * that client alone. Scenes live in memory only, never in a Foundry
 * document, and what a client received this session stays watchable while
 * the GM is away. Pure rules: _cutscene-relay.mjs.
 */

import { MODULE_ID } from './constants.mjs';
import { getSetting, getUserMappings, setSetting } from './settings.mjs';
import { PendingRequests, chronicleUserFor, isAnsweringGM } from './_stash-relay.mjs';
import { decryptReply, encryptReply, generateRequestKeys, isPublicJwk } from './_stash-crypto.mjs';
import { shouldStoreVerdict } from './_stash-probe.mjs';
import { makeAskLimiter } from './_quest-relay.mjs';
import { currentMotion } from './motion.mjs';
import { loadStandalone } from './vendor-chronicle.mjs';
import {
  CUTSCENE_MSG,
  CUTSCENE_WS,
  cleanShowing,
  cleanShowingList,
  cutscenesVerdict,
  isCutsceneMessage,
  isRequestId,
  lateJoinShowings,
  listErrorFrom,
  mayFetch,
  parseFoundryShowing,
  showingIdOf,
  showingsPath,
  showingsWithin,
  viewerTargets,
} from './_cutscene-relay.mjs';

const CHANNEL = `module.${MODULE_ID}`;
const ENGINE_FILE = 'cutscene_engine.js';

/** Hook fired when this client's list of watchable showings changes. */
export const CHANGED_HOOK = 'chronicleCutscenesChanged';

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.Cutscenes.${key}`, data)
  : game.i18n.localize(`CHRONICLE.Cutscenes.${key}`));

/** Each request spends the GM's key and rate budget; a looping client is cut off. */
const askLimit = makeAskLimiter();

const pending = new PendingRequests({ timeoutMs: 10000 });

/** Player side: each waiting request's private key, by request id. */
const keys = new Map();

/** Showings this client received this session, by id, for watching again. */
const remembered = new Map();

/** The scene playing on this client now. */
let current = null;

/** @type {CutsceneRelay|null} */
let instance = null;

function isActiveGM() {
  return isAnsweringGM(game.user, game.users?.activeGM);
}

/** Whether Chronicle has Cut scenes on here (shared by the GM's client). */
export function cutscenesAvailable() {
  try {
    return getSetting('cutscenesAvailable') === true;
  } catch {
    return false;
  }
}

/** Showings received this session that are still inside their window, newest first. */
export function rememberedShowings() {
  return showingsWithin([...remembered.values()]);
}

function remember(showing) {
  const now = Date.now();
  for (const [id, s] of remembered) if (!(s.rewatchUntil > now)) remembered.delete(id);
  if (showing.rewatchUntil > now) remembered.set(showing.showingId, showing);
  Hooks.callAll(CHANGED_HOOK);
}

// --- Playing ---------------------------------------------------------------

function stopCurrent(showingId = null) {
  if (!current || (showingId && current.showingId !== showingId)) return;
  const { run } = current;
  current = null;
  try {
    run?.stop?.();
  } catch (err) {
    console.warn('Chronicle: a cut scene did not stop cleanly', err);
  }
}

/**
 * Play a showing full screen over everything, replacing one already playing.
 * @param {{showingId: string, scene: object}} showing
 * @returns {Promise<boolean>} whether it started
 */
export async function playShowing(showing) {
  let engine = null;
  try {
    await loadStandalone([ENGINE_FILE]);
    engine = globalThis.ChronicleCutscene;
    if (typeof engine?.play !== 'function') throw new Error('the cut scene engine did not load');
  } catch (err) {
    console.warn('Chronicle: could not load the cut scene engine', err);
    ui.notifications?.warn(t('PlayFailed'));
    return false;
  }
  stopCurrent();
  const mine = { showingId: showing.showingId, run: null };
  current = mine;
  try {
    mine.run = engine.play(document.body, showing.scene, {
      // The module's Motion setting outranks the computer's: Calm and Off
      // both get the engine's still version.
      reducedMotion: currentMotion() !== 'full',
      label: t('Label'),
      onClose: () => { if (current === mine) current = null; },
    });
    return true;
  } catch (err) {
    if (current === mine) current = null;
    console.warn('Chronicle: a cut scene could not play', err);
    ui.notifications?.warn(t('PlayFailed'));
    return false;
  }
}

// --- Player side: asking the GM's client ------------------------------------

async function ask(type, extra) {
  let pair;
  try {
    pair = await generateRequestKeys();
  } catch {
    return { ok: false, error: { code: 'unreachable' } };
  }
  const { id, promise } = pending.create();
  keys.set(id, pair.privateKey);
  promise.then(() => keys.delete(id));
  // No user id goes in the payload: the GM's client takes the asker from the
  // socket layer, and answers encrypted to this key alone.
  game.socket.emit(CHANNEL, { type, requestId: id, publicKey: pair.publicJwk, ...extra });
  return promise;
}

/** A knock from the GM's client: fetch that showing's scene and play it. */
async function onKnock(showingId) {
  const reply = await ask(CUTSCENE_MSG.FETCH, { showingId });
  if (!reply?.ok) return;
  const showing = cleanShowing(reply.showing);
  if (!showing || showing.showingId !== showingId) return;
  remember(showing);
  await playShowing(showing);
}

/**
 * This user's watch-again list: Chronicle's, through the active GM's client,
 * merged by the caller with what this client remembers.
 * @returns {Promise<{ok: true, data: object[]}|{ok: false, error: {code: string}, data?: object[]}>}
 */
export async function askWatchList() {
  if (game.user.isGM) {
    if (!instance) return { ok: false, error: { code: 'gm_not_ready' } };
    return instance.listFor(game.user.id);
  }
  if (!game.users.activeGM) return { ok: false, error: { code: 'no_gm' } };
  const reply = await ask(CUTSCENE_MSG.LIST, {});
  if (reply?.ok) return { ok: true, data: cleanShowingList(reply.data) };
  return {
    ok: false,
    error: { code: typeof reply?.error?.code === 'string' ? reply.error.code : 'unreachable' },
    data: cleanShowingList(reply?.data),
  };
}

function settleSealed(data) {
  const key = isRequestId(data.requestId) ? keys.get(data.requestId) : null;
  if (!key) return;
  decryptReply(key, data.envelope).then(
    (body) => pending.settle(data.requestId, body && typeof body === 'object' ? body : { ok: false }),
    () => pending.settle(data.requestId, { ok: false, error: { code: 'unreachable' } }),
  );
}

// --- GM side ---------------------------------------------------------------

/** What a player's client gets of a showing: never who else saw it. */
function forPlayer(s) {
  return { showingId: s.showingId, name: s.name, shownAt: s.shownAt, rewatchUntil: s.rewatchUntil, scene: s.scene };
}

async function sendSealed(userId, type, requestId, publicKey, body) {
  try {
    const envelope = await encryptReply(publicKey, body);
    game.socket.emit(CHANNEL, { type, requestId, toUserId: userId, envelope }, { recipients: [userId] });
  } catch (err) {
    console.warn('Chronicle: could not encrypt a cut scene answer', err?.message);
  }
}

function knock(userId, showingId) {
  // Only the id travels in the clear; the scene follows encrypted.
  game.socket.emit(CHANNEL, { type: CUTSCENE_MSG.KNOCK, showingId, toUserId: userId }, { recipients: [userId] });
}

/**
 * The GM side, a SyncManager module: takes Chronicle's `cutscene.foundry`
 * and `cutscene.foundry_stop`, hands scenes to the players they name, and
 * answers players' watch-again asks. Only the active GM acts.
 */
export class CutsceneRelay {
  constructor() {
    /** @type {import('./api-client.mjs').ChronicleAPI|null} */
    this._api = null;
    /** @type {import('./sync-manager.mjs').SyncManager|null} */
    this._syncManager = null;
    /** Showings Chronicle sent this session, by id, with their viewers. */
    this._showings = new Map();
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
   * Ask Chronicle once whether Cut scenes is on and share the answer, so
   * players' Satchels show the tab. A failed read leaves the stored answer.
   */
  async probe() {
    let attempt;
    try {
      attempt = { body: await this._api.getAddons() };
    } catch (err) {
      attempt = { error: err };
    }
    await this._store(cutscenesVerdict(attempt));
  }

  async _store(verdict) {
    if (!isActiveGM() || !shouldStoreVerdict(cutscenesAvailable(), verdict)) return;
    try {
      await setSetting('cutscenesAvailable', verdict);
    } catch (err) {
      console.warn('Chronicle: could not share whether cut scenes are on', err);
    }
  }

  /** @param {object} msg - a Chronicle WebSocket message */
  onMessage(msg) {
    if (msg?.type !== CUTSCENE_WS.SHOW && msg?.type !== CUTSCENE_WS.STOP) return;
    if (!isActiveGM()) return;
    if (msg.type === CUTSCENE_WS.SHOW) return this._show(msg.payload);
    return this._stop(msg.payload);
  }

  _show(payload) {
    const now = Date.now();
    const showing = parseFoundryShowing(payload, now);
    if (!showing) {
      console.warn('Chronicle: ignored a cut scene Chronicle sent in a shape this module does not read');
      return;
    }
    for (const [id, s] of this._showings) if (!(s.rewatchUntil > now)) this._showings.delete(id);
    const entry = { ...showing, stopped: false, delivered: new Set() };
    this._showings.set(entry.showingId, entry);
    // A showing proves the add-on is on.
    this._store(true);

    const users = (game.users?.contents ?? []).map((u) => ({ id: u.id, active: !!u.active }));
    const { deliver, away, unmapped } = viewerTargets(entry.viewers, getUserMappings(), users);
    for (const userId of deliver) {
      entry.delivered.add(userId);
      if (userId === game.user.id) {
        // The Director picked the member this GM is matched to.
        remember(forPlayer(entry));
        playShowing(entry);
      } else {
        knock(userId, entry.showingId);
      }
    }
    const players = deliver.filter((id) => id !== game.user.id).length;
    this._syncManager?.logActivity?.('update',
      `Cut scene "${entry.name}": ${players} in Foundry now, ${away.length} away, ${unmapped.length} not matched to a Foundry user`);
  }

  _stop(payload) {
    const id = showingIdOf(payload?.showingId);
    const entry = id ? this._showings.get(id) : null;
    if (entry) entry.stopped = true;
    if (!id) return;
    stopCurrent(id);
    const to = entry ? [...entry.delivered].filter((u) => u !== game.user.id) : [];
    // A bare id, honoured only from a GM. With no record of who got it (a
    // reloaded GM client), every client hears it and only one playing it acts.
    game.socket.emit(CHANNEL, { type: CUTSCENE_MSG.STOP, showingId: id }, to.length ? { recipients: to } : undefined);
  }

  /** A user just opened Foundry: hand over a showing that started moments ago. */
  onUserConnected(userId) {
    if (!isActiveGM() || userId === game.user.id) return;
    for (const id of lateJoinShowings(this._showings.values(), userId, getUserMappings())) {
      this._showings.get(id)?.delivered.add(userId);
      knock(userId, id);
    }
  }

  /**
   * A player's client asks for a showing's scene after a knock.
   * @param {object} data
   * @param {string} senderId - Foundry user id from the socket layer
   */
  async handleFetch(data, senderId) {
    if (!isActiveGM() || !askLimit(senderId)) return;
    if (!isRequestId(data.requestId) || !isPublicJwk(data.publicKey)) return;
    const id = showingIdOf(data.showingId);
    const entry = id ? this._showings.get(id) : null;
    const verdict = mayFetch(entry, senderId, getUserMappings());
    if (verdict.ok) entry.delivered.add(senderId);
    const body = verdict.ok ? { ok: true, showing: forPlayer(entry) } : { ok: false, error: { code: verdict.reason } };
    await sendSealed(senderId, CUTSCENE_MSG.PLAY, data.requestId, data.publicKey, body);
  }

  /**
   * A player's client asks for its watch-again list.
   * @param {object} data
   * @param {string} senderId - Foundry user id from the socket layer
   */
  async handleList(data, senderId) {
    if (!isActiveGM() || !askLimit(senderId)) return;
    if (!isRequestId(data.requestId) || !isPublicJwk(data.publicKey)) return;
    const body = await this.listFor(senderId);
    await sendSealed(senderId, CUTSCENE_MSG.LIST_REPLY, data.requestId, data.publicKey, body);
  }

  /**
   * One Foundry user's watch-again list, read from Chronicle for the member
   * they are matched to. When Chronicle can't be read, the showings this
   * client handed out this session come back with the error.
   * @param {string} foundryUserId
   */
  async listFor(foundryUserId) {
    const member = chronicleUserFor(getUserMappings(), foundryUserId);
    if (!member) return { ok: false, error: { code: 'no_mapping' } };
    const seen = showingsWithin([...this._showings.values()].filter((s) => s.viewers.includes(member))).map(forPlayer);
    if (!this._api) return { ok: false, error: { code: 'gm_not_ready' }, data: seen };
    const path = showingsPath(member);
    try {
      return { ok: true, data: cleanShowingList(await this._api.get(path)).map(forPlayer) };
    } catch (err) {
      if (err?.status === 404 || err?.status === 403) this._api.dropLastErrorLogEntry?.({ path, status: err.status });
      return { ok: false, error: listErrorFrom(err), data: seen };
    }
  }
}

/**
 * Listen on the module socket. Called once at ready on every client; the
 * second argument Foundry gives a socket listener is the sender's user id.
 */
export function registerCutscenes() {
  game.socket.on(CHANNEL, (data, senderId) => {
    if (!isCutsceneMessage(data)) return;
    // Knocks, scenes, stops and lists count only from a GM, so a player
    // cannot forge one.
    const fromGM = game.users.get(senderId)?.isGM === true;
    const forMe = data.toUserId === game.user.id;
    switch (data.type) {
      case CUTSCENE_MSG.FETCH:
        if (isActiveGM()) instance?.handleFetch(data, senderId);
        break;
      case CUTSCENE_MSG.LIST:
        if (isActiveGM()) instance?.handleList(data, senderId);
        break;
      case CUTSCENE_MSG.KNOCK: {
        const id = showingIdOf(data.showingId);
        if (fromGM && forMe && id) onKnock(id);
        break;
      }
      case CUTSCENE_MSG.PLAY:
      case CUTSCENE_MSG.LIST_REPLY:
        if (fromGM && forMe) settleSealed(data);
        break;
      case CUTSCENE_MSG.STOP: {
        const id = showingIdOf(data.showingId);
        if (fromGM && id) stopCurrent(id);
        break;
      }
    }
  });
  Hooks.on('userConnected', (user, connected) => {
    if (connected && user?.id) instance?.onUserConnected(user.id);
  });
}
