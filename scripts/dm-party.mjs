/**
 * Chronicle Sync - Party (the DM Screen's Party tab)
 *
 * The party's shared stashes with their money and contents, read from
 * Chronicle through one hero's stash view, and the world's shops with a
 * button that opens each one's room. Moving things stays in the Stashes
 * window, which this tab opens; nothing here writes to Chronicle. GM only.
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import { escapeHtml } from './_escape-html.mjs';
import { isShopJournal } from './_shop-journal.mjs';
import { stashHero, stashRows } from './_dm-party.mjs';
import { describeError, stashesAvailable, stashRequest, cancelStashRequests } from './stash-client.mjs';
import { openStashes } from './stash-window.mjs';

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.DMScreen.Party.${key}`, data)
  : game.i18n.localize(`CHRONICLE.DMScreen.Party.${key}`));

export class PartyPane {
  constructor() {
    this._root = null;
    /** @type {{loading: boolean, error: string, rows: object[]|null, heroId: string}} */
    this._stash = { loading: false, error: '', rows: null, heroId: '' };
    this._onClick = this._click.bind(this);
  }

  /** Attach to the tab's element (a fresh one after each window render). */
  mount(root) {
    this._root = root;
    root.addEventListener('click', this._onClick);
    this._draw();
    if (!this._stash.rows && !this._stash.error && !this._stash.loading) this._loadStash();
  }

  destroy() {
    cancelStashRequests(this);
    this._root?.removeEventListener('click', this._onClick);
    this._root = null;
  }

  _hero() {
    return stashHero((game.actors?.contents ?? []).map((a) => ({
      id: a.id, name: a.name, entityId: a.getFlag(FLAG_SCOPE, 'entityId') ?? null, playerOwned: !!a.hasPlayerOwner,
    })));
  }

  async _loadStash() {
    const hero = stashesAvailable() ? this._hero() : null;
    if (!hero) return;
    this._stash = { loading: true, error: '', rows: null, heroId: hero.id };
    this._draw();
    const res = await stashRequest({ action: 'view', characterId: hero.entityId }, this);
    const rows = res.ok ? stashRows(res.data) : null;
    this._stash = {
      loading: false,
      error: res.ok ? (rows ? '' : t('StashFailed')) : describeError(res.error),
      rows,
      heroId: hero.id,
    };
    this._draw();
  }

  _shops() {
    return (game.journal?.contents ?? [])
      .filter((j) => isShopJournal(j, FLAG_SCOPE))
      .map((j) => ({ id: String(j.getFlag(FLAG_SCOPE, 'entityId')), name: j.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _stashHTML() {
    if (!stashesAvailable()) return `<p class="dms-small">${escapeHtml(t('StashesOff'))}</p>`;
    if (!this._hero()) return `<p class="dms-small">${escapeHtml(t('NoHero'))}</p>`;
    const s = this._stash;
    if (s.loading) return '<div class="cs-loading" role="status"><div class="cs-skel"></div><div class="cs-skel"></div></div>';
    if (s.error) {
      return `<div class="cs-state is-error" role="alert"><i class="fa-solid fa-cloud-bolt" aria-hidden="true"></i>
        <p>${escapeHtml(s.error)}</p><button type="button" data-party="reload">${escapeHtml(t('TryAgain'))}</button></div>`;
    }
    const stashes = s.rows ?? [];
    const list = stashes.length ? stashes.map((st) => `
      <div class="dms-stash">
        <div class="dms-row"><b>${escapeHtml(st.name)}</b><span class="dms-num">${escapeHtml(t('Money', { amount: st.money }))}</span></div>
        ${st.items.length
    ? `<ul class="dms-stash-items">${st.items.map((i) => `<li><span>${escapeHtml(i.name)}</span><span class="dms-num">×${i.quantity}</span></li>`).join('')}</ul>`
    : `<p class="dms-small">${escapeHtml(t('StashEmpty'))}</p>`}
      </div>`).join('') : `<p class="dms-small">${escapeHtml(t('NoStashes'))}</p>`;
    return `${list}<div class="dms-party-acts"><button type="button" data-party="move">${escapeHtml(t('Move'))}</button>
      <button type="button" data-party="reload">${escapeHtml(t('Reload'))}</button></div>`;
  }

  _draw() {
    const root = this._root;
    if (!root) return;
    const shops = this._shops();
    root.innerHTML = `
      <span class="dms-lbl">${escapeHtml(t('StashHeading'))}</span>
      ${this._stashHTML()}
      <span class="dms-lbl">${escapeHtml(t('ShopHeading'))}</span>
      ${shops.length ? shops.map((sh) => `
        <div class="dms-row"><span>${escapeHtml(sh.name)}</span>
          <button type="button" data-party="shop" data-id="${escapeHtml(sh.id)}" data-name="${escapeHtml(sh.name)}">${escapeHtml(t('OpenShop'))}</button></div>`).join('')
    : `<p class="dms-small">${escapeHtml(t('NoShops'))}</p>`}`;
  }

  async _click(ev) {
    const btn = ev.target.closest('[data-party]');
    if (!btn || !this._root?.contains(btn)) return;
    const act = btn.dataset.party;
    if (act === 'reload') {
      this._stash = { loading: false, error: '', rows: null, heroId: '' };
      await this._loadStash();
    } else if (act === 'move') {
      const actor = game.actors?.get(this._stash.heroId);
      if (actor) await openStashes(actor);
    } else if (act === 'shop') {
      // The shop room window is the GM's; showing it to players happens there.
      const shops = game.modules.get(MODULE_ID)?.api?.syncManager?._modules
        ?.find((m) => m.constructor?.name === 'ShopWidget');
      await shops?.openShop(btn.dataset.id, btn.dataset.name);
    }
  }
}
