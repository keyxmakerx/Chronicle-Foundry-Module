/**
 * Chronicle Sync - Satchel
 *
 * The player's own things in one window: the notebook (Chronicle's Journal
 * in a frame), the quest board and their character's stash. Each tab is the
 * module's existing window drawn inside the Satchel rather than a copy of
 * it, so the board's live refresh, the stash's moves and the notebook's
 * Connect step all keep working unchanged. Tabs load the first time they are
 * shown. Every user gets one; the GM's Stash tab points at the DM Screen.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { stateBlock } from './_state-block.mjs';
import { FrameHost } from './player-notebook.mjs';
import { QuestBoardWindow, QuestSheetWindow } from './quest-board.mjs';
import { StashesWindow } from './stash-window.mjs';
import { canOpenStashes, stashesAvailable } from './stash-client.mjs';
import { satchelTab, SATCHEL_TABS, stashActor } from './_satchel.mjs';

const { ApplicationV2 } = foundry.applications.api;

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.Satchel.${key}`, data)
  : game.i18n.localize(`CHRONICLE.Satchel.${key}`));

/**
 * A window class drawn into an element of the Satchel instead of its own
 * frame: no title bar, no position of its own, and its element goes into
 * `pane`. Its actions, renders and closing are its own as before.
 */
function hosted(Base) {
  return class extends Base {
    static DEFAULT_OPTIONS = { window: { frame: false, positioned: false } };

    /** @type {HTMLElement|null} where this window draws */
    pane = null;

    /** @type {SatchelWindow|null} */
    satchel = null;

    /** @override */
    _insertElement(element) {
      this.pane?.replaceChildren(element);
    }
  };
}

/** Make a hosted window that draws into `pane`. */
function inPane(HostedClass, args, pane, satchelWin) {
  const win = new HostedClass(...args);
  win.pane = pane;
  win.satchel = satchelWin;
  return win;
}

const HostedBoard = class extends hosted(QuestBoardWindow) {
  /** @override A notice opens in the Satchel, with a way back to the board. */
  openQuest(id) {
    this.satchel?.showQuest(id);
  }
};
const HostedSheet = hosted(QuestSheetWindow);
const HostedStash = hosted(StashesWindow);

/** The last tab shown, so reopening the Satchel lands where the player left. */
let lastTab = 'notebook';

/** @type {SatchelWindow|null} */
let satchel = null;

class SatchelWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-satchel',
    classes: ['chronicle-satchel'],
    window: { title: 'CHRONICLE.Satchel.Title', icon: 'fa-solid fa-briefcase', resizable: true },
    position: { width: 760, height: 640 },
  };

  constructor(options = {}) {
    super(options);
    this.tab = lastTab;
    /** @type {Record<string, HTMLElement>} */
    this._panes = {};
    this._notebook = null;
    this._board = null;
    this._sheet = null;
    this._stash = null;
  }

  /** @override */
  async _renderHTML() {
    return null;
  }

  /** @override Build the tabs once; a re-render must not reload the frame. */
  _replaceHTML(_result, content) {
    if (this._root) return;
    const root = document.createElement('div');
    root.className = 'cs-satchel';
    const bar = document.createElement('div');
    bar.className = 'cs-seg cs-satchel-tabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', t('Title'));
    root.append(bar);
    for (const tab of SATCHEL_TABS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.id = `${this.id}-tab-${tab}`;
      btn.dataset.satchelTab = tab;
      btn.textContent = t(`Tab.${tab}`);
      btn.addEventListener('click', () => this.show(tab));
      bar.append(btn);
      const pane = document.createElement('div');
      pane.className = `cs-satchel-pane cs-satchel-${tab}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', btn.id);
      pane.hidden = true;
      root.append(pane);
      this._panes[tab] = pane;
    }
    content.replaceChildren(root);
    this._root = root;
    this.show(this.tab);
  }

  /** Show one tab, loading it the first time. */
  show(tab, { noteId = '' } = {}) {
    this.tab = satchelTab(tab);
    lastTab = this.tab;
    if (!this._root) return;
    for (const btn of this._root.querySelectorAll('[data-satchel-tab]')) {
      const on = btn.dataset.satchelTab === this.tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    for (const [name, pane] of Object.entries(this._panes)) pane.hidden = name !== this.tab;
    if (this.tab === 'notebook') this._showNotebook(noteId);
    else if (this.tab === 'quests' && !this._board && !this._sheet) this._showBoard();
    else if (this.tab === 'stash' && !this._stash) this._showStash();
  }

  _showNotebook(noteId) {
    if (!this._notebook) {
      const box = document.createElement('div');
      box.className = 'chronicle-notes-host';
      this._panes.notebook.replaceChildren(box);
      this._notebook = new FrameHost('journal', box);
      this._notebook.start();
    }
    if (noteId) this._notebook.openNote(noteId);
  }

  _showBoard() {
    this._closeSheet();
    this._board = inPane(HostedBoard, [{ id: `${this.id}-board` }], this._panes.quests, this);
    this._board.render({ force: true });
  }

  /** Open one quest in place of the board, with a Back button above it. */
  showQuest(questId) {
    const pane = this._panes.quests;
    this._board?.close();
    this._board = null;
    this._closeSheet();
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'cs-satchel-back';
    back.textContent = t('BackToBoard');
    back.addEventListener('click', () => this._showBoard());
    const holder = document.createElement('div');
    pane.replaceChildren(back, holder);
    this._sheet = inPane(HostedSheet, [questId, { id: `${this.id}-quest` }], holder, this);
    this._sheet.render({ force: true });
    this.show('quests');
  }

  _closeSheet() {
    this._sheet?.close();
    this._sheet = null;
  }

  async _showStash() {
    const pane = this._panes.stash;
    const message = (icon, key) => pane.replaceChildren(stateBlock(icon, t(`${key}Title`), t(key)));
    if (game.user.isGM) return message('box-open', 'StashGM');
    if (!stashesAvailable()) return message('box-open', 'StashOff');
    const actor = stashActor(game.user, game.actors?.contents ?? [], {
      linked: (a) => !!a.getFlag(FLAG_SCOPE, 'entityId'),
      allowed: canOpenStashes,
    });
    if (!actor) return message('user', 'StashNoCharacter');
    this._stash = inPane(HostedStash, [actor, { id: `${this.id}-stash` }], pane, this);
    await this._stash.render({ force: true });
    this._stash.load();
  }

  /** @override */
  _onClose(options) {
    this._notebook?.destroy();
    this._notebook = null;
    for (const child of [this._board, this._sheet, this._stash]) child?.close();
    this._board = null;
    this._sheet = null;
    this._stash = null;
    this._root = null;
    if (satchel === this) satchel = null;
    super._onClose?.(options);
  }
}

/**
 * Open the Satchel, or bring it forward, on a tab.
 * @param {string} [tab] - notebook, quests or stash; the last one shown when left out
 * @param {{noteId?: string}} [opts] - a note to show in the notebook
 */
export async function openSatchel(tab, { noteId = '' } = {}) {
  if (satchel?.rendered) {
    satchel.bringToFront?.();
    satchel.show(tab ?? satchel.tab, { noteId });
    return satchel;
  }
  if (tab) lastTab = satchelTab(tab);
  satchel = new SatchelWindow();
  await satchel.render({ force: true });
  if (noteId) satchel.show('notebook', { noteId });
  return satchel;
}
