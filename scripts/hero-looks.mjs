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
 */

import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';
import {
  LOOK_FLAG, chronicleParts, chronicleTabs, conditionList, drawSteelSupported, recoveryDots, resolveLook, staminaView,
} from './_hero-looks.mjs';

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
    };

    static PARTS = chronicleParts(Base.PARTS ?? {}, {
      header: { template: 'modules/chronicle-sync/templates/hero-looks/chronicle/header.hbs' },
      stats: {
        template: 'modules/chronicle-sync/templates/hero-looks/chronicle/stats.hbs',
        // Edit mode draws Draw Steel's own stat editors, so they load first.
        templates: [...(Base.PARTS?.stats?.templates ?? [])],
      },
    });

    static TABS = chronicleTabs(Base.TABS);

    /** The whole window scrolls as one page; a redraw keeps the place. */
    #scrollTop = 0;

    /** The look this hero is drawn in. */
    get look() {
      return resolveLook(this.document?.getFlag?.(FLAG_SCOPE, LOOK_FLAG));
    }

    /** @override */
    async _renderFrame(options) {
      const frame = await super._renderFrame(options);
      // On the frame, so the first paint already has the look.
      if (frame?.dataset) frame.dataset.csLook = this.look;
      return frame;
    }

    /** @override */
    async _preparePartContext(partId, context, options) {
      await super._preparePartContext(partId, context, options);
      if (partId === 'stats') {
        try {
          context.chronicle = this.#statsModel();
        } catch (err) {
          console.warn('Chronicle Sync | hero sheet boxes unavailable', err);
          context.chronicle = {};
        }
      }
      return context;
    }

    /** @override */
    async _preRender(context, options) {
      await super._preRender(context, options);
      this.#scrollTop = this.element?.querySelector?.('.window-content')?.scrollTop ?? 0;
    }

    /** @override */
    async _onRender(context, options) {
      await super._onRender(context, options);
      if (!this.element) return;
      this.element.dataset.csLook = this.look;
      if (!options?.isFirstRender && this.#scrollTop) {
        const content = this.element.querySelector('.window-content');
        if (content) content.scrollTop = this.#scrollTop;
      }
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
  const Sheet = makeChronicleHeroSheet(Base);
  const options = { types: ['hero'], makeDefault: false, label: 'CHRONICLE.HeroSheet.Name' };
  const Actors = globalThis.foundry?.documents?.collections?.Actors;
  if (Actors?.registerSheet) Actors.registerSheet(MODULE_ID, Sheet, options);
  else foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, Sheet, options);
  return true;
}
