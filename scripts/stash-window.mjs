/**
 * Chronicle Sync - Stashes window
 *
 * Two sides: the character on the left, a destination (a stash or another
 * character) on the right. Drag an item or the money row across, or pick it
 * and use the arrow, then answer a small quantity/amount prompt. Everything
 * goes through stashRequest(): directly for the GM, over the socket for a
 * player. The server decides what is allowed; this window only asks and shows
 * what comes back.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { submitReport } from './debug-hub.mjs';
import { MAX_TEXT } from './_debug-reports.mjs';
import { canOpenStashes, cancelStashRequests, describeError, stashRequest } from './stash-client.mjs';
import {
  buildMovePayload,
  formatMoney,
  moveFraming,
  normalizeView,
  parseAmount,
  unwrapHistory,
} from './_stash-model.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const t = (key, data) => (data
  ? game.i18n.format(`CHRONICLE.Stashes.${key}`, data)
  : game.i18n.localize(`CHRONICLE.Stashes.${key}`));

/** @type {Map<string, StashesWindow>} One window per character. */
const open = new Map();

export class StashesWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ['chronicle-stashes-window'],
    window: { icon: 'fa-solid fa-box-open', resizable: true },
    position: { width: 720, height: 560 },
  };

  static PARTS = {
    body: { template: 'modules/chronicle-sync/templates/stash-window.hbs' },
  };

  /**
   * @param {Actor} actor - a character linked to a Chronicle entity.
   */
  constructor(actor, options = {}) {
    super({ id: `chronicle-stashes-${actor.id}`, ...options });
    this.actor = actor;
    this.characterId = String(actor.getFlag(FLAG_SCOPE, 'entityId'));
    /** @type {object|null} normalized /stashes/view */
    this.view = null;
    /** @type {{kind: string, id: string}|null} the right-hand destination */
    this.dest = null;
    /** @type {{name: string, money: number, items: object[], hidden: boolean, loading: boolean}|null} */
    this.destContents = null;
    this.tab = 'move';
    /** @type {object[]|null} */
    this.history = null;
    this.loading = true;
    this.error = '';
    /** @type {{side: string, kind: string, itemId?: string}|null} the picked row */
    this.selected = null;
    /** @type {object|null} the open quantity/amount prompt */
    this.prompt = null;
    this._busy = false;
    /** @type {{open: boolean, text: string, sending: boolean, message: string, error: boolean}} the "Report a problem" box */
    this.report = { open: false, text: '', sending: false, message: '', error: false };
    this._onChanged = this._onChanged.bind(this);
  }

  /** @override */
  get title() {
    return t('WindowTitle', { name: this.actor.name });
  }

  // --- Data ---------------------------------------------------------------

  /** Fetch the view (character, stashes, destinations, downtime). */
  async load() {
    this.loading = true;
    const res = await stashRequest({ action: 'view', characterId: this.characterId }, this);
    this.loading = false;
    if (!res.ok) {
      this.error = describeError(res.error);
      return this.render();
    }
    const view = normalizeView(res.data);
    if (!view) {
      this.error = t('Error.Generic');
      return this.render();
    }
    this.error = '';
    this.view = view;
    // Keep the chosen destination only while it is still on offer.
    if (this.dest && !view.destinations.some((d) => d.kind === this.dest.kind && d.id === this.dest.id)) {
      this.dest = null;
      this.destContents = null;
      this.selected = null;
    }
    if (this.dest) await this.loadDestination({ render: false });
    if (this.tab === 'history') await this.loadHistory({ render: false });
    return this.render();
  }

  /** Fetch what the right-hand destination holds. */
  async loadDestination({ render = true } = {}) {
    const dest = this.dest;
    if (!dest || !this.view) return;
    if (dest.kind === 'stash') {
      const stash = this.view.stashes.find((x) => x.id === dest.id);
      this.destContents = stash
        ? { name: stash.name, money: stash.money, items: stash.items, hidden: false, loading: false, takeable: true }
        : { name: '', money: 0, items: [], hidden: true, loading: false, takeable: false };
    } else {
      this.destContents = { name: '', money: 0, items: [], hidden: false, loading: true, takeable: false };
      if (render) this.render();
      // Another character's contents come back redacted for this member; a
      // refusal just means there is nothing to show.
      const res = await stashRequest({ action: 'view', characterId: dest.id, contextCharacterId: this.characterId }, this);
      const v = res.ok ? normalizeView(res.data) : null;
      if (this.dest !== dest) return;
      this.destContents = v
        ? {
          name: v.character.name, money: v.character.money, items: v.character.items, hidden: false, loading: false,
          // Taking from another character is for the GM or their owner.
          takeable: game.user.isGM || this._owns(dest.id),
        }
        : { name: '', money: 0, items: [], hidden: true, loading: false, takeable: false };
    }
    if (render) this.render();
  }

  /** Fetch the move history of this character. */
  async loadHistory({ render = true } = {}) {
    const res = await stashRequest({ action: 'history', characterId: this.characterId }, this);
    if (res.ok) {
      this.history = unwrapHistory(res.data);
      this.error = '';
    } else {
      this.error = describeError(res.error);
    }
    if (render) this.render();
  }

  /** Does the current user own the actor linked to this Chronicle character? */
  _owns(entityId) {
    const actor = game.actors.find((a) => a.getFlag(FLAG_SCOPE, 'entityId') === entityId);
    return !!actor?.testUserPermission(game.user, 'OWNER');
  }

  /** Live changes from the GM client: downtime switch, or something moved. */
  _onChanged(change) {
    if (change?.kind === 'downtime') {
      if (this.view) {
        this.view.downtimeOpen = change.open === true;
        this.render();
      }
      return;
    }
    if (change?.kind !== 'refresh') return;
    const ids = change.characterIds ?? [];
    const mine = ids.length === 0 || ids.includes(this.characterId) || (this.dest && ids.includes(this.dest.id));
    if (mine && !this._busy) this.load();
  }

  // --- Rendering ----------------------------------------------------------

  /** @override */
  async _prepareContext() {
    const view = this.view;
    const isGM = game.user.isGM;
    const isMove = this.tab === 'move';
    const downtimeOpen = !!view?.downtimeOpen;
    const framing = moveFraming({ downtimeOpen, isGM });
    const sel = this.selected;

    const ctx = {
      isMove,
      downtimeOpen,
      pillText: t(downtimeOpen ? 'DowntimeOpen' : 'DowntimeClosed'),
      error: this.error,
      loading: this.loading,
      hasView: !!view,
      busy: this._busy,
      framing: { button: t(framing.buttonKey), hint: t(framing.hintKey) },
      history: (this.history ?? []).map((h) => ({
        summary: h.summary || h.reason,
        when: h.createdAt ? new Date(h.createdAt).toLocaleString() : '',
      })),
      prompt: this.prompt,
      canMoveFromLeft: false,
      report: { ...this.report, max: MAX_TEXT, canReport: !!this.characterId },
    };
    if (!view) return ctx;

    ctx.character = {
      name: view.character.name,
      hasMoney: !!view.character.moneyKey,
      money: formatMoney(view.character.money),
      moneySelected: sel?.side === 'left' && sel.kind === 'money',
      items: view.character.items.map((i) => ({ ...i, selected: sel?.side === 'left' && sel.kind === 'item' && sel.itemId === i.itemId })),
    };

    const groups = [
      { label: t('StashesGroup'), kind: 'stash' },
      { label: t('OtherCharacters'), kind: 'character' },
    ];
    ctx.destGroups = groups
      .map((g) => ({
        label: g.label,
        options: view.destinations
          .filter((d) => d.kind === g.kind && !(d.kind === 'character' && d.id === this.characterId))
          .map((d) => ({
            value: `${d.kind}:${d.id}`,
            name: d.name,
            selected: this.dest?.kind === d.kind && this.dest?.id === d.id,
          })),
      }))
      .filter((g) => g.options.length > 0);

    const dc = this.destContents;
    if (this.dest && dc) {
      ctx.dest = {
        loading: dc.loading,
        hidden: dc.hidden,
        showContents: !dc.loading && !dc.hidden,
        money: formatMoney(dc.money),
        moneySelected: sel?.side === 'right' && sel.kind === 'money',
        canTake: dc.takeable,
        items: dc.items.map((i) => ({ ...i, selected: sel?.side === 'right' && sel.kind === 'item' && sel.itemId === i.itemId })),
      };
      ctx.canMoveFromLeft = !dc.loading && !dc.hidden;
    }
    return ctx;
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    Hooks.on('chronicleStashChanged', this._onChanged);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;

    el.querySelectorAll('[data-cs-tab]').forEach((b) => b.addEventListener('click', async () => {
      this.tab = b.dataset.csTab === 'history' ? 'history' : 'move';
      this.prompt = null;
      if (this.tab === 'history' && this.history === null) await this.loadHistory({ render: false });
      this.render();
    }));
    el.querySelector('[data-cs-refresh]')?.addEventListener('click', () => this.load());

    el.querySelector('[data-cs-dest]')?.addEventListener('change', (event) => {
      const [kind, ...rest] = String(event.target.value).split(':');
      const id = rest.join(':');
      this.dest = kind && id ? { kind, id } : null;
      this.destContents = null;
      this.selected = null;
      this.prompt = null;
      if (this.dest) this.loadDestination(); else this.render();
    });

    el.querySelectorAll('[data-cs-pick]').forEach((row) => {
      const pick = () => ({ side: row.dataset.csPick, kind: row.dataset.csKind, itemId: row.dataset.csItem });
      row.addEventListener('click', () => {
        const p = pick();
        const same = this.selected && this.selected.side === p.side && this.selected.kind === p.kind && this.selected.itemId === p.itemId;
        this.selected = same ? null : p;
        this.render();
      });
      row.addEventListener('dblclick', () => this._startMove(pick()));
      row.addEventListener('dragstart', (event) => {
        this._drag = pick();
        event.dataTransfer?.setData('text/plain', `${this._drag.kind}:${this._drag.itemId ?? ''}`);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => { this._drag = null; });
    });

    el.querySelectorAll('[data-cs-side]').forEach((side) => {
      side.addEventListener('dragover', (event) => {
        if (this._drag && this._drag.side !== side.dataset.csSide) event.preventDefault();
      });
      side.addEventListener('drop', (event) => {
        const drag = this._drag;
        this._drag = null;
        if (!drag || drag.side === side.dataset.csSide) return;
        event.preventDefault();
        this._startMove(drag);
      });
    });

    el.querySelectorAll('[data-cs-movebtn]').forEach((b) => b.addEventListener('click', (event) => {
      event.stopPropagation();
      this._startMove({ side: b.dataset.csMovebtn, kind: b.dataset.csKind, itemId: b.dataset.csItem });
    }));

    this._wireReport(el);

    const form = el.querySelector('[data-cs-prompt]');
    if (form) {
      const input = form.querySelector('[data-cs-input]');
      input?.addEventListener('input', () => { if (this.prompt) this.prompt.value = input.value; });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        this.submitMove();
      });
      form.querySelector('[data-cs-cancel]')?.addEventListener('click', () => {
        this.prompt = null;
        this.render();
      });
      if (this._focusPrompt) {
        this._focusPrompt = false;
        input?.focus();
        input?.select();
      }
    }
  }

  /** @override */
  _onClose(options) {
    Hooks.off('chronicleStashChanged', this._onChanged);
    cancelStashRequests(this);
    open.delete(this.actor.id);
    super._onClose?.(options);
  }

  // --- Report a problem ---------------------------------------------------

  _wireReport(el) {
    el.querySelector('[data-cs-report-open]')?.addEventListener('click', (event) => {
      event.preventDefault();
      this.report = { open: true, text: this.report.text, sending: false, message: '', error: false };
      this._focusReport = true;
      this.render();
    });
    const form = el.querySelector('[data-cs-report-form]');
    if (!form) return;
    const box = form.querySelector('[data-cs-report-text]');
    // Kept as typed so a live refresh of the window never wipes it.
    box?.addEventListener('input', () => { this.report.text = box.value; });
    form.querySelector('[data-cs-report-cancel]')?.addEventListener('click', () => {
      this.report = { open: false, text: '', sending: false, message: '', error: false };
      this.render();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendReport();
    });
    if (this._focusReport) {
      this._focusReport = false;
      box?.focus();
    }
  }

  /** Send the typed report to the GM and say what happened. */
  async sendReport() {
    const r = this.report;
    if (r.sending) return;
    if (!r.text.trim()) return;
    r.sending = true;
    r.message = '';
    this.render();
    const res = await submitReport({ characterId: this.characterId, text: r.text });
    if (res.ok) {
      this.report = { open: false, text: '', sending: false, message: game.i18n.localize('CHRONICLE.Debug.Report.Sent'), error: false };
    } else {
      const key = res.code === 'no_gm' ? 'NoGM' : res.code === 'rate_limited' ? 'RateLimited' : 'Failed';
      this.report = { open: true, text: r.text, sending: false, message: game.i18n.localize(`CHRONICLE.Debug.Report.${key}`), error: true };
    }
    this.render();
  }

  // --- Actions ------------------------------------------------------------

  /**
   * Open the quantity/amount prompt for moving a picked row to the other side.
   * @param {{side: string, kind: string, itemId?: string}} pick
   */
  _startMove(pick) {
    if (!this.view || !this.dest || this._busy) return;
    const fromLeft = pick.side === 'left';
    const source = fromLeft ? this.view.character : this.destContents;
    if (!source || (!fromLeft && !this.destContents?.takeable)) return;

    let prompt;
    if (pick.kind === 'item') {
      const item = source.items.find((i) => i.itemId === pick.itemId);
      if (!item) return;
      prompt = {
        side: pick.side, kind: 'item', itemId: item.itemId, max: item.quantity,
        label: t('HowMany'), value: '1', summary: `${item.name} (\u00d7${item.quantity})`,
      };
    } else {
      if (fromLeft && !this.view.character.moneyKey) return;
      prompt = {
        side: pick.side, kind: 'money', max: source.money,
        label: t('HowMuch'), value: '', summary: `${t('Money')} (${formatMoney(source.money)})`,
      };
    }
    this.prompt = prompt;
    this._focusPrompt = true;
    this.error = '';
    this.render();
  }

  /** Send the move the prompt describes. */
  async submitMove() {
    const p = this.prompt;
    if (!p || !this.dest || this._busy) return;

    let quantity;
    let amount;
    if (p.kind === 'item') {
      quantity = Number(String(p.value).trim());
      if (!Number.isInteger(quantity) || quantity < 1) { this.error = t('BadQuantity'); return this.render(); }
      if (quantity > p.max) { this.error = t('TooMany', { max: p.max }); return this.render(); }
    } else {
      amount = parseAmount(p.value);
      if (amount === null) { this.error = t('BadAmount'); return this.render(); }
      if (amount > p.max) { this.error = t('TooMuch', { max: formatMoney(p.max) }); return this.render(); }
    }

    const mine = { kind: 'character', id: this.characterId };
    const from = p.side === 'left' ? mine : this.dest;
    const to = p.side === 'left' ? this.dest : mine;
    const move = { kind: p.kind, itemId: p.itemId, quantity, amount, from, to };
    // The same check the GM client makes, so a mistake shows up here first.
    if (!buildMovePayload(move).ok) { this.error = t('Error.BadRequest'); return this.render(); }

    this._busy = true;
    this.error = '';
    this.render();
    const res = await stashRequest({ action: 'move', characterId: this.characterId, move }, this);
    this._busy = false;
    if (!res.ok) {
      this.error = describeError(res.error);
      return this.render();
    }
    ui.notifications.info(res.data?.status === 'pending' ? t('Asked') : t('Moved'));
    this.prompt = null;
    this.selected = null;
    this.history = null;
    return this.load();
  }
}

/**
 * Open (or raise) the Stashes window for an actor.
 * @param {Actor} actor
 */
export async function openStashes(actor) {
  if (!canOpenStashes(actor)) return;
  const existing = open.get(actor.id);
  if (existing?.rendered) {
    existing.bringToFront?.();
    return existing;
  }
  const win = new StashesWindow(actor);
  open.set(actor.id, win);
  await win.render({ force: true });
  win.load();
  return win;
}

/**
 * Add the Stashes button to actor sheet title bars. Hooks both the V1 and V2
 * sheet render events, as the claim indicator does, so any system's sheet gets
 * it. The button is rebuilt whenever the sheet's header is drawn (always on
 * V2 sheets; on V1 sheets the header is not redrawn by a re-render, so a
 * permission or availability change shows after the sheet is reopened).
 */
export function registerStashButton() {
  Hooks.on('renderActorSheet', onRenderActorSheet);
  Hooks.on('renderActorSheetV2', onRenderActorSheet);
}

function onRenderActorSheet(app, html) {
  const actor = app?.actor ?? app?.document;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector?.('.window-header');
  if (!actor || !header) return;

  header.querySelector('.chronicle-stash-button')?.remove();
  if (!canOpenStashes(actor)) return;

  const v13 = (game.release?.generation ?? 12) >= 13;
  const label = t('Button');
  const button = document.createElement(v13 ? 'button' : 'a');
  button.className = v13
    ? 'header-control icon fa-solid fa-box-open chronicle-stash-button'
    : 'header-button chronicle-stash-button';
  if (v13) button.type = 'button';
  button.title = t('ButtonTitle');
  button.setAttribute('aria-label', t('ButtonTitle'));
  if (!v13) {
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-box-open';
    button.append(icon, ` ${label}`);
  }
  button.addEventListener('click', (event) => {
    event.preventDefault();
    openStashes(actor);
  });

  const close = header.querySelector('[data-action="close"], .close');
  if (close) close.before(button);
  else header.append(button);
}
