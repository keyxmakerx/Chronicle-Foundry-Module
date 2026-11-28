/**
 * Chronicle Sync - the GM's notes in the sheet's GM-only box.
 *
 * Fields a system marks GM-only (Draw Steel's Director Notes) are never
 * saved on the actor: Foundry sends a shared actor's whole data to every
 * player who can open it. On the GM's client only, each time a linked hero's
 * sheet draws, the box is filled with Chronicle's notes, read with the GM's
 * key. Nothing here writes to the actor or puts a named input in the form,
 * so the notes never reach the document or a player.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { escapeHtml } from './_escape-html.mjs';
import { entryTextHTML } from './_entry-text.mjs';
import { _resolveCleanHTML } from './_html-sanitizer.mjs';
import { chroniclePageUrl } from './_hero-looks.mjs';
import {
  gmNotesBoxes, gmNotesText, holdsOwnText, notesHtml, notesPlainText, pageReader, stripFormParts,
} from './_gm-notes-view.mjs';

const VIEW_CLASS = 'chronicle-gm-notes';

const t = (key) => game.i18n.localize(`CHRONICLE.GmNotes.${key}`);

export class GmNotesView {
  /**
   * @param {object} p
   * @param {{get: (path: string) => Promise<object|null>}} p.api - the GM's Chronicle API
   * @param {Array<object>} p.fields - the adapter's GM-only fields
   * @param {(actor: object) => boolean} p.isHero - whether sync links this actor as a hero
   */
  constructor({ api, fields, isHero }) {
    this._boxes = gmNotesBoxes(fields);
    this._isHero = isHero;
    this._pages = pageReader((id) => api.get(`/entities/${id}`));
    this._onRender = this._onRender.bind(this);
  }

  /** Whether any box is worth watching for. */
  get active() {
    return this._boxes.length > 0;
  }

  register() {
    if (!this.active || !game.user?.isGM) return;
    Hooks.on('renderActorSheet', this._onRender);
    Hooks.on('renderActorSheetV2', this._onRender);
  }

  destroy() {
    Hooks.off('renderActorSheet', this._onRender);
    Hooks.off('renderActorSheetV2', this._onRender);
  }

  /** Drop a cached read, so the next draw shows a change made in Chronicle. */
  forget(entityId) {
    if (entityId) this._pages.forget(entityId);
  }

  /** @private */
  _onRender(app, html) {
    if (!game.user?.isGM) return;
    const actor = app?.actor ?? app?.document;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? app?.element);
    const entityId = actor?.getFlag?.(FLAG_SCOPE, 'entityId');
    if (!entityId || !(root instanceof HTMLElement) || !this._isHero(actor)) return;
    for (const box of this._boxes) {
      const fieldset = findBox(root, actor, box);
      if (fieldset) this._fill(fieldset, actor, entityId, box);
    }
  }

  /** @private */
  _fill(fieldset, actor, entityId, box) {
    fieldset.querySelector(`:scope > .${VIEW_CLASS}`)?.remove();
    const own = holdsOwnText(actor, box.path);
    for (const child of fieldset.children) {
      if (child.tagName === 'LEGEND' || child.classList.contains(VIEW_CLASS)) continue;
      // Empty native content is hidden so the box reads as the notes alone;
      // text typed in Foundry stays in view, flagged as readable by players.
      child.hidden = !own;
    }
    const view = document.createElement('div');
    view.className = VIEW_CLASS;
    view.setAttribute('aria-live', 'polite');
    const body = document.createElement('div');
    body.className = `${VIEW_CLASS}__body`;
    body.textContent = t('Loading');
    view.append(body, footer(entityId, own));
    const legend = fieldset.querySelector(':scope > legend');
    if (legend) legend.after(view);
    else fieldset.prepend(view);

    this._pages.get(entityId).then((entity) => {
      const text = gmNotesText(entity, box.key);
      if (!text) {
        body.textContent = t('Empty');
        return;
      }
      showNotes(body, entryTextHTML(text));
    }).catch((err) => {
      console.warn(`Chronicle: could not load "${actor.name}"'s GM notes`, err);
      body.textContent = '';
      const msg = document.createElement('span');
      msg.textContent = t('Failed');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = t('Retry');
      retry.addEventListener('click', (event) => {
        event.preventDefault();
        this._pages.forget(entityId);
        this._fill(fieldset, actor, entityId, box);
      });
      body.append(msg, ' ', retry);
    });
  }
}

/**
 * Put the notes in the box: sanitized HTML parsed in an inert template, with
 * every form part taken out before it joins the sheet's form; plain text
 * when sanitizing can't run.
 */
function showNotes(body, html) {
  const clean = notesHtml(html, _resolveCleanHTML());
  if (clean === null) {
    body.textContent = notesPlainText(html);
    return;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  stripFormParts(tpl.content);
  body.replaceChildren(tpl.content);
}

/**
 * The sheet's fieldset for a box: the one holding the input named for its
 * path (edit mode), else the one whose legend is the field's label.
 */
function findBox(root, actor, box) {
  const escaped = globalThis.CSS?.escape ? CSS.escape(box.path) : box.path.replace(/"/g, '\\"');
  const named = root.querySelector(`[name="${escaped}"]`)?.closest('fieldset');
  if (named) return named;
  let label = '';
  try {
    label = actor.system?.schema?.getField?.(box.schemaPath)?.label ?? '';
  } catch { /* a system without the path: no box */ }
  const text = label ? game.i18n.localize(label).trim() : '';
  if (!text) return null;
  for (const fs of root.querySelectorAll('fieldset')) {
    if (fs.querySelector(':scope > legend')?.textContent.trim() === text) return fs;
  }
  return null;
}

function footer(entityId, own) {
  const foot = document.createElement('p');
  foot.className = `${VIEW_CLASS}__foot`;
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-lock';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = t('OnlyYou');
  foot.append(icon, ' ', text);
  const url = chroniclePageUrl({ apiUrl: getSetting('apiUrl'), campaignId: getSetting('campaignId'), entityId });
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerHTML = `${escapeHtml(t('Edit'))} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>`;
    foot.append(' ', link);
  }
  if (own) {
    const warn = document.createElement('span');
    warn.className = `${VIEW_CLASS}__own`;
    warn.textContent = t('OwnText');
    foot.append(warn);
  }
  return foot;
}
