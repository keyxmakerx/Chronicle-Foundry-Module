/**
 * Chronicle Sync - Player notebook and jot notes
 *
 * Every user (players and GM) gets a Notebook button in the Chronicle
 * scene controls and a small "Jot notes" tab in the bottom-right corner;
 * the player can drag the tab and the jot panel anywhere.
 * Both show the player's own Chronicle notes in a frame of Chronicle's
 * own pages, so the notebook is the site's Journal with nothing copied
 * into Foundry documents.
 *
 * The first use opens Chronicle's Allow window; the token it hands back is
 * the player's own (see _notes-grant.mjs for the checks) and is kept in
 * client scope only. Nothing here uses the GM's sync key.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { getSetting, getUserMappings } from './settings.mjs';
import {
  allowUrl,
  checkGrantMessage,
  chronicleOrigin,
  embedUrl,
  frameMessage,
  PageTracker,
  usableGrant,
  withGrant,
} from './_notes-grant.mjs';
import {
  clampBox,
  panelBesideTab,
  parsePlacement,
  pastThreshold,
  withPlacement,
} from './_jot-placement.mjs';

const { ApplicationV2 } = foundry.applications.api;

const t = (key) => game.i18n.localize(`CHRONICLE.Notebook.${key}`);

const pages = new PageTracker();

/** @type {NotebookApplication|null} */
let notebook = null;

/** @type {FrameHost|null} the jot panel's frame, made on first open */
let jotHost = null;

/** The world's Chronicle details, or null when the GM hasn't set them. */
function chronicle() {
  const apiUrl = getSetting('apiUrl');
  const campaignId = getSetting('campaignId');
  const apiOrigin = chronicleOrigin(apiUrl);
  if (!apiOrigin || !campaignId) return null;
  return {
    apiUrl,
    campaignId,
    apiOrigin,
    foundryUserId: game.user.id,
    mappings: getUserMappings(),
  };
}

/** Whether the notebook can be offered in this world at all. */
export function notebookAvailable() {
  return !!chronicle();
}

function storedGrant(ctx) {
  return usableGrant(getSetting('notesGrants'), ctx);
}

async function storeGrant(ctx, grant) {
  const next = withGrant(getSetting('notesGrants'), ctx.foundryUserId, ctx.apiOrigin, grant);
  await game.settings.set(MODULE_ID, 'notesGrants', next);
}

/**
 * Get this player's grant, asking Chronicle for one when there is none.
 * Must start from a click: it may open the Allow window, which browsers
 * only allow in response to one.
 * @returns {Promise<{token: string}|null>}
 */
function connect(ctx) {
  const have = storedGrant(ctx);
  if (have) return Promise.resolve(have);

  const popup = window.open(
    allowUrl(ctx.apiUrl, ctx.campaignId, window.location.origin),
    'chronicle-notes-allow',
    'width=480,height=640',
  );
  if (!popup) {
    ui.notifications.warn(t('PopupBlocked'));
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(watch);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== popup) return;
      const r = checkGrantMessage(event, ctx);
      if (r.kind === 'ignore') return;
      if (r.kind === 'declined') return finish(null);
      if (r.kind === 'refused') {
        ui.notifications.warn(t(`Refused.${r.reason}`), { permanent: true });
        return finish(null);
      }
      storeGrant(ctx, r.grant).then(() => finish(r.grant), () => finish(r.grant));
    };
    // Closing the window without answering is a "not now".
    const watch = setInterval(() => { if (popup.closed) finish(null); }, 500);
    window.addEventListener('message', onMessage);
  });
}

/**
 * One frame of Chronicle's notes pages. It hands the frame the token when
 * the frame says it is ready, and offers a Reconnect button when Chronicle
 * stops accepting the token.
 */
class FrameHost {
  /**
   * @param {'journal'|'jots'} mode
   * @param {HTMLElement} container
   */
  constructor(mode, container) {
    this.mode = mode;
    this.container = container;
    this.ctx = chronicle();
    this.frame = null;
    this.entityId = '';
    this.noteId = '';
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  /** Show the frame if this player is connected, otherwise the Connect button. */
  start() {
    this.ctx = chronicle();
    if (!this.ctx) return this._showMessage(t('NotSetUp'), false);
    if (!storedGrant(this.ctx)) return this._showMessage(t('NotConnected'), true);
    this._showFrame();
  }

  destroy() {
    window.removeEventListener('message', this._onMessage);
    this.container.replaceChildren();
    this.frame = null;
  }

  /** The Chronicle page in view changed (jots only). */
  setPage(entityId) {
    if (entityId === this.entityId) return;
    this.entityId = entityId;
    this._post({ type: 'chronicle:jots-page', entityId });
  }

  /** Show one note (notebook only). */
  openNote(noteId) {
    this.noteId = noteId;
    this._post({ type: 'chronicle:open-note', noteId });
  }

  _showFrame() {
    const frame = document.createElement('iframe');
    frame.className = 'chronicle-notes-frame';
    frame.src = embedUrl(this.ctx.apiUrl, this.ctx.campaignId, this.mode);
    frame.title = this.mode === 'jots' ? t('JotsTitle') : t('Title');
    this.container.replaceChildren(frame);
    this.frame = frame;
  }

  _showMessage(text, offerConnect) {
    this.frame = null;
    const box = document.createElement('div');
    box.className = 'chronicle-notes-message';
    const p = document.createElement('p');
    p.textContent = text;
    box.append(p);
    if (offerConnect) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t('Connect');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const grant = await connect(this.ctx);
        btn.disabled = false;
        if (grant) this._showFrame();
      });
      box.append(btn);
    }
    this.container.replaceChildren(box);
  }

  _post(msg) {
    const win = this.frame?.contentWindow;
    if (!win || !this.ctx) return;
    win.postMessage(msg, this.ctx.apiOrigin);
  }

  _onMessage(event) {
    if (!this.ctx) return;
    const d = frameMessage(event, this.frame?.contentWindow, this.ctx.apiOrigin);
    if (!d) return;
    // The GM may have changed the member matching since the window opened.
    this.ctx = chronicle() || this.ctx;
    if (d.type === 'chronicle:embed-ready') {
      const grant = storedGrant(this.ctx);
      if (!grant) return this._showMessage(t('NotConnected'), true);
      this._post({ type: 'chronicle:notes-token', token: grant.token, entityId: this.entityId });
      if (this.noteId) this._post({ type: 'chronicle:open-note', noteId: this.noteId });
    } else if (d.type === 'chronicle:grant-rejected') {
      storeGrant(this.ctx, null).catch(() => {});
      this._showMessage(t('Rejected'), true);
    } else if (d.type === 'chronicle:open-note' && typeof d.noteId === 'string' && d.noteId) {
      openNotebook(d.noteId);
    }
  }
}

/** The notebook window: the Chronicle Journal, filling it. */
class NotebookApplication extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-notebook',
    classes: ['chronicle-notebook'],
    window: { title: 'CHRONICLE.Notebook.Title', icon: 'fa-solid fa-book', resizable: true },
    position: { width: 760, height: 620 },
  };

  /** @override */
  async _renderHTML() {
    return null;
  }

  /** @override Make the frame once; a re-render must not reload it. */
  _replaceHTML(_result, content) {
    if (this.host) return;
    const box = document.createElement('div');
    box.className = 'chronicle-notes-host';
    content.replaceChildren(box);
    this.host = new FrameHost('journal', box);
    this.host.start();
  }

  /** @override */
  _onClose(options) {
    this.host?.destroy();
    this.host = null;
    super._onClose?.(options);
  }
}

/**
 * Open the notebook, connecting first if needed. Called from a click.
 * @param {string} [noteId] - a note to show
 */
export async function openNotebook(noteId = '') {
  const ctx = chronicle();
  if (!ctx) return ui.notifications.warn(t('NotSetUp'));
  if (!storedGrant(ctx) && !(await connect(ctx))) return;

  if (notebook?.rendered) {
    notebook.bringToFront?.();
  } else {
    notebook = new NotebookApplication();
    await notebook.render({ force: true });
  }
  if (noteId) notebook.host?.openNote(noteId);
}

/** Where the player dragged the tab and panel, if anywhere. */
function placement() {
  return parsePlacement(getSetting('jotPlacement'));
}

function savePlacement(part, pos) {
  const next = withPlacement(getSetting('jotPlacement'), part, pos);
  Promise.resolve(game.settings.set(MODULE_ID, 'jotPlacement', next)).catch(() => {});
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Pin a box at a spot, kept fully on screen. */
function moveTo(el, pos) {
  const rect = el.getBoundingClientRect();
  const at = clampBox(pos, { width: rect.width, height: rect.height }, viewport());
  el.style.left = `${at.left}px`;
  el.style.top = `${at.top}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  return at;
}

/**
 * Let a press on `handle` drag `box` around the screen. A press that barely
 * moves stays a click. Pointer capture alone doesn't stop a frame from
 * another site taking the pointer, so frames ignore it while dragging.
 * @returns {() => boolean} whether the last press was a drag (to skip its click)
 */
function dragToMove(handle, box, onMoved) {
  let start = null;
  let dragged = false;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.chronicle-jot-close')) return;
    const rect = box.getBoundingClientRect();
    start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, id: event.pointerId };
    dragged = false;
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragged && !pastThreshold(dx, dy)) return;
    dragged = true;
    document.body.classList.add('chronicle-jot-dragging');
    moveTo(box, { left: start.left + dx, top: start.top + dy });
  });
  const end = (event) => {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    handle.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove('chronicle-jot-dragging');
    if (dragged) {
      const rect = box.getBoundingClientRect();
      onMoved({ left: rect.left, top: rect.top });
    }
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  return () => {
    const was = dragged;
    dragged = false;
    return was;
  };
}

/**
 * Put the tab where the player left it, or just left of the right-hand
 * sidebar until they move it; keep a moved panel on screen.
 */
function placeJotTab() {
  const tab = document.getElementById('chronicle-jot-tab');
  if (!tab) return;
  const saved = placement();
  if (saved.tab) {
    moveTo(tab, saved.tab);
  } else {
    const right = document.getElementById('ui-right') || document.getElementById('sidebar');
    const rect = right?.getBoundingClientRect?.();
    const gap = rect && rect.width ? Math.max(8, window.innerWidth - rect.left + 8) : 8;
    document.documentElement.style.setProperty('--chronicle-jot-right', `${gap}px`);
  }
  const panel = document.getElementById('chronicle-jot-panel');
  if (panel && !panel.hidden && saved.panel) moveTo(panel, saved.panel);
}

/** Show the panel where it was left, or beside the tab when never moved. */
function placeJotPanel(panel, tab) {
  const saved = placement().panel;
  if (saved) {
    moveTo(panel, saved);
    return;
  }
  const rect = panel.getBoundingClientRect();
  const at = panelBesideTab(tab.getBoundingClientRect(), { width: rect.width, height: rect.height }, viewport());
  moveTo(panel, at);
}

function closeJots() {
  const panel = document.getElementById('chronicle-jot-panel');
  const tab = document.getElementById('chronicle-jot-tab');
  if (!panel || !tab) return;
  panel.hidden = true;
  tab.setAttribute('aria-expanded', 'false');
}

/** Open or close the jot panel. Called from a click on the tab. */
async function toggleJots() {
  const panel = document.getElementById('chronicle-jot-panel');
  const tab = document.getElementById('chronicle-jot-tab');
  if (!panel || !tab) return;
  if (!panel.hidden) {
    closeJots();
    return;
  }
  const ctx = chronicle();
  if (!ctx) return ui.notifications.warn(t('NotSetUp'));
  if (!storedGrant(ctx) && !(await connect(ctx))) return;
  panel.hidden = false;
  placeJotPanel(panel, tab);
  tab.setAttribute('aria-expanded', 'true');
  if (!jotHost) {
    jotHost = new FrameHost('jots', panel.querySelector('.chronicle-notes-host'));
    jotHost.entityId = pages.current();
    jotHost.start();
  } else if (!jotHost.frame) {
    jotHost.start();
  }
}

function buildJotTab() {
  if (document.getElementById('chronicle-jot-tab')) return;

  const panel = document.createElement('section');
  panel.id = 'chronicle-jot-panel';
  panel.className = 'chronicle-jot-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', t('JotsTitle'));

  // A title bar to drag the panel by, like a Foundry window's.
  const header = document.createElement('header');
  header.className = 'chronicle-jot-header';
  header.title = t('DragToMove');
  const title = document.createElement('span');
  title.className = 'chronicle-jot-title';
  const titleIcon = document.createElement('i');
  titleIcon.className = 'fa-solid fa-pen';
  titleIcon.setAttribute('aria-hidden', 'true');
  title.append(titleIcon, ` ${t('JotsTitle')}`);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'chronicle-jot-close';
  close.setAttribute('aria-label', t('Close'));
  close.title = t('Close');
  const closeIcon = document.createElement('i');
  closeIcon.className = 'fa-solid fa-xmark';
  closeIcon.setAttribute('aria-hidden', 'true');
  close.append(closeIcon);
  close.addEventListener('click', closeJots);
  header.append(title, close);

  const host = document.createElement('div');
  host.className = 'chronicle-notes-host';
  panel.append(header, host);
  dragToMove(header, panel, (pos) => savePlacement('panel', pos));

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.id = 'chronicle-jot-tab';
  tab.className = 'chronicle-jot-tab';
  tab.title = t('TabHint');
  tab.setAttribute('aria-expanded', 'false');
  tab.setAttribute('aria-controls', panel.id);
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-pen';
  icon.setAttribute('aria-hidden', 'true');
  tab.append(icon, ` ${t('JotsTitle')}`);
  const wasDrag = dragToMove(tab, tab, (pos) => savePlacement('tab', pos));
  tab.addEventListener('click', () => {
    if (wasDrag()) return;
    toggleJots();
  });

  document.body.append(panel, tab);
  placeJotTab();
}

/** The Chronicle entity a sheet shows, if it is linked to one. */
function sheetEntity(app) {
  const doc = app?.document ?? app?.object;
  if (!doc?.getFlag) return '';
  const own = doc.getFlag(FLAG_SCOPE, 'entityId');
  if (own) return own;
  // A journal page belongs to its journal's Chronicle page.
  return doc.parent?.getFlag?.(FLAG_SCOPE, 'entityId') ?? '';
}

function appKey(app) {
  return String(app?.id ?? app?.appId ?? '');
}

function onSheetRender(app) {
  pages.opened(appKey(app), sheetEntity(app));
  jotHost?.setPage(pages.current());
}

function onSheetClose(app) {
  pages.closed(appKey(app));
  jotHost?.setPage(pages.current());
}

/**
 * Add the jot tab and follow which Chronicle page is open. Called once at
 * ready, for every user, when the world is connected to Chronicle.
 */
export function registerPlayerNotebook() {
  if (!notebookAvailable()) return;
  buildJotTab();
  window.addEventListener('resize', placeJotTab);
  Hooks.on('collapseSidebar', () => requestAnimationFrame(placeJotTab));
  Hooks.on('renderSidebar', () => requestAnimationFrame(placeJotTab));
  // Hooks fire for every class a sheet inherits from, so these two pairs
  // cover all actor, item and journal sheets in v12 (V1) and v13+ (V2).
  for (const cls of ['DocumentSheet', 'DocumentSheetV2']) {
    Hooks.on(`render${cls}`, onSheetRender);
    Hooks.on(`close${cls}`, onSheetClose);
  }
}
