/**
 * The dashboard's History tab: the same sync history as Chronicle's
 * Manage › Sync history page, read from `GET /sync/history`.
 *
 * The dashboard re-renders often, so the tab keeps its rows and filters
 * here and redraws them into the fresh panel after each render.
 */

import { buildHistoryRows, historyQuery, h, toDom } from './_history-view.mjs';

export class SyncHistoryTab {
  /** @param {() => import('./api-client.mjs').ChronicleAPI|null} getApi */
  constructor(getApi) {
    this._getApi = getApi;
    this.filter = { q: '', direction: '', failed: false };
    this.events = null;
    this.nextBefore = 0;
    this.error = '';
    this._loading = false;
    this._root = null;
    this._searchTimer = null;
  }

  /**
   * Attach to the panel after a dashboard render. Loads the first page the
   * first time the tab is shown.
   * @param {HTMLElement} el - the dashboard element
   * @param {boolean} active - whether the History tab is showing
   */
  mount(el, active) {
    const root = el.querySelector('[data-history-root]');
    if (!root) return;
    this._root = root;
    const form = root.querySelector('[data-history-filters]');
    if (form) {
      form.querySelector('[name="q"]').value = this.filter.q;
      form.querySelector('[name="direction"]').value = this.filter.direction;
      form.querySelector('[name="failed"]').checked = this.filter.failed;
      form.addEventListener('submit', (e) => e.preventDefault());
      form.addEventListener('input', (e) => this._onFilter(e, form));
      form.addEventListener('change', (e) => this._onFilter(e, form));
    }
    root.querySelector('[data-history-refresh]')?.addEventListener('click', () => this.load());
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-history-older]')) this.load({ older: true });
    });
    this._draw();
    if (active && this.events === null) this.load();
  }

  /** The History tab was opened. */
  shown() {
    if (this.events === null) this.load();
  }

  _onFilter(e, form) {
    this.filter = {
      q: form.querySelector('[name="q"]').value,
      direction: form.querySelector('[name="direction"]').value,
      failed: form.querySelector('[name="failed"]').checked,
    };
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.load(), e.target.name === 'q' ? 300 : 0);
  }

  /**
   * Fetch the newest page, or the next older one.
   * @param {{older?: boolean}} [opts]
   */
  async load({ older = false } = {}) {
    const api = this._getApi();
    if (!api || this._loading) return;
    this._loading = true;
    this.error = '';
    this._draw();
    try {
      const res = await api.get(historyQuery(this.filter, older ? this.nextBefore : 0));
      const page = Array.isArray(res?.data) ? res.data : [];
      this.events = older ? [...(this.events || []), ...page] : page;
      this.nextBefore = Number(res?.nextBefore) || 0;
    } catch (err) {
      this.error = err?.status === 403
        ? 'Only the campaign owner’s key, or the key of a member with DM access, can read the sync history.'
        : err?.status === 404
          ? 'This Chronicle has no sync history yet. Update Chronicle to see it here.'
          : 'Couldn’t load the sync history. Try again in a moment.';
      if (!older) this.events = this.events || [];
    } finally {
      this._loading = false;
      this._draw();
    }
  }

  _draw() {
    const list = this._root?.querySelector('[data-history-rows]');
    if (!list || !list.isConnected) return;
    if (this.events === null) {
      list.replaceChildren(toDom(h('p', 'sh-empty', null, 'Loading…')));
      return;
    }
    const filtered = !!(this.filter.q || this.filter.direction || this.filter.failed);
    const nodes = [];
    if (this.error) nodes.push(h('p', 'sh-empty sh-error', null, this.error));
    if (!this.error || this.events.length) nodes.push(...buildHistoryRows(this.events, { filtered }));
    if (this.nextBefore && !this.error) {
      const attrs = { type: 'button', 'data-history-older': '' };
      if (this._loading) attrs.disabled = '';
      nodes.push(h('div', 'sh-more', null, h('button', 'dashboard-btn btn-sm', attrs, 'Show older')));
    }
    list.replaceChildren(toDom(nodes));
  }
}
