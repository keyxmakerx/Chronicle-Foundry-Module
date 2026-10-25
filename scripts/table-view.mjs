/**
 * "At this table" in the Journal tab (#258): search first, then the pages
 * tied to the scene on screen, recent and pinned pages, and every category
 * as a chip (`_table-view.mjs` decides the lists). It is drawn above
 * Foundry's own journal directory, which stays in place behind "All
 * folders", so dragging, folders and other modules' buttons keep working.
 * Every user; each sees only the journals they can read, and a player never
 * sees a page listed for a hidden token.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { REMOVED_FOLDER_FLAG } from './_set-aside.mjs';
import { isMapJournal } from './_journal-ownership.mjs';
import { isCalendarNoteJournal } from './calendar-sync.mjs';
import { LINK_FLAG } from './npc-presence.mjs';
import { escapeHtml } from './_escape-html.mjs';
import { GROUP_LIMIT, ONLY_FOUNDRY, SET_ASIDE, pushRecent, tableView, tokenPages } from './_table-view.mjs';

const t = (key, data) => (data ? game.i18n.format(`CHRONICLE.Table.${key}`, data) : game.i18n.localize(`CHRONICLE.Table.${key}`));

/** Per-user view state that isn't worth a setting: what is typed and the open chip. */
const state = { query: '', chip: '', expanded: new Set() };

function readList(key) {
  try {
    const v = JSON.parse(game.settings.get(MODULE_ID, key) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function inRemovedFolder(journal) {
  for (let f = journal.folder, i = 0; f && i < 20; f = f.folder, i++) {
    if (f.getFlag?.(FLAG_SCOPE, REMOVED_FOLDER_FLAG)) return true;
  }
  return false;
}

/** The journal as a plain row, or null when it isn't listed. */
function rowOf(j) {
  if (!j.visible) return null;
  if (j.getFlag(FLAG_SCOPE, 'problemReportsStore')) return null;
  const setAside = inRemovedFolder(j);
  let category = j.getFlag(FLAG_SCOPE, 'entityType') || '';
  if (!category && isMapJournal(j, FLAG_SCOPE)) category = t('Maps');
  if (!category && isCalendarNoteJournal(j)) category = t('CalendarNotes');
  const folder = j.folder && j.folder.name !== category && !setAside ? j.folder.name : '';
  const tags = (j.getFlag(FLAG_SCOPE, 'tags') || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  return { id: j.id, name: j.name, category, folder, entityId: j.getFlag(FLAG_SCOPE, 'entityId') || '', setAside, tags };
}

/** What the scene on screen ties to, for this user. */
function sceneInput() {
  const scene = globalThis.canvas?.scene;
  if (!scene) return null;
  const sj = scene.journal;
  const journalId = typeof sj === 'string' ? sj : sj?.id ?? null;
  const tokens = [];
  for (const td of scene.tokens ?? []) {
    const actor = td.actor;
    tokens.push({ entityId: actor?.getFlag?.(FLAG_SCOPE, 'entityId'), linkedEntityId: actor?.getFlag?.(FLAG_SCOPE, LINK_FLAG), hidden: td.hidden === true });
  }
  const noteJournalIds = [];
  for (const n of scene.notes ?? []) {
    const id = n.entryId ?? n.entry?.id;
    if (id) noteJournalIds.push(id);
  }
  return { name: scene.navName || scene.name, journalId, noteJournalIds, tokens: tokenPages(tokens, game.user.isGM) };
}

function whyText(why) {
  if (!why) return '';
  if (why.kind === 'scene') return t('WhyScene');
  if (why.kind === 'note') return t('WhyNote');
  return why.count > 1 ? t('WhyTokens', { n: why.count }) : t('WhyToken');
}

function chipLabel(c) {
  if (c.key === ONLY_FOUNDRY) return t('OnlyFoundry');
  if (c.key === SET_ASIDE) return t('SetAside');
  return c.label;
}

function rowHtml(r, pinned) {
  const isPinned = pinned.includes(r.id);
  const why = whyText(r.why);
  return `<li class="cs-tv-row" data-journal-id="${escapeHtml(r.id)}">
    <button type="button" class="cs-tv-open" data-cs-open="${escapeHtml(r.id)}">
      <span class="cs-tv-name">${escapeHtml(r.name)}</span>
      ${r.where ? `<span class="cs-tv-where">${escapeHtml(r.where)}</span>` : ''}
    </button>
    ${why ? `<span class="cs-tv-why">${escapeHtml(why)}</span>` : ''}
    <button type="button" class="cs-tv-pin${isPinned ? ' is-pinned' : ''}" data-cs-pin="${escapeHtml(r.id)}"
      aria-pressed="${isPinned}" aria-label="${escapeHtml(isPinned ? t('Unpin') : t('Pin'))}" title="${escapeHtml(isPinned ? t('Unpin') : t('Pin'))}">
      <i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>
  </li>`;
}

function groupHtml(key, title, sub, rows, pinned) {
  const open = state.expanded.has(key);
  const shown = open ? rows : rows.slice(0, GROUP_LIMIT);
  const more = rows.length - shown.length;
  return `<section class="cs-tv-group">
    <h3 class="cs-tv-cap">${escapeHtml(title)}${sub ? ` <small>${escapeHtml(sub)}</small>` : ''}</h3>
    <ol class="cs-tv-list">${shown.map((r) => rowHtml(r, pinned)).join('')}</ol>
    ${more > 0 ? `<button type="button" class="cs-tv-more" data-cs-more="${key}">${escapeHtml(t('ShowAll', { n: rows.length }))}</button>` : ''}
  </section>`;
}

function listHtml() {
  const pinned = readList('tablePinned');
  const journals = (game.journal?.contents ?? []).map(rowOf).filter(Boolean);
  const scene = sceneInput();
  const view = tableView({ journals, scene, recent: readList('tableRecent'), pinned, query: state.query, chip: state.chip });
  const parts = [];
  if (view.mode === 'search') {
    const g = view.groups[0];
    parts.push(g.total
      ? groupHtml('matches', t('Matches'), t(g.total === 1 ? 'OnePage' : 'Pages', { n: g.total }), g.rows, pinned)
      : `<p class="cs-tv-empty">${escapeHtml(t('NoMatch', { q: state.query.trim() }))}</p>`);
    return parts.join('');
  }
  if (view.mode === 'chip') {
    const chip = view.chips.find((c) => c.key === state.chip);
    const g = view.groups[0];
    parts.push(`<button type="button" class="cs-tv-back" data-cs-chip=""><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${escapeHtml(t('Back'))}</button>`);
    parts.push(g.total ? groupHtml('chip', chip ? chipLabel(chip) : state.chip, '', g.rows, pinned) : `<p class="cs-tv-empty">${escapeHtml(t('EmptyChip'))}</p>`);
    return parts.join('');
  }
  const titles = { scene: t('InScene'), recent: t('Recent'), pinned: t('Pinned') };
  for (const g of view.groups) parts.push(groupHtml(g.key, titles[g.key], g.key === 'scene' ? scene?.name : '', g.rows, pinned));
  if (!view.groups.length) parts.push(`<p class="cs-tv-empty">${escapeHtml(t('Nothing'))}</p>`);
  parts.push(`<section class="cs-tv-group"><h3 class="cs-tv-cap">${escapeHtml(t('Everything'))}</h3><div class="cs-tv-chips">
    ${view.chips.map((c) => `<button type="button" class="cs-tv-chip" data-cs-chip="${escapeHtml(c.key)}">${escapeHtml(chipLabel(c))} <span>${c.count}</span></button>`).join('')}
    <button type="button" class="cs-tv-chip cs-tv-folders" data-cs-folders="1"><i class="fa-solid fa-folder-tree" aria-hidden="true"></i> ${escapeHtml(t('AllFolders'))}</button>
  </div></section>`);
  return parts.join('');
}

function tableOn() {
  try {
    return game.settings.get(MODULE_ID, 'journalTabView') !== 'folders';
  } catch {
    return true;
  }
}

/** Draw or redraw the view inside the Journal tab. */
function draw(root) {
  if (!root?.isConnected) return;
  const on = tableOn();
  root.classList.toggle('cs-tv-on', on);
  let panel = root.querySelector(':scope .cs-tv');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'cs-tv';
    panel.innerHTML = `<div class="cs-tv-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input type="search" class="cs-tv-q" placeholder="${escapeHtml(t('Find'))}" aria-label="${escapeHtml(t('Find'))}" autocomplete="off"></div>
      <div class="cs-tv-body"></div>
      <button type="button" class="cs-tv-return" data-cs-table="1"><i class="fa-solid fa-table-list" aria-hidden="true"></i> ${escapeHtml(t('Name'))}</button>`;
    const header = root.querySelector('.directory-header');
    if (header) header.after(panel);
    else root.prepend(panel);
    wire(panel, root);
  }
  const q = panel.querySelector('.cs-tv-q');
  if (q.value !== state.query) q.value = state.query;
  if (on) panel.querySelector('.cs-tv-body').innerHTML = listHtml();
}

async function setList(key, list) {
  await game.settings.set(MODULE_ID, key, JSON.stringify(list));
}

function wire(panel, root) {
  panel.querySelector('.cs-tv-q').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    panel.querySelector('.cs-tv-body').innerHTML = listHtml();
  });
  panel.addEventListener('click', async (ev) => {
    const open = ev.target.closest('[data-cs-open]');
    if (open) {
      game.journal.get(open.dataset.csOpen)?.sheet?.render({ force: true });
      return;
    }
    const pin = ev.target.closest('[data-cs-pin]');
    if (pin) {
      const id = pin.dataset.csPin;
      const list = readList('tablePinned');
      await setList('tablePinned', list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
      draw(root);
      return;
    }
    const chip = ev.target.closest('[data-cs-chip]');
    if (chip) {
      state.chip = chip.dataset.csChip;
      draw(root);
      return;
    }
    const more = ev.target.closest('[data-cs-more]');
    if (more) {
      state.expanded.add(more.dataset.csMore);
      draw(root);
      return;
    }
    if (ev.target.closest('[data-cs-folders]')) {
      await game.settings.set(MODULE_ID, 'journalTabView', 'folders');
      draw(root);
      return;
    }
    if (ev.target.closest('[data-cs-table]')) {
      await game.settings.set(MODULE_ID, 'journalTabView', 'table');
      draw(root);
    }
  });
}

function directoryRoot() {
  const el = ui.journal?.element;
  return el instanceof HTMLElement ? el : el?.[0] ?? null;
}

let pending = 0;
function redrawSoon() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    try {
      draw(directoryRoot());
    } catch (err) {
      console.warn('Chronicle Sync | At this table could not redraw', err);
    }
  });
}

/** Remember an opened journal as recent for this user. */
async function noteOpened(app) {
  const journal = app?.document;
  if (journal?.documentName !== 'JournalEntry' || !journal.id) return;
  const list = readList('tableRecent');
  if (list[0] === journal.id) return;
  await setList('tableRecent', pushRecent(list, journal.id));
  redrawSoon();
}

/** Start "At this table" for this user. */
export function registerTableView() {
  const onDirectory = (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0] ?? directoryRoot();
    try {
      draw(root);
    } catch (err) {
      // Foundry's own directory is still there underneath.
      root?.classList?.remove('cs-tv-on');
      console.warn('Chronicle Sync | At this table unavailable', err);
    }
  };
  Hooks.on('renderJournalDirectory', onDirectory);
  for (const hook of ['renderJournalEntrySheet', 'renderJournalSheet']) {
    Hooks.on(hook, (app) => { noteOpened(app).catch(() => {}); });
  }
  for (const hook of ['canvasReady', 'createToken', 'updateToken', 'deleteToken', 'createNote', 'deleteNote', 'updateScene']) {
    Hooks.on(hook, redrawSoon);
  }
  redrawSoon();
}
