/**
 * Chronicle Sync - Cast (the DM Screen's Cast tab)
 *
 * The scene's Chronicle NPCs as a list, each with the token HUD's three
 * buttons: Spotlight, Talk as and Page. The list is read from the scene on
 * every token and scene change, so it never holds state of its own. GM only.
 */

import { escapeHtml } from './_escape-html.mjs';
import { castAction, sceneCast } from './npc-presence.mjs';

const REDRAW_DELAY_MS = 60;

const t = (key) => game.i18n.localize(`CHRONICLE.DMScreen.Cast.${key}`);

export class CastPane {
  constructor() {
    this._root = null;
    this._hooks = [];
    this._timer = 0;
    this._onClick = this._click.bind(this);
  }

  /** Attach to the tab's element (a fresh one after each window render). */
  mount(root) {
    this._root = root;
    root.addEventListener('click', this._onClick);
    this._bindHooks();
    this._draw();
  }

  destroy() {
    clearTimeout(this._timer);
    for (const [name, id] of this._hooks) Hooks.off(name, id);
    this._hooks = [];
    this._root?.removeEventListener('click', this._onClick);
    this._root = null;
  }

  _bindHooks() {
    for (const [name, id] of this._hooks) Hooks.off(name, id);
    this._hooks = [];
    const redraw = () => {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._draw(), REDRAW_DELAY_MS);
    };
    // A token change on another scene never changes this list.
    const onScene = (doc) => { if (!doc?.parent || doc.parent.id === canvas?.scene?.id) redraw(); };
    for (const [name, fn] of [
      ['createToken', onScene], ['updateToken', onScene], ['deleteToken', onScene], ['canvasReady', redraw],
    ]) {
      this._hooks.push([name, Hooks.on(name, fn)]);
    }
  }

  _draw() {
    const root = this._root;
    if (!root) return;
    if (!canvas?.ready || !canvas.scene) {
      root.innerHTML = `<p class="dms-small">${escapeHtml(t('NoScene'))}</p>`;
      return;
    }
    const rows = sceneCast();
    if (!rows.length) {
      root.innerHTML = `<div class="cs-state"><i class="fa-solid fa-masks-theater" aria-hidden="true"></i>
        <b>${escapeHtml(t('EmptyTitle'))}</b><p>${escapeHtml(t('Empty'))}</p></div>`;
      return;
    }
    root.innerHTML = `<span class="dms-lbl">${escapeHtml(t('Heading'))}</span>${rows.map((r) => `
      <div class="dms-row dms-cast-row">
        <span class="dms-cast-who">
          <span>${escapeHtml(r.name)}${r.hidden ? ` <em class="dms-tag">${escapeHtml(t('Hidden'))}</em>` : ''}</span>
          ${r.typeName ? `<span class="dms-small">${escapeHtml(r.typeName)}</span>` : ''}
        </span>
        <span class="dms-cast-btns">
          <button type="button" data-cast="spotlight" data-id="${escapeHtml(r.id)}">${escapeHtml(t('Spotlight'))}</button>
          <button type="button" data-cast="talk" data-id="${escapeHtml(r.id)}" aria-pressed="${r.talking}">${escapeHtml(r.talking ? t('TalkStop') : t('Talk'))}</button>
          <button type="button" data-cast="page" data-id="${escapeHtml(r.id)}">${escapeHtml(t('Page'))}</button>
        </span>
      </div>`).join('')}`;
  }

  async _click(ev) {
    const btn = ev.target.closest('[data-cast]');
    if (!btn || !this._root?.contains(btn)) return;
    btn.disabled = true;
    try {
      await castAction(btn.dataset.id, btn.dataset.cast);
    } finally {
      btn.disabled = false;
    }
  }
}
