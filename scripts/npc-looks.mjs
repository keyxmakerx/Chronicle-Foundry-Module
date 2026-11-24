/**
 * The Chronicle NPC and monster sheet: Draw Steel's own NPC sheet, drawn
 * like the Chronicle hero sheet, in two shapes. The monster shape puts the
 * stat block first: characteristics, Stamina, damage, conditions and the
 * villain actions used this fight. The NPC shape puts the talk first: the
 * negotiation beside Stamina, a Talk tab with the motivations and pitfalls
 * and the argument log, and a People tab, with an honest "No stat block
 * yet" where Draw Steel would show empty defaults.
 *
 * It is built on the hero sheet (makeChronicleHeroSheet), so the fold to a
 * card, the look picker, the portrait menu and each look's moves are the
 * hero sheet's, and every roll, button and drop is Draw Steel's. Draw
 * Steel's NPCs and monsters are one actor type, so this is one sheet; the
 * shape follows the Chronicle page the actor came from, or a hand pick in
 * Edit mode.
 *
 * What only the Director may know (the full negotiation, the page's text and
 * links) is read live from Chronicle on the Director's screen and never
 * saved in Foundry. Players' screens read the actor, which holds only what
 * players may know. Villain action marks live on the fight, so they clear
 * when it ends. Offered beside Draw Steel's sheet, never the default.
 */

import { FLAG_SCOPE, MODULE_ID, syncOptions } from './constants.mjs';
import { makeChronicleHeroSheet } from './hero-looks.mjs';
import { chroniclePageUrl, conditionList, drawSteelSupported, staminaView } from './_hero-looks.mjs';
import { LINK_FLAG, TALK_FLAG, castAction } from './npc-presence.mjs';
import { isTalkLive } from './_npc-presence.mjs';
import { SHOWN_FLAG } from './_negotiation-mirror.mjs';
import {
  NPC_ONLY, SHAPE_FLAG, SHAPES, VILLAIN_FLAG,
  allNpcLookTemplates, hasStatBlock, negotiationView, npcChanges, npcLook, npcLookTemplate, npcPageId, npcParts, onlyYouView,
  npcTabs, openingTab, pageChips, pageText, peopleRows, sheetShape, villainKey, villainMarks, withVillainUse,
} from './_npc-looks.mjs';

/** The id Foundry stores for the sheet; renaming the class orphans every actor's choice. */
export const NPC_SHEET_CLASS = `${MODULE_ID}.ChronicleNpcSheet`;

/** Draw Steel's own NPC sheet, which the look picker always offers. */
export const DRAW_STEEL_NPC_SHEET = 'draw-steel.DrawSteelNPCSheet';

/** The flag creature sync puts on a creature page's actor (scripts/creature-sync.mjs). */
export const CREATURE_FLAG = 'creatureEntityId';

/** How long the Director's live read of the page is reused before reading again (ms). */
const LIVE_TTL_MS = 30 * 1000;

/** How long a draw waits for Chronicle before showing what the actor holds (ms). */
const LIVE_WAIT_MS = 4000;

/** The Chronicle API client, once the sync manager has one (GM only). */
let getApi = () => null;

/** A module setting, or `fallback` before it is registered. */
function setting(key, fallback) {
  try {
    return globalThis.game.settings.get(MODULE_ID, key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** A promise that gives up after `ms`, so a slow Chronicle can't hold the sheet. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]);
}

/** The inherited handler for a Draw Steel or Foundry sheet action, from the class chain. */
function baseAction(Base, name) {
  for (let cls = Base; cls; cls = Object.getPrototypeOf(cls)) {
    const entry = cls.DEFAULT_OPTIONS?.actions?.[name];
    if (entry) return typeof entry === 'function' ? entry : entry.handler ?? null;
  }
  return null;
}

/**
 * Build the sheet class on Draw Steel's NPC sheet. A factory, because the
 * base exists only once Draw Steel has loaded.
 * @param {typeof Application} Base  ds.applications.sheets.DrawSteelNPCSheet
 */
export function makeChronicleNpcSheet(Base) {
  const Hero = makeChronicleHeroSheet(Base);
  const useAbility = baseAction(Base, 'useAbility');

  return class ChronicleNpcSheet extends Hero {
    static DEFAULT_OPTIONS = {
      classes: ['chronicle-npc-sheet'],
      actions: {
        csTalk: ChronicleNpcSheet.#onTalk,
        csVillain: ChronicleNpcSheet.#onVillain,
        csShape: ChronicleNpcSheet.#onShape,
        csOpenPage: ChronicleNpcSheet.#onOpenPage,
        csToggleLog: ChronicleNpcSheet.#onToggleLog,
        csOnlyYou: ChronicleNpcSheet.#onOnlyYou,
        useAbility: ChronicleNpcSheet.#onUseAbility,
      },
    };

    static PARTS = npcParts(Base.PARTS ?? {}, {
      header: { template: npcLookTemplate('chronicle', 'monster', 'header') },
      stats: {
        template: npcLookTemplate('chronicle', 'monster', 'stats'),
        // Edit mode draws Draw Steel's own stat editors, so they load first.
        templates: [...(Base.PARTS?.stats?.templates ?? [])],
      },
      card: { template: npcLookTemplate('chronicle', 'monster', 'card') },
    });

    static TABS = npcTabs(Base.TABS);

    /** The Director's live read of the page: negotiation, text and links. */
    #live = null;

    #liveAt = 0;

    #liveFor = null;

    #liveFailed = false;

    /** What this draw shows, built once per draw for every part. */
    #model = null;

    /** Whether the Director's "Only you" drawer is open; kept across redraws. */
    #onlyYouOpen = false;

    /** The shape this actor is drawn in. */
    get shape() {
      const doc = this.document;
      return sheetShape({
        flag: doc?.getFlag?.(FLAG_SCOPE, SHAPE_FLAG),
        pageId: doc?.getFlag?.(FLAG_SCOPE, 'entityId'),
        creatureId: doc?.getFlag?.(FLAG_SCOPE, CREATURE_FLAG),
        linkedId: doc?.getFlag?.(FLAG_SCOPE, LINK_FLAG),
      });
    }

    /** The hero look, where it has NPC and monster templates; else the Chronicle look. */
    get look() {
      return npcLook(super.look);
    }

    /** @override */
    _csPageId() {
      const doc = this.document;
      return npcPageId({
        pageId: doc?.getFlag?.(FLAG_SCOPE, 'entityId'),
        creatureId: doc?.getFlag?.(FLAG_SCOPE, CREATURE_FLAG),
        linkedId: doc?.getFlag?.(FLAG_SCOPE, LINK_FLAG),
      });
    }

    /** @override */
    _csLookTemplate(look, partId) {
      return npcLookTemplate(look, this.shape, partId);
    }

    /** @override */
    _csAllTemplates() {
      return allNpcLookTemplates();
    }

    /** @override */
    _csStatsModel() {
      return this.#model?.chronicle ?? {};
    }

    /** @override */
    _csPickerSheets() {
      return { registered: globalThis.CONFIG?.Actor?.sheetClasses?.npc ?? {}, drawSteelSheet: DRAW_STEEL_NPC_SHEET, plusSheet: null };
    }

    /** @override */
    _csMoveState() {
      const m = this.#model ?? {};
      return {
        ...super._csMoveState(),
        villainUsed: m.villain ? m.villain.total - m.villain.left : null,
        malice: m.malice?.show ? m.malice.value : null,
        band: m.chronicle?.stamina?.band ?? null,
        interest: m.negotiation?.interest ?? null,
        motives: m.negotiation?.rows ?? [],
      };
    }

    /** @override */
    _csMoves(before, now) {
      return npcChanges(before, now, super._csMoves(before, now));
    }

    /** @override */
    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      // The first tab follows the moment the sheet is opened in, once.
      if (options.isFirstRender && !this.document?.limited) {
        this.tabGroups.primary = openingTab(this.shape, !!this.#fight());
      }
    }

    /** @override */
    _configureRenderParts(options) {
      const parts = super._configureRenderParts(options);
      if (this.shape !== 'npc' || this.folded) for (const id of NPC_ONLY) delete parts[id];
      // People is the page's links, and the drawer its secrets: only the Director's screen reads them.
      if (!globalThis.game?.user?.isGM) {
        delete parts.people;
        delete parts.onlyYou;
      }
      if (this.shape !== 'npc' || this.folded) delete parts.onlyYou;
      return parts;
    }

    /** @override */
    _prepareTabs(group) {
      const tabs = super._prepareTabs(group);
      if (group !== 'primary' || this.document?.limited) return tabs;
      if (this.shape !== 'npc') for (const id of NPC_ONLY) delete tabs[id];
      if (!globalThis.game?.user?.isGM) delete tabs.people;
      // A shape change can take away the open tab; open the first one left.
      if (!tabs[this.tabGroups.primary]) {
        const first = tabs.abilities ?? Object.values(tabs)[0];
        if (first) {
          this.tabGroups.primary = first.id;
          first.active = true;
          first.cssClass = [first.cssClass, 'active'].filter(Boolean).join(' ');
        }
      }
      return tabs;
    }

    /** @override */
    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      try {
        this.#model = await this.#buildModel();
      } catch (err) {
        console.warn('Chronicle Sync | NPC sheet figures unavailable', err);
        this.#model = { shape: this.shape, chronicle: {} };
      }
      context.npc = this.#model;
      return context;
    }

    /** @override */
    async _preparePartContext(partId, context, options) {
      await super._preparePartContext(partId, context, options);
      if (partId === 'card') {
        // Draw Steel prepares these for its header only.
        const sys = this.document.system ?? {};
        context.showMalice = !!globalThis.game?.user?.isGM && !sys.isMinion;
        context.malice = globalThis.game?.actors?.malice ?? null;
      }
      return context;
    }

    /** @override */
    async _onRender(context, options) {
      await super._onRender(context, options);
      if (!this.element) return;
      const shape = this.shape;
      this.element.classList.toggle('cs-shape-npc', shape === 'npc');
      this.element.classList.toggle('cs-shape-monster', shape === 'monster');
      // The Talk tab shows the negotiation, so Biography doesn't repeat it in play.
      this.element.classList.toggle('cs-has-talk', shape === 'npc' && !this.document?.limited);
      this.element.classList.toggle('cs-play', this.isPlayMode !== false);
      try {
        this.#markUsedVillainRows();
      } catch (err) {
        console.warn('Chronicle Sync | villain action marks not shown', err);
      }
      try {
        this.#drawOnlyYouTab();
      } catch (err) {
        console.warn('Chronicle Sync | the Only you drawer is unavailable', err);
      }
    }

    /**
     * The amber "Only you" tab at the end of the tab row, for the Director
     * on an NPC read from its page. It opens the drawer over the tab showing
     * instead of switching tabs, so it is a button, not one of Draw Steel's tabs.
     */
    #drawOnlyYouTab() {
      const nav = this.element.querySelector('nav.tabs[data-group="primary"]');
      const drawer = this.element.querySelector('.cs-only-you');
      nav?.querySelector('.cs-only-you-tab')?.remove();
      if (!nav || !drawer || !this.#model?.onlyYou) {
        this.#onlyYouOpen = false;
        return;
      }
      const i18n = globalThis.game.i18n;
      const btn = globalThis.document.createElement('button');
      btn.type = 'button';
      btn.className = 'cs-only-you-tab cs-dm-only';
      btn.dataset.action = 'csOnlyYou';
      btn.setAttribute('aria-controls', drawer.id);
      const mark = globalThis.document.createElement('span');
      mark.className = 'cs-dm-mark';
      mark.textContent = i18n.localize('CHRONICLE.NpcSheet.OnlyYouTab');
      btn.append(mark);
      nav.append(btn);
      this.#applyOnlyYou({ focus: false });
      // A redraw of other parts keeps this drawer, so its key handler is added once.
      if (drawer.dataset.csKeys) return;
      drawer.dataset.csKeys = '1';
      drawer.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        this.#onlyYouOpen = false;
        this.#applyOnlyYou({ focus: true });
      });
    }

    /** Picking a tab closes the drawer, so the tab picked is what shows. */
    changeTab(...args) {
      super.changeTab(...args);
      if (!this.#onlyYouOpen) return;
      this.#onlyYouOpen = false;
      this.#applyOnlyYou({ focus: false });
    }

    /** Show or hide the drawer to match its state; focus follows it when asked. */
    #applyOnlyYou({ focus }) {
      const drawer = this.element?.querySelector('.cs-only-you');
      const btn = this.element?.querySelector('.cs-only-you-tab');
      if (!drawer || !btn) return;
      drawer.hidden = !this.#onlyYouOpen;
      btn.setAttribute('aria-expanded', String(this.#onlyYouOpen));
      this.element.classList.toggle('cs-only-you-open', this.#onlyYouOpen);
      if (!focus) return;
      if (this.#onlyYouOpen) drawer.querySelector('.cs-oy-close')?.focus();
      else btn.focus();
    }

    /** Dim the villain actions used this fight in Draw Steel's own Abilities list. */
    #markUsedVillainRows() {
      const used = new Set((this.#model?.villain?.marks ?? []).filter((m) => m.state === 'used').map((m) => m.id));
      const word = globalThis.game?.i18n?.localize('CHRONICLE.NpcSheet.Villain.Used') ?? 'Used';
      for (const row of this.element.querySelectorAll('.tab.abilities li.item[data-document-uuid]')) {
        const id = String(row.dataset.documentUuid).split('.').pop();
        const on = used.has(id);
        row.classList.toggle('cs-used', on);
        let tag = row.querySelector('.cs-used-word');
        if (on && !tag) {
          tag = globalThis.document.createElement('span');
          tag.className = 'cs-used-word';
          tag.textContent = word;
          row.querySelector('.item-order, .item-name .name')?.append(tag);
        } else if (!on) tag?.remove();
      }
    }

    /** The fight this actor is in on the viewed scene, or null. */
    #fight() {
      const combat = globalThis.game?.combat;
      const uuid = this.document?.uuid;
      if (!combat || !uuid) return null;
      return combat.combatants?.some?.((c) => c.actor?.uuid === uuid) ? combat : null;
    }

    /** The actor's token on the viewed scene, for the Talking toggle. */
    #token() {
      const own = this.document?.token?.object;
      if (own) return own;
      return this.document?.getActiveTokens?.(false, false)?.[0] ?? null;
    }

    /** The villain actions in Draw Steel's order, as its Abilities list numbers them. */
    #villainActions() {
      return (this.document?.itemTypes?.ability ?? [])
        .filter((i) => i.system?.type === 'villain' && !i.getFlag?.('draw-steel', 'hideInSheet'))
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .map((i) => ({ id: i.id, name: i.name }));
    }

    /**
     * Read the page from Chronicle for the Director: the negotiation tracker,
     * and for an NPC its text and links. Kept in memory for a short while.
     * A tracker that doesn't exist yet is not a failure; an unreachable
     * Chronicle is, and the sheet then shows what the actor holds.
     */
    async #loadLive(pageId, { force = false } = {}) {
      if (!force && this.#liveFor === pageId && Date.now() - this.#liveAt < LIVE_TTL_MS) return;
      const api = getApi();
      if (!api) {
        this.#live = null;
        this.#liveFailed = true;
        return;
      }
      const tolerate404 = (p) => p.catch((err) => {
        if (err?.status === 404) return null;
        throw err;
      });
      try {
        const [negotiation, entity, relations] = await within(Promise.all([
          tolerate404(api.get(`/entities/${pageId}/system-state/drawsteel/negotiation`)),
          tolerate404(api.get(`/entities/${pageId}`)),
          tolerate404(api.get(`/entities/${pageId}/relations`)),
        ]), LIVE_WAIT_MS);
        this.#live = { gm: negotiation?.gm ?? null, entity, relations };
        this.#liveFailed = false;
      } catch (err) {
        console.warn('Chronicle Sync | NPC page not read from Chronicle', err);
        this.#live = null;
        this.#liveFailed = true;
      }
      this.#liveFor = pageId;
      this.#liveAt = Date.now();
    }

    /** Read the page again on the next draw (its tracker changed in Chronicle). */
    forgetLive() {
      this.#liveAt = 0;
    }

    async #buildModel() {
      const actor = this.document;
      const sys = actor.system ?? {};
      const game = globalThis.game;
      const i18n = game?.i18n;
      const isGM = !!game?.user?.isGM;
      const shape = this.shape;
      const pageId = this._csPageId();
      const linked = shape === 'npc' && !!pageId;
      if (linked && isGM && !actor.limited) await this.#loadLive(pageId);
      const live = linked && isGM ? this.#live : null;

      const motivations = globalThis.ds?.CONFIG?.negotiation?.motivations ?? {};
      const labelOf = (key) => {
        const label = motivations[key]?.label;
        return label ? (i18n?.localize(label) ?? label) : key;
      };
      const negotiation = shape === 'npc' ? negotiationView({
        linked,
        isGM,
        live,
        liveFailed: linked && isGM && this.#liveFailed,
        actorNeg: sys.negotiation ?? null,
        shownFlag: actor.getFlag?.(FLAG_SCOPE, SHOWN_FLAG),
        labelOf,
      }) : null;
      if (negotiation) {
        const text = (v) => (v === null || v === undefined ? '–' : String(v));
        negotiation.interestText = text(negotiation.interest);
        negotiation.patienceText = text(negotiation.patience);
        negotiation.impressionText = text(negotiation.impression ?? (isGM && !linked ? sys.negotiation?.impression : null));
      }

      const stamina = sys.stamina ?? {};
      const effects = Object.values(globalThis.CONFIG?.statusEffects ?? {})
        .map((s) => ({ id: s.id, name: s.name ? (i18n?.localize(s.name) ?? s.name) : s.id, img: s.img }));
      const staminaStates = Object.keys(globalThis.ds?.CONST?.staminaEffects ?? { winded: 1, dying: 1 });

      const combat = this.#fight();
      const used = combat?.getFlag?.(FLAG_SCOPE, VILLAIN_FLAG)?.[villainKey(actor.uuid)] ?? [];
      const villain = villainMarks(this.#villainActions(), used);

      const token = isGM && shape === 'npc' ? this.#token() : null;
      const page = live?.entity ? pageText(live.entity.entry_html) : { open: [], secrets: [] };

      return {
        shape,
        isGM,
        linked,
        pageId,
        live: !!live,
        liveFailed: linked && isGM && this.#liveFailed,
        statBlock: hasStatBlock({ staminaMax: stamina.max, abilityCount: actor.itemTypes?.ability?.length ?? 0 }),
        chronicle: {
          stamina: staminaView({ value: stamina.value, max: stamina.max, temporary: stamina.temporary, winded: stamina.winded, min: stamina.min }),
          conditions: conditionList(actor.statuses ?? [], effects, staminaStates),
        },
        negotiation,
        villain: { ...villain, inFight: !!combat, canMark: isGM && !!combat },
        malice: { show: isGM && !sys.isMinion, value: game?.actors?.malice?.value ?? null },
        talk: {
          show: !!token,
          tokenId: token?.id ?? null,
          pressed: !!token && isTalkLive(token.document?.getFlag?.(FLAG_SCOPE, TALK_FLAG), Date.now()),
        },
        page: {
          open: page.open,
          chips: live?.entity ? pageChips(live.entity, {
            factionLabel: i18n?.localize('CHRONICLE.NpcSheet.Faction') ?? 'Faction',
            tagLabel: i18n?.localize('CHRONICLE.NpcSheet.Tag') ?? 'Tag',
          }) : [],
        },
        people: live ? peopleRows(live.relations, pageId) : [],
        onlyYou: shape === 'npc' ? onlyYouView({ isGM, live: !!live, secrets: page.secrets, negotiation }) : null,
        pageUrl: isGM && pageId ? chroniclePageUrl({ apiUrl: setting('apiUrl', ''), campaignId: setting('campaignId', ''), entityId: pageId }) : null,
        shapes: SHAPES.map((id) => ({ id, label: `CHRONICLE.NpcSheet.Shape.${id}`, checked: id === shape })),
        canShape: !!actor.isOwner,
      };
    }

    /** Talking: the token's talking glow, the same switch as its token HUD's. */
    static async #onTalk() {
      const tokenId = this.#model?.talk?.tokenId;
      if (!tokenId || !globalThis.game?.user?.isGM) return;
      await castAction(tokenId, 'talk');
      this.render({ parts: ['header', 'card'] });
    }

    /** Mark a villain action used this fight, or take the mark back. Director only. */
    static async #onVillain(event, target) {
      const combat = this.#fight();
      const itemId = target?.dataset?.itemId;
      if (!combat || !itemId || !globalThis.game?.user?.isGM) return;
      await this.#setVillainUsed(combat, itemId);
    }

    async #setVillainUsed(combat, itemId, used) {
      const key = villainKey(this.document.uuid);
      const next = withVillainUse(combat.getFlag(FLAG_SCOPE, VILLAIN_FLAG), key, itemId, used);
      try {
        // Only this monster's list is written, so another sheet's marks are never overwritten.
        await combat.update({ [`flags.${FLAG_SCOPE}.${VILLAIN_FLAG}.${key}`]: next[key] ?? [] });
      } catch (err) {
        console.warn('Chronicle Sync | villain action mark not saved', err);
        globalThis.ui?.notifications?.warn(globalThis.game.i18n.localize('CHRONICLE.NpcSheet.Villain.Failed'));
      }
    }

    /**
     * Draw Steel's own ability use. A villain action the Director uses in a
     * fight is marked used once its chat card is posted (not when cancelled).
     */
    static async #onUseAbility(event, target) {
      const id = String(target?.closest?.('[data-document-uuid]')?.dataset?.documentUuid ?? '').split('.').pop();
      const item = this.document?.items?.get?.(id);
      const combat = this.#fight();
      if (item?.type !== 'ability' || item.system?.type !== 'villain' || !combat || !globalThis.game?.user?.isGM) {
        return useAbility?.call(this, event, target);
      }
      const message = await item.system.use({ event });
      if (message) await this.#setVillainUsed(combat, item.id, true);
      return message;
    }

    /** Pick the shape by hand, in Edit mode. Owners only. */
    static async #onShape(event, target) {
      const shape = target?.dataset?.shape;
      if (!SHAPES.includes(shape) || !this.document?.isOwner || shape === this.shape) return;
      try {
        await this.document.update({ [`flags.${FLAG_SCOPE}.${SHAPE_FLAG}`]: shape }, syncOptions());
      } catch (err) {
        console.warn('Chronicle Sync | sheet shape not changed', err);
      }
    }

    /** Open the actor's Chronicle page in a window, as the portrait menu does. */
    static #onOpenPage() {
      const url = this.#model?.pageUrl;
      if (url) globalThis.window?.open(url, 'chronicle-page', 'popup,noopener,width=1100,height=850');
    }

    /** Show or hide the argument log, without a redraw. */
    /** Open or close the Director's "Only you" drawer. */
    static #onOnlyYou() {
      this.#onlyYouOpen = !this.#onlyYouOpen;
      this.#applyOnlyYou({ focus: true });
    }

    static #onToggleLog(event, target) {
      const log = this.element?.querySelector('.cs-log');
      if (!log) return;
      log.hidden = !log.hidden;
      target?.setAttribute?.('aria-expanded', String(!log.hidden));
    }
  };
}

/** Open Chronicle NPC sheets, for the hooks that redraw them. */
function npcSheets() {
  return [...(globalThis.foundry?.applications?.instances?.values?.() ?? [])]
    .filter((app) => app?.options?.classes?.includes?.('chronicle-npc-sheet') && app.rendered);
}

/** Redraw the NPC sheets showing an actor, or every one when no uuid is given. */
function redrawFor(actorUuids, parts) {
  const want = actorUuids ? new Set(actorUuids) : null;
  for (const app of npcSheets()) {
    if (!want || want.has(app.document?.uuid)) app.render(parts ? { parts } : {});
  }
}

/**
 * The redraws the sheet's own figures need: a villain action marked on the
 * fight, a fight ending, Malice changing, a token's talking glow, and the
 * negotiation changing in Chronicle.
 */
function registerNpcSheetHooks() {
  const Hooks = globalThis.Hooks;
  if (!Hooks?.on) return;
  const actorsIn = (combat) => [...(combat?.combatants ?? [])].map((c) => c.actor?.uuid).filter(Boolean);
  Hooks.on('updateCombat', (combat, change) => {
    if (foundry.utils.hasProperty(change, `flags.${FLAG_SCOPE}.${VILLAIN_FLAG}`)) redrawFor(actorsIn(combat));
  });
  Hooks.on('deleteCombat', (combat) => redrawFor(actorsIn(combat)));
  Hooks.on('createCombatant', (c) => redrawFor([c.actor?.uuid]));
  Hooks.on('deleteCombatant', (c) => redrawFor([c.actor?.uuid]));
  Hooks.on('updateSetting', (s) => {
    if (s?.key === 'draw-steel.malice') redrawFor(null, ['header', 'card']);
  });
  Hooks.on('updateToken', (token, change) => {
    if (foundry.utils.hasProperty(change, `flags.${FLAG_SCOPE}.${TALK_FLAG}`)
      || foundry.utils.hasProperty(change, `flags.${FLAG_SCOPE}.-=${TALK_FLAG}`)) {
      redrawFor([token.actor?.uuid], ['header', 'card']);
    }
  });
  Hooks.on('chronicleSyncNegotiation', (entityId) => {
    for (const app of npcSheets()) {
      if (app._csPageId?.() === entityId) {
        app.forgetLive?.();
        app.render();
      }
    }
  });
}

/**
 * Register the sheet for Draw Steel NPCs when the world runs Draw Steel 1.1
 * or later, after the hero sheet (whose look settings it shares). Never the
 * default, so Draw Steel's sheet (or another module's) stays the world's.
 * @param {() => {get: Function}|null} apiGetter  the Chronicle API client (GM only)
 * @returns {boolean} whether it registered
 */
export function registerNpcLooks(apiGetter) {
  if (globalThis.game?.system?.id !== 'draw-steel') return false;
  if (!drawSteelSupported(globalThis.game.system.version)) return false;
  const Base = globalThis.ds?.applications?.sheets?.DrawSteelNPCSheet;
  if (typeof Base !== 'function') return false;
  if (typeof apiGetter === 'function') getApi = apiGetter;
  const Sheet = makeChronicleNpcSheet(Base);
  const options = { types: ['npc'], makeDefault: false, label: 'CHRONICLE.NpcSheet.Name' };
  const Actors = globalThis.foundry?.documents?.collections?.Actors;
  if (Actors?.registerSheet) Actors.registerSheet(MODULE_ID, Sheet, options);
  else foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, Sheet, options);
  registerNpcSheetHooks();
  return true;
}
