/**
 * The Chronicle hero sheet: Draw Steel's own hero sheet, drawn like
 * Chronicle's hero sheet. A header with the portrait, name and origins, a
 * row of number boxes and the Stamina box that stay above the tabs, then
 * Draw Steel's own tabs restyled.
 *
 * It is a subclass, so every roll, button, menu, drag and drop is Draw
 * Steel's: only the header and the boxes have their own templates, and those
 * keep the attributes Draw Steel's handlers read (pinned by
 * tools/test-hero-looks-contract.mjs). The other tabs are Draw Steel's
 * templates. The header shows nothing Draw Steel's header doesn't, because a
 * viewer with Limited permission sees it.
 *
 * Offered beside Draw Steel's sheet, never the default: a GM or player picks
 * it in the hero's Sheet configuration. Only on the Draw Steel system.
 *
 * In the title bar: Fold turns the sheet into a small card and back (kept
 * per player, in this browser), and Sheet look opens the look picker, which
 * also switches to Draw Steel Plus or Draw Steel's own sheet. Clicking the
 * portrait opens the portrait menu. Folding and the menus write nothing to
 * the hero; picking a look or another sheet writes only its flags.
 */

import { FLAG_SCOPE, MODULE_ID, syncOptions } from './constants.mjs';
import { closeHeroMenu, openHeroMenu } from './hero-menu.mjs';
import {
  DEFAULT_LOOK, DRAW_STEEL_PLUS_MODULE, HERO_LOOKS, LOOK_FLAG,
  allLookTemplates, chronicleParts, chroniclePageUrl, chronicleTabs, conditionList, countDiamonds, drawSteelSupported,
  fitRenderParts, lookTemplate, pickerRows, plaqueMetal, portraitRows, recoveryDots, resolveLook, ringSegments,
  sheetChanges, skillNames, staminaView, withFold,
} from './_hero-looks.mjs';

/** The GM's default look for every hero, and whether players may change it. */
export const LOOK_DEFAULT_SETTING = 'heroLookDefault';
export const LOOK_LOCK_SETTING = 'heroLookLocked';
/** Each hero's fold state and card place, per player, in this browser. */
export const FOLD_SETTING = 'heroSheetFolds';

/** The folded card's width; its height follows its content. */
const CARD_WIDTH = 296;

/** A look's own size for a hero's first open, where it differs from the sheet's. */
const LOOK_SIZE = { hall: { width: 1100, height: 760 } };

/** Looks that play their own opening move, so Chronicle's window grow stays off them. */
const OWN_OPENING_LOOKS = new Set(['hall']);

/**
 * Looks drawn dark whatever Foundry's theme, so Draw Steel's own fields and
 * editors inside them take Foundry's dark colours too.
 */
const DARK_LOOKS = new Set(['hall']);

/**
 * Put a window in Foundry's dark theme, or give back the theme classes it had.
 * What it had is kept on the window, so switching to a look that follows
 * Foundry's theme restores it.
 * @param {HTMLElement} el
 * @param {boolean} dark
 */
export function forceDarkTheme(el, dark) {
  if (!el?.classList || !el.dataset) return;
  const kept = el.dataset.csTheme;
  if (dark && kept === undefined) {
    el.dataset.csTheme = ['themed', 'theme-light', 'theme-dark'].filter((c) => el.classList.contains(c)).join(' ');
    el.classList.remove('theme-light');
    el.classList.add('themed', 'theme-dark');
  } else if (!dark && kept !== undefined) {
    el.classList.remove('themed', 'theme-light', 'theme-dark');
    if (kept) el.classList.add(...kept.split(' '));
    delete el.dataset.csTheme;
  }
}

/** How long each of a look's moves runs, so its class comes off after (ms). */
const MOVE_MS = { open: 1500, hit: 950, heal: 1050, level: 2200, editin: 900 };

/** The title bar's Fold button: fold in, or open out. */
const FOLD_ICON = 'fa-solid fa-down-left-and-up-right-to-center';
const UNFOLD_ICON = 'fa-solid fa-up-right-and-down-left-from-center';

/**
 * A module setting, or `fallback` before it is registered (tests, early
 * renders). Read directly rather than through settings.mjs, which loads
 * Foundry windows this file doesn't need.
 */
function setting(key, fallback) {
  try {
    return globalThis.game.settings.get(MODULE_ID, key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Whether a Foundry user is mapped to a Chronicle account (the userMappings setting). */
function hasChronicleAccount(userId) {
  try {
    return Object.values(JSON.parse(setting('userMappings', '{}')) ?? {}).includes(userId);
  } catch {
    return false;
  }
}

/** The inherited handler for a Draw Steel or Foundry sheet action. */
function inheritedAction(app, name) {
  const entry = app.options?.actions?.[name];
  return typeof entry === 'function' ? entry : entry?.handler ?? null;
}

/** The id Foundry stores for the sheet; renaming the class orphans every hero's choice. */
export const HERO_SHEET_CLASS = `${MODULE_ID}.ChronicleHeroSheet`;

/**
 * Build the sheet class on Draw Steel's hero sheet. A factory, because the
 * base exists only once Draw Steel has loaded.
 * @param {typeof Application} Base  ds.applications.sheets.DrawSteelHeroSheet
 */
export function makeChronicleHeroSheet(Base) {
  return class ChronicleHeroSheet extends Base {
    static DEFAULT_OPTIONS = {
      classes: ['chronicle-hero-sheet'],
      position: { width: 820, height: 780 },
      actions: {
        csPortraitMenu: ChronicleHeroSheet.#onPortraitMenu,
        csLookPicker: ChronicleHeroSheet.#onLookPicker,
        csFold: ChronicleHeroSheet.#onFold,
        csUnfold: ChronicleHeroSheet.#onUnfold,
      },
    };

    static PARTS = {
      ...chronicleParts(Base.PARTS ?? {}, {
        header: { template: 'modules/chronicle-sync/templates/hero-looks/chronicle/header.hbs' },
        stats: {
          template: 'modules/chronicle-sync/templates/hero-looks/chronicle/stats.hbs',
          // Edit mode draws Draw Steel's own stat editors, so they load first.
          templates: [...(Base.PARTS?.stats?.templates ?? [])],
        },
      }),
      // The folded sheet. Never drawn with the others.
      card: { template: 'modules/chronicle-sync/templates/hero-looks/chronicle/card.hbs' },
    };

    static TABS = chronicleTabs(Base.TABS);

    /** The whole window scrolls as one page; a redraw keeps the place. */
    #scrollTop = 0;

    /** Folded to the card; read from this player's saved state on first use. */
    #folded = null;

    /** The full sheet's size and place while folded, to unfold back to. */
    #fullPosition = null;

    #placeTimer = null;

    /** What the window holds now, "card" or "full", so a change of state clears it first. */
    #drawn = null;

    /** The menu button that had focus when a redraw closed its menu. */
    #refocus = null;

    /** Whether this window already told the player the card failed. */
    #cardFailureTold = false;

    /** Stamina, level and mode at the last draw, for the look's moves. */
    #seen = null;

    /** The timers taking each move's class off again. */
    #moveTimers = {};

    /** The look this hero is drawn in. */
    get look() {
      return resolveLook(this.document?.getFlag?.(FLAG_SCOPE, LOOK_FLAG), {
        worldDefault: setting(LOOK_DEFAULT_SETTING, DEFAULT_LOOK),
        locked: setting(LOOK_LOCK_SETTING, false) === true,
      });
    }

    /** Whether the sheet is folded to the card. A Limited viewer never is: the card shows Stamina. */
    get folded() {
      if (this.document?.limited) return false;
      if (this.#folded === null) this.#folded = this.#savedFold().folded === true;
      return this.#folded;
    }

    /** The hero's uuid, without dots, so nothing reads the key as a path. */
    #foldKey() {
      return String(this.document?.uuid ?? this.id).replace(/\./g, '~');
    }

    #savedFold() {
      const map = setting(FOLD_SETTING, {});
      return (map && typeof map === 'object' && map[this.#foldKey()]) || {};
    }

    #saveFold(patch) {
      try {
        const next = withFold(setting(FOLD_SETTING, {}), this.#foldKey(), patch);
        globalThis.game?.settings?.set(MODULE_ID, FOLD_SETTING, next)?.catch?.((err) => console.warn('Chronicle Sync | fold state not saved', err));
      } catch (err) {
        console.warn('Chronicle Sync | fold state not saved', err);
      }
    }

    /** The card's size, at this player's saved place when there is one. */
    #cardPosition() {
      const { left, top } = this.#savedFold();
      return { width: CARD_WIDTH, height: 'auto', ...(Number.isFinite(left) ? { left } : {}), ...(Number.isFinite(top) ? { top } : {}) };
    }

    /** @override */
    async render(options = {}, _options = {}) {
      // Foundry's older render(true) form.
      if (typeof options === 'boolean') options = Object.assign(_options, { force: options });
      if (!options || typeof options !== 'object') return super.render(options, _options);
      // Folding, or a permission change (a Limited viewer never folds), swaps
      // card and full sheet. Foundry replaces only the parts it draws, so the
      // old ones go first and the new state is drawn whole.
      const folded = this.folded;
      if (this.#drawn && this.#drawn !== (folded ? 'card' : 'full')) {
        for (const el of this.element?.querySelectorAll?.('.window-content > [data-application-part]') ?? []) el.remove();
        delete options.parts;
      }
      // Draw Steel asks for "stats" on a combat change; folded, that is the card.
      const parts = fitRenderParts(options.parts, { folded, known: Object.keys(this.constructor.PARTS) });
      if (parts) options.parts = parts;
      try {
        return await super.render(options, _options);
      } catch (err) {
        if (!folded) throw err;
        return this.#openFullAfterCardFailure(err);
      }
    }

    /**
     * The card failed to draw. Saved folded, the hero would fail again on
     * every open and leave no window to reach the picker or Foundry's sheet
     * chooser, so it is saved open and the full sheet drawn instead.
     */
    async #openFullAfterCardFailure(err) {
      console.warn('Chronicle Sync | hero card could not be drawn; opening the full sheet', err);
      clearTimeout(this.#placeTimer);
      this.#folded = false;
      this.#saveFold({ folded: false });
      if (!this.#cardFailureTold) {
        this.#cardFailureTold = true;
        globalThis.ui?.notifications?.warn(globalThis.game?.i18n?.localize('CHRONICLE.HeroSheet.CardFailed') ?? 'CHRONICLE.HeroSheet.CardFailed');
      }
      for (const el of this.element?.querySelectorAll?.('.window-content > [data-application-part]') ?? []) el.remove();
      this.#drawn = null;
      const full = this.#fullPosition ?? { width: this.options.position?.width, height: this.options.position?.height };
      this.#fullPosition = null;
      await super.render({ force: true });
      this.setPosition({ ...full });
      return this;
    }

    /** @override */
    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      if (!options.isFirstRender) return;
      // Open straight into the card, so the full sheet never flashes first.
      if (this.folded) options.position = { ...(options.position ?? {}), ...this.#cardPosition() };
      else if (LOOK_SIZE[this.look]) options.position = { ...(options.position ?? {}), ...LOOK_SIZE[this.look] };
    }

    /** @override */
    async _preFirstRender(context, options) {
      await super._preFirstRender?.(context, options);
      // Every look's templates, so changing the look draws at once. Opened as
      // the card, the full sheet's partials must still be ready for Open.
      const templates = [...allLookTemplates()];
      if (this.folded) templates.push(...Object.values(this.constructor.PARTS).flatMap((p) => [p.template, ...(p.templates ?? [])]));
      try {
        await globalThis.foundry?.applications?.handlebars?.loadTemplates?.([...new Set(templates.filter(Boolean))]);
      } catch (err) {
        console.warn('Chronicle Sync | hero sheet templates not preloaded', err);
      }
    }

    /** @override */
    _configureRenderParts(options) {
      const parts = super._configureRenderParts(options);
      const look = this.look;
      // Each part in the look's own template, or the Chronicle look's.
      const inLook = (id, part) => {
        const template = lookTemplate(look, id);
        return template && part ? { ...part, template } : part;
      };
      if (this.folded) return { card: inLook('card', parts.card ?? { ...this.constructor.PARTS.card }) };
      delete parts.card;
      for (const id of Object.keys(parts)) parts[id] = inLook(id, parts[id]);
      return parts;
    }

    /** @override */
    async _renderFrame(options) {
      const frame = await super._renderFrame(options);
      // On the frame, so the first paint already has the look and the fold.
      if (frame?.dataset) frame.dataset.csLook = this.look;
      frame?.classList?.toggle('cs-folded', this.folded);
      // Read by Chronicle's window grow (scripts/motion.mjs), which this look's opening replaces.
      frame?.classList?.toggle('cs-own-opening', OWN_OPENING_LOOKS.has(this.look) && !this.folded);
      forceDarkTheme(frame, DARK_LOOKS.has(this.look));
      return frame;
    }

    /** @override */
    async _preparePartContext(partId, context, options) {
      await super._preparePartContext(partId, context, options);
      if (partId === 'stats' || partId === 'card') {
        try {
          context.chronicle = this.#statsModel();
        } catch (err) {
          console.warn('Chronicle Sync | hero sheet boxes unavailable', err);
          context.chronicle = {};
        }
      }
      if (partId === 'card') {
        // Draw Steel prepares these for its header and stats parts only.
        try {
          context.avatarProperties = this._prepareAvatarCSS?.() ?? {};
          context.characteristics = this.document.system?._getCharacteristics?.(false) ?? {};
        } catch (err) {
          console.warn('Chronicle Sync | hero card details unavailable', err);
        }
      }
      return context;
    }

    /** @override */
    async _preRender(context, options) {
      await super._preRender(context, options);
      // The redraw replaces the portrait button; focus goes back to the new one.
      this.#refocus = closeHeroMenu(this.element)?.dataset?.action ?? null;
      this.#scrollTop = this.element?.querySelector?.('.window-content')?.scrollTop ?? 0;
    }

    /** @override */
    async _onRender(context, options) {
      await super._onRender(context, options);
      if (!this.element) return;
      this.element.dataset.csLook = this.look;
      this.element.classList.toggle('cs-folded', this.folded);
      this.element.classList.toggle('cs-own-opening', OWN_OPENING_LOOKS.has(this.look) && !this.folded);
      forceDarkTheme(this.element, DARK_LOOKS.has(this.look));
      this.#drawn = this.folded ? 'card' : 'full';
      try {
        this.#playMoves(options);
      } catch (err) {
        console.warn('Chronicle Sync | hero sheet move not played', err);
      }
      if (this.#refocus) {
        this.element.querySelector(`[data-action="${this.#refocus}"]`)?.focus?.();
        this.#refocus = null;
      }
      try {
        this.#syncTitleBar();
      } catch (err) {
        console.warn('Chronicle Sync | hero sheet title bar buttons not updated', err);
      }
      if (!options?.isFirstRender && this.#scrollTop && !this.folded) {
        const content = this.element.querySelector('.window-content');
        if (content) content.scrollTop = this.#scrollTop;
      }
    }

    /**
     * The look's own moves: its opening on the first draw, then a hit, a
     * heal, a level gained or Edit mode entered, each a class on the window
     * that the look's CSS animates and the motion level can stop.
     */
    #playMoves(options) {
      const sys = this.document?.system ?? {};
      const now = { stamina: sys.stamina?.value ?? null, level: sys.level ?? null, isPlay: this.isPlayMode !== false };
      const before = this.#seen;
      this.#seen = now;
      if (this.folded || !OWN_OPENING_LOOKS.has(this.look)) return;
      const moves = options?.isFirstRender ? ['open'] : sheetChanges(before, now);
      for (const move of moves) this.#play(move);
    }

    #play(move) {
      const el = this.element;
      const cls = `cs-move-${move}`;
      clearTimeout(this.#moveTimers[move]);
      // Taken off and put back, so a second hit restarts the move.
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      this.#moveTimers[move] = setTimeout(() => el.classList.remove(cls), MOVE_MS[move] ?? 1000);
    }

    /** @override */
    async _onFirstRender(context, options) {
      await super._onFirstRender(context, options);
      // In case Foundry placed the window before the card size was asked for.
      if (this.folded) this.setPosition(this.#cardPosition());
    }

    /** @override */
    _onPosition(position) {
      super._onPosition?.(position);
      if (!this.folded || !this.rendered) return;
      // Keep the card's place for next time, once the dragging stops.
      clearTimeout(this.#placeTimer);
      this.#placeTimer = setTimeout(() => {
        if (this.folded) this.#saveFold({ folded: true, left: position.left, top: position.top });
      }, 400);
    }

    /**
     * Fold and Sheet look, in the title bar beside Draw Steel's Edit lock.
     * Foundry draws frame buttons once, with the window.
     * @override
     */
    _getFrameButtons(options) {
      const buttons = [...(super._getFrameButtons?.(options) ?? [])];
      // Both always, hidden by #syncTitleBar while the viewer may not use them,
      // so a permission change while the sheet is open shows or hides them.
      buttons.push({ icon: this.folded ? UNFOLD_ICON : FOLD_ICON, label: this.folded ? 'CHRONICLE.HeroSheet.Unfold' : 'CHRONICLE.HeroSheet.Fold', action: 'csFold' });
      buttons.push({ icon: 'fa-solid fa-palette', label: 'CHRONICLE.HeroSheet.Picker.Title', action: 'csLookPicker' });
      return buttons;
    }

    /**
     * The title bar buttons for this viewer, on every redraw: Fold past
     * Limited, Sheet look for owners. Fold's icon and name follow the fold.
     */
    #syncTitleBar() {
      const header = this.window?.header ?? this.element.querySelector('.window-header');
      const fold = header?.querySelector('[data-action="csFold"]');
      if (fold) {
        fold.hidden = !!this.document?.limited;
        const label = globalThis.game?.i18n?.localize(this.folded ? 'CHRONICLE.HeroSheet.Unfold' : 'CHRONICLE.HeroSheet.Fold') ?? '';
        const icon = fold.querySelector('i') ?? fold;
        icon.classList.remove(...`${FOLD_ICON} ${UNFOLD_ICON}`.split(' '));
        icon.classList.add(...(this.folded ? UNFOLD_ICON : FOLD_ICON).split(' '));
        fold.setAttribute('aria-label', label);
        fold.dataset.tooltip = label;
      }
      const look = header?.querySelector('[data-action="csLookPicker"]');
      if (look) {
        look.hidden = !this.document?.isOwner;
        look.setAttribute('aria-haspopup', 'menu');
        if (!look.hasAttribute('aria-expanded')) look.setAttribute('aria-expanded', 'false');
      }
    }

    /** Fold to the card or open back to the full sheet. */
    async #setFolded(folded, { tab } = {}) {
      if (folded === this.folded || (folded && this.document?.limited)) return;
      closeHeroMenu(this.element);
      // A card place still waiting to be saved would fold the hero again.
      clearTimeout(this.#placeTimer);
      if (folded) this.#fullPosition = { ...this.position };
      this.#folded = folded;
      this.#saveFold({ folded });
      if (tab && this.tabGroups) this.tabGroups.primary = tab;
      await this.render();
      // The card failed and the full sheet opened instead, already in place.
      if (this.folded !== folded) return;
      const full = this.#fullPosition ?? { width: this.options.position?.width, height: this.options.position?.height };
      this.setPosition(folded ? this.#cardPosition() : { ...full });
      if (!folded) this.#fullPosition = null;
      (this.window?.header ?? this.element)?.querySelector?.('[data-action="csFold"]')?.focus?.();
    }

    static async #onFold() {
      await this.#setFolded(!this.folded);
    }

    static async #onUnfold(event, target) {
      await this.#setFolded(false, { tab: target?.dataset?.tab });
    }

    /** The look picker, under the title bar's Sheet look button. */
    static #onLookPicker(event, target) {
      if (!this.document?.isOwner) return;
      const i18n = globalThis.game.i18n;
      const anchor = target ?? this.window?.header?.querySelector?.('[data-action="csLookPicker"]');
      const registered = globalThis.CONFIG?.Actor?.sheetClasses?.hero ?? {};
      const rows = pickerRows({
        current: this.look,
        locked: setting(LOOK_LOCK_SETTING, false) === true,
        isGM: !!globalThis.game.user?.isGM,
        plusActive: !!globalThis.game.modules?.get?.(DRAW_STEEL_PLUS_MODULE)?.active,
        registered: (id) => id in registered,
      });
      openHeroMenu(this.element, anchor, {
        label: i18n.localize('CHRONICLE.HeroSheet.Picker.Title'),
        heading: i18n.format('CHRONICLE.HeroSheet.Picker.Heading', { name: this.document.name }),
        align: 'end',
        rows: rows.map((r, i) => ({
          label: i18n.localize(r.label),
          note: r.note ? i18n.localize(r.note) : null,
          tag: r.tag ? i18n.localize(r.tag) : null,
          icon: r.kind === 'look' ? (r.checked ? 'fa-solid fa-check' : 'fa-solid fa-palette') : 'fa-solid fa-book',
          checked: r.kind === 'look' ? r.checked : undefined,
          disabled: r.disabled,
          separatorBefore: r.kind === 'sheet' && rows[i - 1]?.kind === 'look',
        })),
        onPick: (i) => this.#pickLook(rows[i]),
      });
    }

    async #pickLook(row) {
      if (!row || row.disabled || !this.document?.isOwner) return;
      try {
        if (row.kind === 'look') {
          if (row.id !== this.look) await this.document.update({ [`flags.${FLAG_SCOPE}.${LOOK_FLAG}`]: row.id }, syncOptions());
        } else {
          // Foundry closes this sheet and opens the chosen one.
          await this.document.update({ 'flags.core.sheetClass': row.id }, syncOptions());
        }
      } catch (err) {
        console.warn('Chronicle Sync | hero sheet look not changed', err);
        globalThis.ui?.notifications?.warn(globalThis.game.i18n.localize('CHRONICLE.HeroSheet.Picker.Failed'));
      }
    }

    /** The portrait menu: the full picture, the token, and the hero's Chronicle page. */
    static #onPortraitMenu(event, target) {
      const i18n = globalThis.game.i18n;
      const actor = this.document;
      const user = globalThis.game.user;
      const url = chroniclePageUrl({
        apiUrl: setting('apiUrl', ''),
        campaignId: setting('campaignId', ''),
        entityId: actor.getFlag?.(FLAG_SCOPE, 'entityId'),
      });
      // As Draw Steel's "View Token Artwork": not a random image, not the stock token.
      const token = actor.prototypeToken;
      const tokenSrc = token?.randomImg ? null : token?.texture?.src;
      const rows = portraitRows({
        // The card has no portrait field for the file picker to fill.
        isPlay: this.folded || this.isPlayMode !== false,
        editable: !!this.isEditable,
        limited: !!actor.limited,
        isOwner: !!actor.isOwner,
        isGM: !!user?.isGM,
        mapped: hasChronicleAccount(user?.id),
        hasTokenArt: !!tokenSrc && tokenSrc !== globalThis.CONST?.DEFAULT_TOKEN,
        chronicleUrl: url,
      });
      const icons = { editImage: 'fa-solid fa-folder-open', showPortraitArtwork: 'fa-solid fa-image', showTokenArtwork: 'fa-solid fa-chess-pawn', csOpenChronicle: 'fa-solid fa-arrow-up-right-from-square' };
      openHeroMenu(this.element, target, {
        label: i18n.localize('CHRONICLE.HeroSheet.Portrait.Menu'),
        rows: rows.map((r) => ({ label: i18n.localize(r.label), note: r.note ? i18n.localize(r.note) : null, icon: icons[r.action] })),
        onPick: (i, pickEvent) => {
          const { action } = rows[i];
          if (action === 'csOpenChronicle') {
            if (url) globalThis.window?.open(url, 'chronicle-page', 'popup,noopener,width=1100,height=850');
            return;
          }
          // Draw Steel's and Foundry's own handlers; the file picker reads data-edit off the portrait.
          const portrait = this.element.querySelector('.cs-portrait') ?? target;
          const handler = inheritedAction(this, action);
          if (!handler) return;
          const failed = (err) => {
            console.warn(`Chronicle Sync | ${action} failed`, err);
            globalThis.ui?.notifications?.warn(i18n.localize('CHRONICLE.HeroSheet.Portrait.Failed'));
          };
          try {
            handler.call(this, pickEvent, portrait)?.catch?.(failed);
          } catch (err) {
            failed(err);
          }
        },
      });
    }

    #statsModel() {
      const actor = this.document;
      const sys = actor.system ?? {};
      const stamina = sys.stamina ?? {};
      const i18n = globalThis.game?.i18n;
      const effects = Object.values(globalThis.CONFIG?.statusEffects ?? {})
        .map((s) => ({ id: s.id, name: s.name ? (i18n?.localize(s.name) ?? s.name) : s.id, img: s.img }));
      // Winded and dying are Draw Steel's stamina states, shown on the bar.
      const staminaStates = Object.keys(globalThis.ds?.CONST?.staminaEffects ?? { winded: 1, dying: 1 });
      return {
        stamina: staminaView({
          value: stamina.value,
          max: stamina.max,
          temporary: stamina.temporary,
          winded: stamina.winded,
          min: stamina.min,
        }),
        recoveryDots: recoveryDots(sys.recoveries?.value, sys.recoveries?.max),
        conditions: conditionList(actor.statuses ?? [], effects, staminaStates),
        showEpic: (sys.level ?? 0) >= 10,
        // The portrait hall's plaques, ring and diamonds.
        metals: Object.fromEntries(Object.entries(sys.characteristics ?? {}).map(([key, c]) => [key, plaqueMetal(c?.value)])),
        ring: ringSegments(sys.recoveries?.value, sys.recoveries?.max),
        primaryDiamonds: countDiamonds(sys.hero?.primary?.value),
        surgeDiamonds: countDiamonds(sys.hero?.surges),
        epicDiamonds: countDiamonds(sys.hero?.epic?.value),
        skills: skillNames(sys.skills?.value, globalThis.ds?.CONFIG?.skills?.list, i18n?.lang),
      };
    }
  };
}

/**
 * Register the sheet for heroes when the world runs Draw Steel 1.1 or later.
 * Never the default, so Draw Steel's sheet (or another module's) stays the
 * world's.
 * @returns {boolean} whether it registered
 */
export function registerHeroLooks() {
  if (globalThis.game?.system?.id !== 'draw-steel') return false;
  if (!drawSteelSupported(globalThis.game.system.version)) return false;
  const Base = globalThis.ds?.applications?.sheets?.DrawSteelHeroSheet;
  if (typeof Base !== 'function') return false;
  registerHeroLookSettings();
  const Sheet = makeChronicleHeroSheet(Base);
  const options = { types: ['hero'], makeDefault: false, label: 'CHRONICLE.HeroSheet.Name' };
  const Actors = globalThis.foundry?.documents?.collections?.Actors;
  if (Actors?.registerSheet) Actors.registerSheet(MODULE_ID, Sheet, options);
  else foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, Sheet, options);
  return true;
}

/** Redraw every open Chronicle hero sheet, after the GM changes the look settings. */
function redrawHeroSheets() {
  for (const app of globalThis.foundry?.applications?.instances?.values?.() ?? []) {
    if (app?.options?.classes?.includes?.('chronicle-hero-sheet') && app.rendered) app.render();
  }
}

/**
 * The GM's world default look and lock, and each player's fold states. The
 * GM's two appear in the module settings only once there is more than one
 * look to choose from.
 */
function registerHeroLookSettings() {
  const settings = globalThis.game?.settings;
  if (!settings?.register) return;
  const choosable = HERO_LOOKS.length > 1;
  settings.register(MODULE_ID, LOOK_DEFAULT_SETTING, {
    name: 'CHRONICLE.HeroSheet.Settings.Default.Name',
    hint: 'CHRONICLE.HeroSheet.Settings.Default.Hint',
    scope: 'world',
    config: choosable,
    type: String,
    choices: Object.fromEntries(HERO_LOOKS.map((l) => [l.id, l.label])),
    default: DEFAULT_LOOK,
    onChange: redrawHeroSheets,
  });
  settings.register(MODULE_ID, LOOK_LOCK_SETTING, {
    name: 'CHRONICLE.HeroSheet.Settings.Lock.Name',
    hint: 'CHRONICLE.HeroSheet.Settings.Lock.Hint',
    scope: 'world',
    config: choosable,
    type: Boolean,
    default: false,
    onChange: redrawHeroSheets,
  });
  settings.register(MODULE_ID, FOLD_SETTING, {
    scope: 'client',
    config: false,
    type: Object,
    default: {},
  });
}
