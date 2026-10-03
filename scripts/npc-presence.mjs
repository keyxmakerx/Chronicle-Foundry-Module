/**
 * Chronicle Sync - NPC presence on the map
 *
 * Gives a Chronicle NPC's token three GM tools on its token HUD:
 * - Spotlight: every client that can see the token glides its camera there,
 *   a gold ring settles around it and its name appears. Plays once.
 * - Talking: a breathing ring and speech mark while the GM speaks as the
 *   NPC. Stored as a token flag so late joiners see it; one NPC at a time;
 *   switches itself off after two quiet minutes.
 * - Open page: the NPC's synced Chronicle journal.
 *
 * A token finds its page by an explicit link (a Chronicle journal dropped on
 * the token) or by a unique name match. Revealing a hidden NPC token asks
 * whether to show the page to players too. Nothing here ever reveals a token
 * or page on its own. Pure rules live in _npc-presence.mjs.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { confirmDialog } from './_dialogs.mjs';
import {
  SPOT,
  resolveTokenPage,
  spotlightAction,
  isTalkLive,
  spotlightRing,
  talkingRing,
  stepAmp,
  isResting,
  shouldAskReveal,
} from './_npc-presence.mjs';

const CHANNEL = `module.${MODULE_ID}`;
const MSG_TYPE = 'npc-presence';

/** Actor flag: Chronicle entity id set by dropping a journal on a token. */
export const LINK_FLAG = 'npcEntityId';
/** Token flag: `{at}` while the NPC is talking; `at` moves with each line. */
export const TALK_FLAG = 'talking';

/** A chat line refreshes the talking flag at most this often. */
const TOUCH_EVERY_MS = 10 * 1000;
const GOLD = 0xf2c14e;

const state = {
  getApi: () => null,
  layer: null,
  effects: new Map(),
  lastInput: Date.now(),
  amp: 1,
  lastTick: 0,
  ticking: false,
  asking: new Set(),
};

/**
 * Register hooks for every client. GM-only actions check `isGM` themselves;
 * players need the socket and the drawing to see spotlights and talking.
 * @param {() => {post: Function}|null} getApi - Chronicle API client (GM only).
 */
export function registerNpcPresence(getApi) {
  state.getApi = getApi;
  game.socket.on(CHANNEL, _onSocket);
  Hooks.on('renderTokenHUD', _onRenderHud);
  Hooks.on('canvasReady', _onCanvasReady);
  Hooks.on('canvasTearDown', _teardownLayer);
  Hooks.on('updateToken', _onUpdateToken);
  Hooks.on('dropCanvasData', _onDropCanvasData);
  Hooks.on('createChatMessage', _onChatMessage);
  const mark = () => { state.lastInput = Date.now(); };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(ev, mark, { passive: true });
  }
  if (game.user.isGM) setInterval(_sweepQuietTalk, 15 * 1000);
  if (canvas?.ready) _onCanvasReady();
}

/* ---------------- Page lookup ---------------- */

/** Synced Chronicle page journals (not notes or player notebooks). */
function _pages() {
  const out = [];
  for (const j of game.journal ?? []) {
    const entityId = j.getFlag(FLAG_SCOPE, 'entityId');
    if (!entityId || j.getFlag(FLAG_SCOPE, 'isNote') || j.getFlag(FLAG_SCOPE, 'noteId')) continue;
    out.push({ entityId, name: j.name, typeName: j.getFlag(FLAG_SCOPE, 'entityType') || '', journal: j });
  }
  return out;
}

/** The base actor behind a token, linked or not. */
function _baseActor(tokenDoc) {
  return tokenDoc?.baseActor ?? game.actors?.get(tokenDoc?.actorId) ?? null;
}

/**
 * The Chronicle page a token belongs to, with its journal.
 * @returns {{entityId: string, journal: JournalEntry}|null}
 */
function _tokenPage(tokenDoc, pages = _pages()) {
  const actor = _baseActor(tokenDoc);
  const entityId = resolveTokenPage({
    heroEntityId: actor?.getFlag(FLAG_SCOPE, 'entityId') ?? null,
    linkedEntityId: actor?.getFlag(FLAG_SCOPE, LINK_FLAG) ?? null,
    names: [tokenDoc?.name, actor?.name],
    pages,
  });
  if (!entityId) return null;
  const page = pages.find((p) => p.entityId === entityId);
  return page ? { entityId, journal: page.journal } : null;
}

function _pagePrivate(journal) {
  return (journal?.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
}

/* ---------------- Spotlight ---------------- */

/**
 * GM: spotlight a token for everyone who can see it. A hidden token plays
 * nothing and only tells the GM.
 * @param {Token} token
 */
function _spotlight(token) {
  const doc = token.document;
  const action = spotlightAction({
    isGM: true, sameScene: true, tokenFound: true, tokenHidden: !!doc.hidden, visibleToMe: true,
  });
  if (action === 'note-hidden') {
    ui.notifications.info(game.i18n.format('CHRONICLE.Npc.SpotlightHidden', { name: doc.name }));
    return;
  }
  // Players get the name only when they could already know it: their page
  // is shown to them, or the token's nameplate shows to everyone.
  const page = _tokenPage(doc);
  const modes = CONST.TOKEN_DISPLAY_MODES ?? {};
  const plateShown = doc.displayName === modes.HOVER || doc.displayName === modes.ALWAYS;
  const publicName = (page && !_pagePrivate(page.journal)) || plateShown ? doc.name : '';
  const payload = {
    type: MSG_TYPE, action: 'spotlight', sceneId: doc.parent?.id, tokenId: doc.id,
    name: publicName, userId: game.user.id,
  };
  game.socket.emit(CHANNEL, payload);
  _playSpotlight({ ...payload, name: doc.name });
}

function _onSocket(data) {
  if (data?.type !== MSG_TYPE) return;
  // Only a GM's spotlight moves anyone's camera. The sender id is the
  // payload's own claim, so this stops mistakes, not a determined player;
  // the most a forged one can do is pan to a token the viewer can see.
  if (!game.users?.get(data.userId)?.isGM) return;
  if (data.action === 'spotlight') _playSpotlight(data);
}

/** Play a spotlight on this client if this viewer can see the token. */
function _playSpotlight(p) {
  const sameScene = !!canvas?.ready && canvas.scene?.id === p.sceneId;
  const token = sameScene ? canvas.tokens?.get(p.tokenId) : null;
  const action = spotlightAction({
    isGM: game.user.isGM,
    sameScene,
    tokenFound: !!token,
    tokenHidden: !!token?.document?.hidden,
    visibleToMe: !!token?.visible,
  });
  if (action !== 'play') {
    // Only the GM who pressed it hears why nothing played.
    if (p.userId === game.user.id && action === 'note-elsewhere') {
      ui.notifications.info(game.i18n.localize('CHRONICLE.Npc.SpotlightElsewhere'));
    }
    return;
  }
  const reduce = _reducedMotion();
  canvas.animatePan({ x: token.center.x, y: token.center.y, duration: reduce ? 0 : SPOT.PAN_MS });
  state.effects.set(`spot:${token.id}`, { kind: 'spot', tokenId: token.id, start: performance.now(), g: null });
  _ensureTicker();
  if (p.name) _showBanner(p.name);
}

function _showBanner(name) {
  document.querySelector('.chronicle-npc-banner')?.remove();
  const el = document.createElement('div');
  el.className = 'chronicle-npc-banner';
  el.textContent = name;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('is-on'), SPOT.BLOOM_AT + 200);
  setTimeout(() => el.classList.remove('is-on'), SPOT.BLOOM_AT + SPOT.BLOOM_MS + SPOT.HOLD_MS);
  setTimeout(() => el.remove(), SPOT.BLOOM_AT + SPOT.BLOOM_MS + SPOT.HOLD_MS + 800);
}

/* ---------------- Talking ---------------- */

/** GM: start or stop a token talking. Starting stops every other NPC. */
async function _toggleTalk(token) {
  const doc = token.document;
  try {
    if (isTalkLive(doc.getFlag(FLAG_SCOPE, TALK_FLAG), Date.now())) {
      await doc.unsetFlag(FLAG_SCOPE, TALK_FLAG);
      return;
    }
    for (const scene of game.scenes ?? []) {
      for (const td of scene.tokens ?? []) {
        if (td.id !== doc.id && td.getFlag(FLAG_SCOPE, TALK_FLAG)) await td.unsetFlag(FLAG_SCOPE, TALK_FLAG);
      }
    }
    await doc.setFlag(FLAG_SCOPE, TALK_FLAG, { at: Date.now() });
    // Selecting the token makes the GM's chat lines come from the NPC.
    token.control({ releaseOthers: true });
  } catch (err) {
    console.error('Chronicle: talking toggle failed', err);
    ui.notifications.error(game.i18n.localize('CHRONICLE.Npc.TalkFailed'));
  }
}

/** GM: each line spoken as a talking NPC keeps its glow on. */
function _onChatMessage(msg, _options, userId) {
  if (!game.user.isGM || userId !== game.user.id) return;
  const td = game.scenes?.get(msg.speaker?.scene)?.tokens?.get(msg.speaker?.token);
  const flag = td?.getFlag(FLAG_SCOPE, TALK_FLAG);
  const now = Date.now();
  if (!isTalkLive(flag, now) || now - flag.at < TOUCH_EVERY_MS) return;
  td.setFlag(FLAG_SCOPE, TALK_FLAG, { at: now }).catch(() => {});
}

/** Active GM: clear talking flags that went quiet, so reloads leave none behind. */
function _sweepQuietTalk() {
  const active = game.users?.activeGM;
  if (active ? !active.isSelf : !game.user.isGM) return;
  const now = Date.now();
  for (const scene of game.scenes ?? []) {
    for (const td of scene.tokens ?? []) {
      const flag = td.getFlag(FLAG_SCOPE, TALK_FLAG);
      if (flag && !isTalkLive(flag, now)) td.unsetFlag(FLAG_SCOPE, TALK_FLAG).catch(() => {});
    }
  }
}

/** Match the talking effects to the flags on the current scene. */
function _syncTalking() {
  if (!canvas?.ready) return;
  const now = Date.now();
  for (const token of canvas.tokens?.placeables ?? []) {
    const key = `talk:${token.id}`;
    const live = isTalkLive(token.document.getFlag(FLAG_SCOPE, TALK_FLAG), now);
    if (live && !state.effects.has(key)) {
      state.effects.set(key, { kind: 'talk', tokenId: token.id, start: performance.now(), g: null });
    } else if (!live && state.effects.has(key)) {
      _removeEffect(key);
    }
  }
  _ensureTicker();
}

/* ---------------- Drawing ---------------- */

function _onCanvasReady() {
  _teardownLayer();
  state.layer = new PIXI.Container();
  state.layer.eventMode = 'none';
  (canvas.interface ?? canvas.stage).addChild(state.layer);
  _syncTalking();
}

function _teardownLayer() {
  for (const key of [...state.effects.keys()]) _removeEffect(key);
  state.layer?.destroy({ children: true });
  state.layer = null;
}

function _removeEffect(key) {
  const fx = state.effects.get(key);
  fx?.g?.destroy({ children: true });
  state.effects.delete(key);
}

function _ensureTicker() {
  if (state.ticking || !state.effects.size || !canvas?.app?.ticker) return;
  state.ticking = true;
  state.lastTick = performance.now();
  canvas.app.ticker.add(_tick);
}

function _stopTicker() {
  canvas?.app?.ticker?.remove(_tick);
  state.ticking = false;
}

/** One frame: follow each token and draw its ring at the current phase. */
function _tick() {
  try {
    _drawFrame();
  } catch (err) {
    // A drawing failure (say, a PIXI change in a newer Foundry) drops the
    // effects instead of throwing on every frame.
    console.error('Chronicle: NPC token effect failed', err);
    for (const key of [...state.effects.keys()]) _removeEffect(key);
    _stopTicker();
  }
}

function _drawFrame() {
  const nowPerf = performance.now();
  const dt = nowPerf - state.lastTick;
  state.lastTick = nowPerf;
  const now = Date.now();
  const resting = _reducedMotion() || isResting({ hidden: document.hidden, lastInput: state.lastInput, now });
  state.amp = stepAmp(state.amp, resting, dt);

  for (const [key, fx] of state.effects) {
    const token = canvas.tokens?.get(fx.tokenId);
    if (!token || token.destroyed || !state.layer) { _removeEffect(key); continue; }
    if (!fx.g) {
      fx.g = new PIXI.Container();
      fx.g.addChild(new PIXI.Graphics());
      if (fx.kind === 'talk') fx.g.addChild(new PIXI.Graphics());
      state.layer.addChild(fx.g);
    }
    fx.g.position.set(token.center.x, token.center.y);
    const r = Math.max(token.w, token.h) / 2 + 6;
    const t = nowPerf - fx.start;

    if (fx.kind === 'spot') {
      const ring = _reducedMotion() ? { scale: 1, alpha: t < 4000 ? 1 : 0, glow: 1, done: t >= 4000 } : spotlightRing(t);
      if (ring.done) { _removeEffect(key); continue; }
      _drawRing(fx.g.children[0], r * ring.scale, ring.alpha, ring.glow);
    } else {
      const live = isTalkLive(token.document.getFlag(FLAG_SCOPE, TALK_FLAG), now);
      if (!live) { _removeEffect(key); continue; }
      fx.g.visible = game.user.isGM || token.visible;
      const ring = talkingRing(t, state.amp);
      _drawRing(fx.g.children[0], r * ring.scale, 1, ring.glow);
      _drawDots(fx.g.children[1], r, t, state.amp);
    }
  }
  if (!state.effects.size) _stopTicker();
}

function _drawRing(g, radius, alpha, glow) {
  g.clear();
  if (alpha <= 0) return;
  for (let i = 3; i >= 1; i--) {
    g.lineStyle(3 + i * 4, GOLD, 0.12 * glow * alpha);
    g.drawCircle(0, 0, radius);
  }
  g.lineStyle(3, GOLD, alpha);
  g.drawCircle(0, 0, radius);
}

function _drawDots(g, r, t, amp) {
  g.clear();
  const x = r * 0.55;
  const y = -r - 22;
  g.beginFill(0xfffdf5, 0.95);
  g.drawRoundedRect(x, y, 40, 18, 9);
  g.endFill();
  for (let i = 0; i < 3; i++) {
    const phase = ((t - i * 200) % 1200) / 1200;
    const lift = phase < 0.3 ? Math.sin((phase / 0.3) * Math.PI) * 4 * amp : 0;
    g.beginFill(0x555555, 0.6 + 0.4 * (lift / 4));
    g.drawCircle(x + 10 + i * 10, y + 9 - lift, 3);
    g.endFill();
  }
}

function _reducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/* ---------------- Token updates, drops and reveal ---------------- */

function _onUpdateToken(doc, change, _options, userId) {
  if (foundry.utils.hasProperty(change, `flags.${FLAG_SCOPE}`) || foundry.utils.hasProperty(change, 'hidden')) {
    if (doc.parent?.id === canvas?.scene?.id) _syncTalking();
  }
  if (game.user.isGM && userId === game.user.id && change.hidden === false) _askReveal(doc);
}

/** GM revealed a hidden NPC token: offer to show its page to players too. */
async function _askReveal(doc) {
  const page = _tokenPage(doc);
  if (!shouldAskReveal({
    wasHidden: true, nowHidden: false, entityId: page?.entityId ?? null, pagePrivate: _pagePrivate(page?.journal),
  })) return;
  // Revealing several tokens of one NPC asks once.
  if (state.asking.has(page.entityId)) return;
  state.asking.add(page.entityId);
  try {
    const ok = await confirmDialog({
      title: game.i18n.localize('CHRONICLE.Npc.RevealTitle'),
      content: `<p>${game.i18n.format('CHRONICLE.Npc.RevealAsk', { name: _escape(page.journal.name) })}</p>`,
    });
    if (!ok) return;
    const api = state.getApi();
    if (!api) throw new Error('not connected');
    await api.post(`/entities/${page.entityId}/reveal`, { is_private: false });
    ui.notifications.info(game.i18n.format('CHRONICLE.Npc.Revealed', { name: page.journal.name }));
  } catch (err) {
    console.error('Chronicle: revealing NPC page failed', err);
    ui.notifications.error(game.i18n.localize('CHRONICLE.Npc.RevealFailed'));
  } finally {
    state.asking.delete(page.entityId);
  }
}

/**
 * GM drops a Chronicle journal on a token: link the token's actor to that
 * page instead of placing a map note. Returning false stops the default.
 */
function _onDropCanvasData(_canvas, data) {
  if (!game.user.isGM || data?.type !== 'JournalEntry') return;
  // Topmost token under the drop point (placeables draw in list order).
  const token = [...(canvas.tokens?.placeables ?? [])].reverse().find((t) => t.bounds?.contains(data.x, data.y));
  if (!token) return;
  const journal = data.uuid ? fromUuidSync(data.uuid) : game.journal?.get(data.id);
  const entityId = journal?.getFlag?.(FLAG_SCOPE, 'entityId');
  if (!entityId || journal.getFlag(FLAG_SCOPE, 'isNote')) return;
  const actor = _baseActor(token.document);
  if (!actor) return;
  if (actor.getFlag(FLAG_SCOPE, 'entityId')) {
    ui.notifications.warn(game.i18n.format('CHRONICLE.Npc.LinkHero', { name: actor.name }));
    return false;
  }
  actor.setFlag(FLAG_SCOPE, LINK_FLAG, entityId)
    .then(() => ui.notifications.info(game.i18n.format('CHRONICLE.Npc.Linked', { name: token.document.name, page: journal.name })))
    .catch((err) => {
      console.error('Chronicle: linking token to page failed', err);
      ui.notifications.error(game.i18n.localize('CHRONICLE.Npc.LinkFailed'));
    });
  return false;
}

/* ---------------- Token HUD ---------------- */

function _onRenderHud(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const col = root?.querySelector('.col.right');
  const token = hud?.object;
  if (!col || !token) return;
  col.querySelectorAll('.chronicle-npc-hud').forEach((el) => el.remove());
  const tag = col.querySelector('.control-icon')?.tagName === 'BUTTON' ? 'button' : 'div';

  const add = (icon, labelKey, onClick, active = false) => {
    const el = document.createElement(tag);
    if (tag === 'button') el.type = 'button';
    el.className = `control-icon chronicle-npc-hud${active ? ' active' : ''}`;
    el.dataset.tooltip = game.i18n.localize(labelKey);
    el.setAttribute('aria-label', game.i18n.localize(labelKey));
    el.innerHTML = `<i class="${icon}"></i>`;
    el.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
    col.appendChild(el);
  };

  add('fa-solid fa-star', 'CHRONICLE.Npc.Spotlight', () => _spotlight(token));
  const talking = isTalkLive(token.document.getFlag(FLAG_SCOPE, TALK_FLAG), Date.now());
  add('fa-solid fa-comment-dots', talking ? 'CHRONICLE.Npc.TalkStop' : 'CHRONICLE.Npc.Talk',
    () => { _toggleTalk(token).then(() => hud.render?.()); }, talking);
  const page = _tokenPage(token.document);
  if (page) add('fa-solid fa-book-open', 'CHRONICLE.Npc.OpenPage', () => page.journal.sheet?.render({ force: true }));
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
