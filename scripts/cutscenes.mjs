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
 * the GM is away.
 *
 * Preview in Foundry, from the Director's cut scene workshop, comes the same
 * way but plays only on one GM's own screen: it is never put on the module
 * socket, so no player's client can hear of it, and it is not remembered.
 *
 * At a moment the player answers in the scene: the answer goes sealed to the
 * GM's answer key (handed over with the scene), and the GM's client sends it
 * to Chronicle for the player's own member. Chronicle's word that someone is
 * answering goes on to the showing's other viewers, and when the Director
 * lets the moment go each viewer's client is knocked and fetches the lines
 * that joined the story, sealed to it. A player who reloads mid-hold is
 * knocked again, with the moments let go and their own answers.
 * Pure rules: _cutscene-relay.mjs.
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
  answerPath,
  cleanAnswer,
  cleanLines,
  cleanShowing,
  cleanShowingList,
  cutscenesVerdict,
  isCutsceneMessage,
  isHolding,
  isRequestId,
  lateJoinShowings,
  listErrorFrom,
  mayFetch,
  mayReadLines,
  parseFoundryAnswering,
  parseFoundryGo,
  parseFoundryPreview,
  parseFoundryShowing,
  pastOf,
  previewPlayer,
  showingIdOf,
  showingsPath,
  showingsWithin,
  statusTargets,
  viewerTargets,
  whoKey,
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

/** Player side: the active GM's public key that answers are sealed to. */
let answerKey = null;

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
 * @param {{label?: string, failed?: string, canContinue?: boolean, answering?: boolean, past?: object}} [opts] -
 *   the screen reader's name for it, the warning when it cannot play,
 *   whether a moment offers its own Continue (the Director's preview only),
 *   whether its moments can be answered (a real showing), and what a
 *   reloaded screen catches up on (`pastOf`)
 * @returns {Promise<boolean>} whether it started
 */
export async function playShowing(showing, { label, failed, canContinue = false, answering = false, past = null } = {}) {
  let engine = null;
  try {
    await loadStandalone([ENGINE_FILE]);
    engine = globalThis.ChronicleCutscene;
    if (typeof engine?.play !== 'function') throw new Error('the cut scene engine did not load');
  } catch (err) {
    console.warn('Chronicle: could not load the cut scene engine', err);
    ui.notifications?.warn(failed || t('PlayFailed'));
    return false;
  }
  stopCurrent();
  const mine = { showingId: showing.showingId, scene: showing.scene, who: {}, run: null };
  current = mine;
  const caught = past ? pastOf(past) : { released: [], answers: [] };
  try {
    mine.run = engine.play(document.body, showing.scene, {
      // The module's Motion setting outranks the computer's: Calm and Off
      // both get the engine's still version.
      reducedMotion: currentMotion() !== 'full',
      motion: currentMotion(),
      label: label || t('Label'),
      canContinue,
      words: momentWords(),
      released: caught.released,
      ...(answering ? { onAnswer: (i, ans) => sendAnswer(showing.showingId, i, ans) } : {}),
      onClose: () => { if (current === mine) current = null; },
    });
    for (const a of caught.answers) mine.run?.answered?.(a.moment, a);
    return true;
  } catch (err) {
    if (current === mine) current = null;
    console.warn('Chronicle: a cut scene could not play', err);
    ui.notifications?.warn(failed || t('PlayFailed'));
    return false;
  }
}

/** The words a moment's question is drawn with, in this client's language. */
function momentWords() {
  return {
    turn: t('MomentTurn'),
    go: t('MomentContinue'),
    write: t('MomentWrite'),
    writeHint: t('MomentWriteHint'),
    director: t('MomentDirector'),
    directorHint: t('MomentDirectorHint'),
    yourAnswer: t('MomentYourAnswer'),
    send: t('MomentSend'),
    sending: t('MomentSending'),
    back: t('MomentBack'),
    empty: t('MomentEmpty'),
    failed: t('MomentFailed'),
    sent: t('MomentSent'),
    leftIt: t('MomentLeftIt'),
    change: t('MomentChange'),
    joined: t('MomentJoined'),
    from: t('MomentFrom'),
  };
}

/** An error whose words a player may read on the scene. */
function plain(message) {
  const e = new Error(message);
  e.plain = true;
  return e;
}

/**
 * Send this player's answer at a moment: to Chronicle straight away on the
 * GM's own screen, otherwise sealed to the active GM's answer key. Rejects
 * with words the scene shows.
 */
async function sendAnswer(showingId, moment, raw) {
  const ans = cleanAnswer(raw);
  if (!ans) throw plain(t('MomentEmpty'));
  if (isActiveGM() && instance) {
    const r = await instance.answerFor(game.user.id, showingId, moment, ans);
    if (!r.ok) throw plain(r.error?.message || t('MomentFailed'));
    return;
  }
  if (!game.users.activeGM) throw plain(t('MomentNoGM'));
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isPublicJwk(answerKey)) throw plain(t('MomentNoGM'));
    let envelope;
    try {
      envelope = await encryptReply(answerKey, { showingId, moment, way: ans.way, text: ans.text });
    } catch {
      throw plain(t('MomentFailed'));
    }
    const reply = await ask(CUTSCENE_MSG.ANSWER, { envelope });
    if (reply?.ok) return;
    // The GM's Foundry reloaded since the scene came: take its new key once.
    if (reply?.error?.code === 'stale_key' && isPublicJwk(reply.answerKey)) {
      answerKey = reply.answerKey;
      continue;
    }
    const msg = typeof reply?.error?.message === 'string' ? reply.error.message.slice(0, 200) : '';
    throw plain(msg || (reply?.error?.code === 'timeout' ? t('MomentNoGM') : t('MomentFailed')));
  }
  throw plain(t('MomentFailed'));
}

/** Who else is answering a moment of the scene playing here. */
function applyStatus(showingId, moment, member, name) {
  if (!current || current.showingId !== showingId || typeof current.run?.status !== 'function') return;
  const who = current.who[moment] || (current.who[moment] = {});
  who[member] = name || t('MomentSomeone');
  const one = current.scene?.moments?.[moment]?.to === 'one';
  const k = whoKey(Object.values(who), one);
  current.run.status(moment, k ? t(k.key, k.data) : '', one);
}

/** The Director let a moment go: show the lines that joined the story, then go on. */
function goHere(showingId, moment, lines) {
  if (!current || current.showingId !== showingId || typeof current.run?.go !== 'function') return;
  current.run.go(moment, cleanLines(lines));
}

/** A knock that a moment was let go: fetch its lines, sealed, and go on. */
async function onGo(showingId, moment) {
  if (!current || current.showingId !== showingId) return;
  const reply = await ask(CUTSCENE_MSG.LINES, { showingId, moment });
  // Without the lines the scene still goes on; they are on the page.
  goHere(showingId, moment, reply?.ok ? reply.lines : []);
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
  if (isPublicJwk(reply.answerKey)) answerKey = reply.answerKey;
  remember(showing);
  await playShowing(showing, { answering: true, past: reply.past });
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
  if (isPublicJwk(reply?.answerKey)) answerKey = reply.answerKey;
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

/**
 * What a reloaded player's screen catches up on: the moments let go here and
 * that member's own answers.
 */
function pastFor(entry, member) {
  const answers = [];
  for (const [key, a] of entry.answers || []) {
    const [m, i] = key.split('\n');
    if (m === member) answers.push({ moment: Number(i), way: a.way, text: a.text });
  }
  return { released: [...(entry.released || [])], answers };
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
    /** Moments let go, by showing id: its viewers and each moment's lines. */
    this._gone = new Map();
    /** This client's key pair that players seal answers to. */
    this._answerKeys = null;
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
    // A preview picks its own GM, who need not be the active one.
    if (msg?.type === CUTSCENE_WS.PREVIEW) return this._preview(msg.payload);
    const act = {
      [CUTSCENE_WS.SHOW]: this._show,
      [CUTSCENE_WS.STOP]: this._stop,
      [CUTSCENE_WS.ANSWERING]: this._answering,
      [CUTSCENE_WS.GO]: this._go,
    }[msg?.type];
    if (!act || !isActiveGM()) return;
    return act.call(this, msg.payload);
  }

  /** The key pair players seal answers to, made once per session. */
  async _keys() {
    if (!this._answerKeys) this._answerKeys = generateRequestKeys();
    try {
      return await this._answerKeys;
    } catch (err) {
      this._answerKeys = null;
      throw err;
    }
  }

  async _answerKey() {
    try {
      return (await this._keys()).publicJwk;
    } catch {
      return null;
    }
  }

  /** Someone answered: tell the showing's other viewers here who. */
  _answering(payload) {
    const a = parseFoundryAnswering(payload);
    if (!a) return;
    const users = (game.users?.contents ?? []).map((u) => ({ id: u.id, active: !!u.active }));
    for (const userId of statusTargets(a, getUserMappings(), users)) {
      if (userId === game.user.id) applyStatus(a.showingId, a.moment, a.member, a.name);
      else {
        game.socket.emit(CHANNEL, { type: CUTSCENE_MSG.STATUS, showingId: a.showingId, moment: a.moment, member: a.member, name: a.name, toUserId: userId },
          { recipients: [userId] });
      }
    }
  }

  /**
   * The Director let a moment go: keep its lines for the viewers' clients to
   * fetch, and knock on each one playing now.
   */
  _go(payload) {
    const g = parseFoundryGo(payload);
    if (!g) return;
    const now = Date.now();
    for (const [id, rec] of this._gone) if (now - rec.at > 60 * 60 * 1000) this._gone.delete(id);
    const rec = this._gone.get(g.showingId) || { viewers: [], lines: new Map(), at: now };
    if (g.viewers.length) rec.viewers = g.viewers;
    rec.lines.set(g.moment, g.lines);
    rec.at = now;
    this._gone.set(g.showingId, rec);
    const entry = this._showings.get(g.showingId);
    if (entry) (entry.released || (entry.released = new Set())).add(g.moment);
    const users = (game.users?.contents ?? []).map((u) => ({ id: u.id, active: !!u.active }));
    for (const userId of viewerTargets(rec.viewers, getUserMappings(), users).deliver) {
      if (userId === game.user.id) goHere(g.showingId, g.moment, g.lines);
      // Only the id and the moment travel in the clear; the lines follow sealed.
      else game.socket.emit(CHANNEL, { type: CUTSCENE_MSG.GO, showingId: g.showingId, moment: g.moment, toUserId: userId }, { recipients: [userId] });
    }
  }

  /**
   * One Foundry user's answer at a moment, sent to Chronicle for the member
   * they are matched to; Chronicle checks that member is a viewer.
   * @returns {Promise<{ok: true}|{ok: false, error: {code: string, message: string}}>}
   */
  async answerFor(foundryUserId, showingId, moment, raw) {
    const member = chronicleUserFor(getUserMappings(), foundryUserId);
    if (!member) return { ok: false, error: { code: 'no_mapping', message: t('MomentNoLink') } };
    const id = showingIdOf(showingId);
    const ans = cleanAnswer(raw);
    if (!id || !ans || !Number.isInteger(moment) || moment < 0 || moment > 30) return { ok: false, error: { code: 'bad', message: t('MomentFailed') } };
    if (!this._api) return { ok: false, error: { code: 'gm_not_ready', message: t('MomentNoGM') } };
    try {
      await this._api.post(answerPath(id, moment), { user: member, way: ans.way, text: ans.text });
    } catch (err) {
      const said = err?.serverMessage || err?.data?.message;
      const refused = err?.status >= 400 && err?.status < 500 && typeof said === 'string' && said;
      return { ok: false, error: { code: 'refused', message: refused ? said.slice(0, 200) : t('MomentFailed') } };
    }
    const entry = this._showings.get(id);
    if (entry) (entry.answers || (entry.answers = new Map())).set(`${member}\n${moment}`, ans);
    return { ok: true };
  }

  /**
   * A player's client sends its answer, sealed to this client's answer key.
   * @param {object} data
   * @param {string} senderId - Foundry user id from the socket layer
   */
  async handleAnswer(data, senderId) {
    if (!isActiveGM() || !askLimit(senderId)) return;
    if (!isRequestId(data.requestId) || !isPublicJwk(data.publicKey)) return;
    let inner = null;
    let keys = null;
    try {
      keys = await this._keys();
      inner = await decryptReply(keys.privateKey, data.envelope);
    } catch {
      inner = null;
    }
    const body = inner && typeof inner === 'object'
      ? await this.answerFor(senderId, inner.showingId, inner.moment, inner)
      : { ok: false, error: { code: 'stale_key' }, answerKey: keys?.publicJwk ?? null };
    await sendSealed(senderId, CUTSCENE_MSG.ANSWER_REPLY, data.requestId, data.publicKey, body);
  }

  /**
   * A viewer's client asks for the lines that joined the story at a moment.
   * @param {object} data
   * @param {string} senderId - Foundry user id from the socket layer
   */
  async handleLines(data, senderId) {
    if (!isActiveGM() || !askLimit(senderId)) return;
    if (!isRequestId(data.requestId) || !isPublicJwk(data.publicKey)) return;
    const id = showingIdOf(data.showingId);
    const rec = id ? this._gone.get(id) : null;
    const ok = mayReadLines(rec, senderId, getUserMappings(), data.moment);
    const body = ok ? { ok: true, lines: rec.lines.get(data.moment) } : { ok: false, error: { code: 'not_viewer' } };
    await sendSealed(senderId, CUTSCENE_MSG.LINES_REPLY, data.requestId, data.publicKey, body);
  }

  _show(payload) {
    const now = Date.now();
    const showing = parseFoundryShowing(payload, now);
    if (!showing) {
      console.warn('Chronicle: ignored a cut scene Chronicle sent in a shape this module does not read');
      return;
    }
    for (const [id, s] of this._showings) if (!(s.rewatchUntil > now)) this._showings.delete(id);
    const entry = { ...showing, stopped: false, delivered: new Set(), released: new Set(), answers: new Map() };
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
        playShowing(entry, { answering: true });
      } else {
        knock(userId, entry.showingId);
      }
    }
    const players = deliver.filter((id) => id !== game.user.id).length;
    this._syncManager?.logActivity?.('update',
      `Cut scene "${entry.name}": ${players} in Foundry now, ${away.length} away, ${unmapped.length} not matched to a Foundry user`);
  }

  /**
   * The Director's Preview in Foundry: play the scene on this screen when
   * this is the GM it is for. Only GM clients hold a Chronicle socket, and
   * nothing is emitted, remembered or saved, so players never see it.
   * @returns {Promise<boolean>|undefined} whether it started, when it plays here
   */
  _preview(payload) {
    if (!game.user?.isGM) return;
    const preview = parseFoundryPreview(payload);
    if (!preview) {
      console.warn('Chronicle: ignored a cut scene preview Chronicle sent in a shape this module does not read');
      return;
    }
    const users = (game.users?.contents ?? []).map((u) => ({ id: u.id, active: !!u.active, isGM: !!u.isGM }));
    if (previewPlayer(preview.director, getUserMappings(), users, game.users?.activeGM?.id) !== game.user.id) return;
    const name = preview.scene.name || '';
    this._syncManager?.logActivity?.('update', `Cut scene preview "${name}" played on this screen only`);
    return playShowing({ showingId: `preview-${preview.previewId}`, scene: preview.scene }, {
      label: t('PreviewLabel', { name }),
      failed: t('PreviewFailed'),
      // The GM watching their own preview lets each moment go on.
      canContinue: true,
    });
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

  /**
   * A user just opened Foundry: hand over a showing that started moments
   * ago, and any still holding on a moment, which waits on them however
   * long ago it began. One the GM's client never heard of (it reloaded too)
   * comes from Chronicle's list for that member.
   */
  onUserConnected(userId) {
    if (!isActiveGM() || userId === game.user.id) return;
    const knocked = new Set();
    for (const id of lateJoinShowings(this._showings.values(), userId, getUserMappings())) {
      this._showings.get(id)?.delivered.add(userId);
      knock(userId, id);
      knocked.add(id);
    }
    const member = chronicleUserFor(getUserMappings(), userId);
    if (!member) return;
    for (const s of this._showings.values()) {
      if (knocked.has(s.showingId) || !s.viewers.includes(member) || !isHolding(s)) continue;
      s.delivered.add(userId);
      knock(userId, s.showingId);
      knocked.add(s.showingId);
    }
    return this._catchUp(userId, member, knocked);
  }

  async _catchUp(userId, member, knocked) {
    if (!this._api || !cutscenesAvailable()) return;
    let body;
    try {
      body = await this._api.get(showingsPath(member));
    } catch {
      return;
    }
    const rows = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
    for (const raw of rows) {
      const past = pastOf(raw);
      const showing = past.holding ? cleanShowing(raw) : null;
      if (!showing || knocked.has(showing.showingId)) continue;
      const entry = this._showings.get(showing.showingId)
        || { ...showing, viewers: [], stopped: false, delivered: new Set(), released: new Set(), answers: new Map() };
      if (!entry.viewers.includes(member)) entry.viewers = [...entry.viewers, member];
      entry.released = new Set([...(entry.released || []), ...past.released]);
      entry.answers = entry.answers || new Map();
      for (const a of past.answers) entry.answers.set(`${member}\n${a.moment}`, { way: a.way, text: a.text });
      this._showings.set(entry.showingId, entry);
      entry.delivered.add(userId);
      knock(userId, entry.showingId);
      knocked.add(entry.showingId);
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
    const body = verdict.ok
      ? { ok: true, showing: forPlayer(entry), past: pastFor(entry, verdict.member), answerKey: await this._answerKey() }
      : { ok: false, error: { code: verdict.reason } };
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
    const body = { ...(await this.listFor(senderId)), answerKey: await this._answerKey() };
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
      case CUTSCENE_MSG.ANSWER:
        if (isActiveGM()) instance?.handleAnswer(data, senderId);
        break;
      case CUTSCENE_MSG.LINES:
        if (isActiveGM()) instance?.handleLines(data, senderId);
        break;
      case CUTSCENE_MSG.STATUS: {
        const id = showingIdOf(data.showingId);
        if (fromGM && forMe && id && Number.isInteger(data.moment) && typeof data.member === 'string') {
          applyStatus(id, data.moment, data.member, typeof data.name === 'string' ? data.name.slice(0, 200) : '');
        }
        break;
      }
      case CUTSCENE_MSG.GO: {
        const id = showingIdOf(data.showingId);
        if (fromGM && forMe && id && Number.isInteger(data.moment)) onGo(id, data.moment);
        break;
      }
      case CUTSCENE_MSG.KNOCK: {
        const id = showingIdOf(data.showingId);
        if (fromGM && forMe && id) onKnock(id);
        break;
      }
      case CUTSCENE_MSG.PLAY:
      case CUTSCENE_MSG.LIST_REPLY:
      case CUTSCENE_MSG.ANSWER_REPLY:
      case CUTSCENE_MSG.LINES_REPLY:
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
