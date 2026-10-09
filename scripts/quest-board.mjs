/**
 * Chronicle Sync - Quest Board
 *
 * Chronicle's quest boards in a Foundry window: the boards of a category
 * (the Quests category's own) or of a place page, with each notice opening
 * its quest as a paper sheet. The GM's sheet carries the ledger: tick steps,
 * choose which steps players see, set the status and hand out rewards.
 * Pinning and arranging stay on Chronicle's page.
 *
 * The GM reads Chronicle with the sync key. Players have no key, so their
 * windows ask the active GM's client, which answers with Chronicle's players
 * view (_quest-relay.mjs). Changes in Chronicle arrive as quest.updated and
 * notice_boards.updated; open windows refetch, and the GM's client tells
 * players' windows to refetch too, without saying what changed.
 *
 * Nothing here is copied into Foundry documents.
 */

import { getSetting } from './settings.mjs';
import { MODULE_ID, FLAG_SCOPE } from './constants.mjs';
import {
  homeOptions, parseHomeKey, boardModel, sheetModel, handOutPlan, payReason,
  shareHundredths, fmtShare, stepsWith, unwrapList, STATUSES, statusLabel, setQuestWords,
} from './_quest-view.mjs';
import {
  QUEST_MESSAGE, sanitizeQuestRequest, questRequestPath, relayStatus, isQuestId, makeAskLimiter,
} from './_quest-relay.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const REQUEST_TIMEOUT_MS = 12000;
const REFRESH_DEBOUNCE_MS = 400;

const t = (key) => game.i18n.localize(`CHRONICLE.Quests.${key}`);
const tf = (key, data) => game.i18n.format(`CHRONICLE.Quests.${key}`, data);

/** @type {() => import('./api-client.mjs').ChronicleAPI|null} */
let getApi = () => null;
/** Requests this player is waiting on: requestId → resolve. */
const pending = new Map();
/** Hand-out steps that went through, per quest, for this session. */
const handOutDone = new Map();
const askLimit = makeAskLimiter();
/** Open windows, refreshed on live changes. */
const open = new Set();

function errorText(err) {
  switch (err?.status) {
    case 403: return t('Error.NotAllowed');
    case 404: return t('Error.NeedsUpdate');
    case 503: return t('Error.NoGM');
    case 504: return t('Error.NoAnswer');
    default: return t('Error.Failed');
  }
}

// ---------- Data: the GM reads Chronicle, a player asks the GM ----------

function gmApi() {
  const api = getApi();
  if (!api || !getSetting('apiUrl') || !getSetting('campaignId') || !getSetting('apiKey')) {
    const err = new Error('not set up');
    err.status = 403;
    throw err;
  }
  return api;
}

/** Named home options for a homes answer; categories are named from Chronicle's type list. */
async function namedHomes(api, path) {
  const [homes, types] = await Promise.all([api.get(path), api.get('/entity-types').catch(() => [])]);
  return homeOptions(homes, types);
}

/** Player side: one question to the active GM's client. */
function askGM(req) {
  if (!game.users.activeGM) return Promise.reject(Object.assign(new Error('no GM'), { status: 503 }));
  const requestId = foundry.utils.randomID(16);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error('no answer'), { status: 504 }));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, (reply) => {
      clearTimeout(timer);
      pending.delete(requestId);
      if (reply.status >= 400) reject(Object.assign(new Error('refused'), { status: reply.status }));
      else resolve(reply.body);
    });
    game.socket.emit(SOCKET_CHANNEL, { type: QUEST_MESSAGE, action: 'ask', requestId, userId: game.user.id, ...req });
  });
}

const source = {
  homes() {
    if (game.user.isGM) return namedHomes(gmApi(), '/quests/homes');
    return askGM({ what: 'homes' });
  },
  boards(home) {
    if (game.user.isGM) return gmApi().get(`/quests/boards?${home.kind}=${encodeURIComponent(home.id)}`);
    return askGM({ what: 'boards', kind: home.kind, id: home.id });
  },
  quest(id) {
    if (game.user.isGM) return gmApi().get(`/quests/${encodeURIComponent(id)}`);
    return askGM({ what: 'quest', id });
  },
};

// ---------- Windows ----------

/** @type {QuestBoardWindow|null} */
let boardWin = null;
/** @type {Map<string, QuestSheetWindow>} */
const sheets = new Map();

/** Open the Quest Board, or bring it forward. */
export function openQuestBoard() {
  if (boardWin?.rendered) {
    boardWin.bringToFront?.();
    return;
  }
  boardWin = new QuestBoardWindow();
  boardWin.render({ force: true });
}

/** Open one quest's sheet, or bring it forward. */
export function openQuestSheet(questId) {
  if (!isQuestId(questId)) return;
  const have = sheets.get(questId);
  if (have?.rendered) {
    have.bringToFront?.();
    return;
  }
  const win = new QuestSheetWindow(questId);
  sheets.set(questId, win);
  win.render({ force: true });
}

class QuestBoardWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-quest-board',
    classes: ['chronicle-quests'],
    window: { title: 'CHRONICLE.Quests.BoardTitle', icon: 'fa-solid fa-thumbtack', resizable: true },
    position: { width: 760, height: 'auto' },
    actions: {
      prevBoard: QuestBoardWindow._onPrev,
      nextBoard: QuestBoardWindow._onNext,
      openQuest: QuestBoardWindow._onOpenQuest,
      retry: QuestBoardWindow._onRetry,
    },
  };

  static PARTS = { board: { template: 'modules/chronicle-sync/templates/quest-board.hbs' } };

  constructor() {
    super();
    this._options = null;
    this._homeKey = '';
    this._view = null;
    this._boardIx = 0;
    this._error = '';
    this._loading = false;
  }

  async _load({ homes = false } = {}) {
    try {
      if (homes || !this._options) {
        this._options = await source.homes();
        if (!this._options.some((o) => o.key === this._homeKey)) this._homeKey = this._options[0]?.key || '';
      }
      const home = parseHomeKey(this._homeKey);
      this._view = home ? await source.boards(home) : null;
      this._error = '';
    } catch (err) {
      this._error = errorText(err);
    }
  }

  /** Refetch what is shown; called on live changes. */
  async refresh() {
    await this._load({ homes: true });
    if (this.rendered) this.render();
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this._options && !this._error) await this._load();
    const boards = Array.isArray(this._view?.boards) ? this._view.boards : [];
    if (this._boardIx >= boards.length) this._boardIx = 0;
    const home = parseHomeKey(this._homeKey);
    const apiUrl = String(getSetting('apiUrl') || '').replace(/\/+$/, '');
    const look = this._view?.looks?.board;
    return {
      ...context,
      appId: this.id,
      error: this._error,
      options: this._options || [],
      homeKey: this._homeKey,
      noHomes: !this._error && (!this._options?.length || !boards.length),
      board: boards.length ? boardModel(boards[this._boardIx], { isGM: game.user.isGM, apiUrl }) : null,
      many: boards.length > 1,
      dots: boards.map((_, i) => i === this._boardIx),
      look: ['lit', 'plain', 'parchment', 'midnight'].includes(look) ? look : 'lit',
      editUrl: game.user.isGM && home?.kind === 'page' && apiUrl
        ? `${apiUrl}/campaigns/${encodeURIComponent(getSetting('campaignId'))}/entities/${encodeURIComponent(home.id)}` : '',
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    open.add(this);
    const root = this.element.querySelector('[data-cqb-root]');
    root?.querySelector('[data-cqb-home]')?.addEventListener('change', async (e) => {
      this._homeKey = e.target.value;
      this._boardIx = 0;
      await this._load();
      this.render();
    });
    // A picture that will not load shows the initial instead.
    root?.querySelectorAll('[data-cqb-img]').forEach((img) => img.addEventListener('error', () => {
      const photo = img.parentElement;
      img.remove();
      photo?.querySelector('.cqb-initial')?.removeAttribute('hidden');
    }, { once: true }));
    if (context.board) requestAnimationFrame(() => drawStrings(root, context.board.strings));
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    open.delete(this);
    if (boardWin === this) boardWin = null;
  }

  static _onPrev() { this._turn(-1); }
  static _onNext() { this._turn(1); }
  _turn(d) {
    const n = this._view?.boards?.length || 0;
    if (n < 2) return;
    this._boardIx = (this._boardIx + d + n) % n;
    this.render();
  }

  static _onOpenQuest(event, target) {
    const id = target?.dataset?.quest;
    if (id) openQuestSheet(id);
    else ui.notifications.info(t('NoSheet'));
  }

  static async _onRetry() {
    this._error = '';
    this._options = null;
    this.render();
  }
}

/** Red string between two pins, drawn from where the pins actually sit. */
function drawStrings(root, strings) {
  const svg = root?.querySelector('[data-cqb-strings]');
  const cork = root?.querySelector('[data-cqb-cork]');
  if (!svg || !cork) return;
  const fr = cork.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, fr.width)} ${Math.max(1, fr.height)}`);
  const pt = (id) => {
    const el = cork.querySelector(`[data-id="${CSS.escape(id)}"] .cqb-tack`);
    const r = el?.getBoundingClientRect();
    return r ? [r.left + r.width / 2 - fr.left, r.top + r.height / 2 - fr.top] : null;
  };
  const ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  for (const s of strings) {
    const a = pt(s.from);
    const b = pt(s.to);
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M${a[0]} ${a[1]} Q${(a[0] + b[0]) / 2} ${(a[1] + b[1]) / 2 + Math.min(40, len * 0.12)} ${b[0]} ${b[1]}`);
    svg.append(path);
  }
}

class QuestSheetWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ['chronicle-quests', 'chronicle-quest-sheet'],
    window: { title: 'CHRONICLE.Quests.SheetTitle', icon: 'fa-solid fa-scroll', resizable: true },
    position: { width: 420, height: 'auto' },
    actions: {
      toggleShown: QuestSheetWindow._onToggleShown,
      openGive: QuestSheetWindow._onOpenGive,
      closeGive: QuestSheetWindow._onCloseGive,
      runGive: QuestSheetWindow._onRunGive,
      retry: QuestSheetWindow._onRetry,
    },
  };

  static PARTS = { sheet: { template: 'modules/chronicle-sync/templates/quest-sheet.hbs' } };

  constructor(questId) {
    super({ id: `chronicle-quest-${questId}` });
    this._questId = questId;
    this._view = null;
    this._error = '';
    this._busy = false;
    /** The hand-out panel's state while open. */
    this._give = null;
    // Done keys outlive the window, so reopening the sheet after a failed
    // save never pays anyone twice.
    if (!handOutDone.has(questId)) handOutDone.set(questId, new Set());
    this._done = handOutDone.get(questId);
  }

  /** @override */
  get title() {
    return this._view?.notice?.title || t('SheetTitle');
  }

  async _load() {
    try {
      this._view = await source.quest(this._questId);
      this._error = '';
    } catch (err) {
      this._error = errorText(err);
    }
  }

  /** Refetch on a live change, unless the GM is part-way through a hand-out. */
  async refresh() {
    if (this._busy || this._give) return;
    await this._load();
    if (this.rendered) this.render();
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this._view && !this._error) await this._load();
    const isGM = game.user.isGM;
    const sheet = this._view ? sheetModel(this._view, { isGM }) : null;
    return {
      ...context,
      appId: this.id,
      error: this._error,
      loading: !this._view && !this._error,
      isGM,
      busy: this._busy,
      sheet,
      statuses: STATUSES.map((s) => ({ value: s, label: statusLabel(s), selected: sheet?.statusValue === s })),
      canHandOut: !!sheet && !sheet.handedOut && (sheet.rewards || []).some((r) => (r.kind === 'money' && r.amount != null) || (r.kind === 'item' && r.itemId)),
      give: this._give ? this._giveContext(sheet) : null,
    };
  }

  _giveContext(sheet) {
    const g = this._give;
    const rewards = sheet?.rewards || [];
    const money = rewards.filter((r) => r.kind === 'money' && r.amount != null);
    const items = rewards.filter((r) => r.kind === 'item' && r.itemId);
    const party = (g.party || []).map((c) => {
      const paid = money.length > 0 && money.every((r) => this._done.has(`pay:${r.id}:${c.id}`));
      const failed = g.failed?.characterId === c.id;
      return {
        ...c, picked: g.coinTo.has(c.id),
        state: failed ? t('PayFailed') : paid ? t('Paid') : '',
        stateClass: failed ? 'cqs-bad' : paid ? 'cqs-ok' : '',
      };
    });
    const n = party.filter((c) => c.picked).length;
    const each = money.map((r) => shareHundredths(r.amount, n)).reduce((a, b) => a + b, 0);
    return {
      loading: !g.party,
      party,
      coins: money.length > 0,
      coinLine: n ? tf('CoinsEach', { amount: fmtShare(each) }) : t('NobodyPicked'),
      items: items.map((r) => ({ id: r.id, label: tf('ItemGoesTo', { item: r.text }), to: g.itemTo[r.id] ?? '' })),
      markDone: g.markDone,
      sending: this._busy,
      note: g.note || '',
      noteClass: g.noteClass || '',
      okLabel: g.retry ? t('HandOutAgain') : t('HandOut'),
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    open.add(this);
    const root = this.element.querySelector('[data-cqs-root]');
    if (!root) return;
    root.querySelectorAll('[data-cqs-step]').forEach((box) => box.addEventListener('change', () => {
      this._saveStep(Number(box.dataset.cqsStep), 'done', box.checked);
    }));
    root.querySelector('[data-cqs-status]')?.addEventListener('change', (e) => this._save({ status: e.target.value }));
    root.querySelectorAll('[data-cqs-coin]').forEach((box) => box.addEventListener('change', () => {
      if (box.checked) this._give?.coinTo.add(box.dataset.cqsCoin);
      else this._give?.coinTo.delete(box.dataset.cqsCoin);
      this.render();
    }));
    root.querySelectorAll('[data-cqs-item]').forEach((sel) => sel.addEventListener('change', () => {
      if (this._give) this._give.itemTo[sel.dataset.cqsItem] = sel.value;
    }));
    root.querySelector('[data-cqs-markdone]')?.addEventListener('change', (e) => {
      if (this._give) this._give.markDone = e.target.checked;
    });
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    open.delete(this);
    if (sheets.get(this._questId) === this) sheets.delete(this._questId);
  }

  /**
   * One partial quest write. Chronicle answers with the new DM view; a
   * version clash means someone else saved first, so the sheet reloads.
   */
  async _save(patch) {
    if (!game.user.isGM || this._busy || !this._view) return false;
    this._busy = true;
    this.render();
    try {
      this._view = await gmApi().put(`/quests/${encodeURIComponent(this._questId)}`, { version: this._view.version, ...patch });
      return true;
    } catch (err) {
      if (err?.status === 409) {
        ui.notifications.warn(t('Conflict'));
        await this._load();
      } else {
        ui.notifications.error(errorText(err));
      }
      return false;
    } finally {
      this._busy = false;
      this.render();
    }
  }

  _saveStep(index, field, value) {
    return this._save({ steps: stepsWith(this._view?.steps, index, field, value) });
  }

  static _onToggleShown(event, target) {
    const i = Number(target?.dataset?.index);
    const step = this._view?.steps?.[i];
    if (!step) return;
    this._saveStep(i, 'shown', !step.shown);
  }

  static async _onOpenGive() {
    if (!game.user.isGM) return;
    const items = (this._view?.rewards || []).filter((r) => r.kind === 'item' && r.entityId);
    this._give = { party: null, coinTo: new Set(), itemTo: {}, markDone: this._view?.status !== 'done' };
    this.render();
    try {
      const party = unwrapList(await gmApi().get('/quests/party'))
        .filter((c) => typeof c?.id === 'string')
        .map((c) => ({ id: c.id, name: c.name || '?', player: c.player || '' }));
      if (!this._give) return;
      this._give.party = party;
      this._give.coinTo = new Set(party.map((c) => c.id));
      for (const r of items) this._give.itemTo[r.id] = party[0]?.id || '';
    } catch (err) {
      this._give = null;
      ui.notifications.error(errorText(err));
    }
    this.render();
  }

  static _onCloseGive() {
    if (this._busy) return;
    this._give = null;
    this.render();
  }

  /**
   * Run the hand-out one call at a time. A step that went through is
   * remembered, so pressing again after a failure never pays or gives
   * anything twice; Chronicle's own widget works the same way.
   */
  static async _onRunGive() {
    const g = this._give;
    if (!g?.party || this._busy) return;
    const sheet = sheetModel(this._view, { isGM: true });
    const steps = handOutPlan({
      rewards: sheet.rewards, party: g.party, coinTo: g.coinTo, itemTo: g.itemTo,
      done: this._done, reason: payReason(sheet.title),
    });
    this._busy = true;
    g.failed = null;
    g.note = '';
    this.render();
    const api = gmApi();
    const given = [];
    try {
      for (const st of steps) {
        if (st.done) continue;
        try {
          if (st.kind === 'pay') await api.post('/quests/pay', { characterId: st.characterId, amount: st.amount, reason: st.reason });
          else await api.post('/quests/give', { characterId: st.characterId, itemId: st.itemId });
        } catch (err) {
          g.failed = { characterId: st.characterId };
          throw err;
        }
        this._done.add(st.key);
        given.push(st.label);
      }
    } catch (err) {
      this._busy = false;
      g.retry = true;
      g.note = `${given.length ? tf('StoppedAfter', { n: given.length }) : ''} ${err?.serverMessage || errorText(err)} ${t('PressAgain')}`.trim();
      g.noteClass = 'cqs-bad';
      this.render();
      return;
    }
    this._busy = false;
    this._give = null;
    const patch = { handedOut: true };
    if (g.markDone) patch.status = 'done';
    await this._save(patch);
    ui.notifications.info(given.length ? tf('HandedOutList', { list: given.join(', ') }) : t('MarkedHandedOut'));
  }

  static async _onRetry() {
    this._error = '';
    this._view = null;
    this.render();
  }
}

// ---------- Live updates and the relay ----------

let refreshTimer = 0;

/** Refetch every open window once, after a burst of changes settles. */
function refreshOpen() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const win of open) win.refresh?.();
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * The SyncManager module for live quest changes (GM's client only; players
 * have no Chronicle socket). Chronicle's message names a page, which may be
 * hidden from players, so players are only told that something changed.
 */
export const questLive = {
  init() {},
  destroy() {},
  onMessage(msg) {
    if (msg?.type !== 'quest.updated' && msg?.type !== 'notice_boards.updated') return;
    refreshOpen();
    if (game.users.activeGM?.isSelf) game.socket.emit(SOCKET_CHANNEL, { type: QUEST_MESSAGE, action: 'changed' });
  },
};

/**
 * Set up the quest relay. The active GM answers players' questions with the
 * players view; a player takes answers and change notices from a GM only.
 * @param {() => import('./api-client.mjs').ChronicleAPI|null} apiGetter
 */
export function registerQuestBoard(apiGetter) {
  getApi = apiGetter;
  setQuestWords((key, data) => (data ? tf(key, data) : t(key)));
  game.socket.on(SOCKET_CHANNEL, (data, senderId) => {
    if (data?.type !== QUEST_MESSAGE) return;
    if (game.user.isGM) {
      if (data.action === 'ask') answerPlayer(data, senderId);
      return;
    }
    if (!game.users.get(senderId)?.isGM) return;
    if (data.action === 'changed') refreshOpen();
    else if (data.action === 'answer' && data.toUserId === game.user.id) pending.get(data.requestId)?.(data);
  });
  registerQuestJournalButton();
}

/** GM side: answer one player's question. Only the active GM answers. */
async function answerPlayer(data, senderId) {
  if (!game.users.activeGM?.isSelf) return;
  const req = sanitizeQuestRequest(data);
  const user = game.users.get(senderId);
  if (!req || !user || user.isGM || senderId !== data.userId || !askLimit(senderId)) return;
  const reply = (status, body) => game.socket.emit(SOCKET_CHANNEL, {
    type: QUEST_MESSAGE, action: 'answer', requestId: req.requestId, toUserId: senderId, status, body,
  });
  try {
    const api = gmApi();
    const path = questRequestPath(req);
    const body = req.what === 'homes' ? await namedHomes(api, path) : await api.get(path);
    reply(200, body);
  } catch (err) {
    reply(relayStatus(err), null);
  }
}

/**
 * Journals that came from a Chronicle quest page get an Open quest button,
 * for anyone who can see the journal.
 */
function registerQuestJournalButton() {
  const add = (app, html) => {
    const journal = app?.document;
    if (journal?.documentName !== 'JournalEntry') return;
    if (!/quest/i.test(String(journal.getFlag(FLAG_SCOPE, 'entityType') || ''))) return;
    const questId = journal.getFlag(FLAG_SCOPE, 'entityId');
    if (!questId || !journal.testUserPermission(game.user, 'OBSERVER')) return;
    const root = app.element instanceof HTMLElement ? app.element : app.element?.[0] ?? (html instanceof HTMLElement ? html : html?.[0]);
    const header = app.window?.header ?? root?.querySelector('.window-header');
    if (!header || header.querySelector('.chronicle-quest-open')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-control chronicle-quest-open';
    btn.innerHTML = '<i class="fa-solid fa-scroll"></i> ';
    btn.append(t('OpenQuest'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openQuestSheet(questId);
    });
    const close = app.window?.close ?? header.querySelector('[data-action="close"], a.close, .header-button.close');
    header.insertBefore(btn, close?.parentElement === header ? close : null);
  };
  Hooks.on('renderJournalEntrySheet', add);
  Hooks.on('renderJournalSheet', add);
}
