/**
 * The Chronicle sheet: synced journals drawn as Chronicle pages (#258).
 *
 * It is Foundry's own JournalEntrySheet with a Chronicle header (category,
 * folder, title, tags), a facts and contents panel beside the pages, and
 * Chronicle's look from `styles/chronicle-sheet.css`. Everything else stays
 * Foundry's: page rendering, editing, Reveal, Show players, permissions and
 * other modules' header buttons, so a Foundry update or another module
 * keeps working on it. Pages are shown one after another, like one long
 * Chronicle page. If the extra parts fail to draw, the sheet is just
 * Foundry's.
 *
 * Chronicle's CSS is never copied: the look follows `.ai/ui-standard.md` on
 * this module's tokens, and the campaign's own choices arrive as values
 * (TODO(#258): accent and heading face once Chronicle#1781 sends them).
 *
 * The sheet is offered once to each linked journal through
 * `flags.core.sheetClass` (`sheetClassPlan`), so a GM who picks another
 * sheet for a journal keeps it. Foundry 13 and later; on 12 journals keep
 * Foundry's sheet.
 */

import { FLAG_SCOPE, MODULE_ID, syncOptions } from './constants.mjs';
import { getSetting } from './settings.mjs';
import { CHRONICLE_SHEET_CLASS, sheetClassPlan, sheetModel } from './_chronicle-sheet-model.mjs';

/** Flag recording that the sheet was offered to a journal once. */
export const SHEET_OFFERED_FLAG = 'chronicleSheetOffered';

const Base = globalThis.foundry?.applications?.sheets?.journal?.JournalEntrySheet;

function entityUrl(entityId) {
  const apiUrl = String(getSetting('apiUrl') || '').replace(/\/+$/, '');
  const campaignId = getSetting('campaignId');
  if (!apiUrl || !campaignId || !entityId) return null;
  return `${apiUrl}/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`;
}

function syncedAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return game.i18n.localize('CHRONICLE.Sheet.Linked');
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return game.i18n.localize('CHRONICLE.Sheet.SyncedNow');
  if (mins < 60) return game.i18n.format('CHRONICLE.Sheet.SyncedMinutes', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return game.i18n.format('CHRONICLE.Sheet.SyncedHours', { n: hours });
  return game.i18n.format('CHRONICLE.Sheet.SyncedDays', { n: Math.floor(hours / 24) });
}

export const ChronicleJournalSheet = Base ? class ChronicleJournalSheet extends Base {
  static DEFAULT_OPTIONS = {
    classes: ['chronicle-sheet'],
    position: { width: 860, height: 680 },
    actions: {
      chronicleGoTo: ChronicleJournalSheet.#goTo,
      chronicleOpen: ChronicleJournalSheet.#openInChronicle,
      chronicleUseFoundry: ChronicleJournalSheet.#useFoundrySheet,
    },
  };

  static PARTS = {
    chronicleHead: { template: `modules/${MODULE_ID}/templates/chronicle-sheet-head.hbs` },
    ...Base.PARTS,
    chronicleAside: { template: `modules/${MODULE_ID}/templates/chronicle-sheet-aside.hbs` },
  };

  /** One long page, like Chronicle, rather than a page at a time. */
  get mode() {
    return this.constructor.VIEW_MODES?.MULTIPLE ?? super.mode;
  }

  /** Foundry may set a mode while it builds the sheet; this one keeps one long page. */
  set mode(_value) { /* one long page */ }

  /** @override */
  _getHeaderControls() {
    const controls = [...(super._getHeaderControls?.() ?? [])];
    if (entityUrl(this.document.getFlag(FLAG_SCOPE, 'entityId'))) {
      controls.push({ icon: 'fa-solid fa-arrow-up-right-from-square', label: 'CHRONICLE.Sheet.OpenInChronicle', action: 'chronicleOpen' });
    }
    if (game.user.isGM) {
      controls.push({ icon: 'fa-solid fa-repeat', label: 'CHRONICLE.Sheet.UseFoundry', action: 'chronicleUseFoundry' });
    }
    return controls;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    const ctx = await super._preparePartContext(partId, context, options);
    if (partId !== 'chronicleHead' && partId !== 'chronicleAside') return ctx;
    try {
      ctx.chronicle = this.#model();
    } catch (err) {
      console.warn('Chronicle Sync | Chronicle sheet details unavailable', err);
      ctx.chronicle = null;
    }
    return ctx;
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    // The contents panel replaces the page list; it stays one click away.
    try {
      if (this.sidebarExpanded) this.toggleSidebar();
    } catch { /* Foundry's own layout stays */ }
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    try {
      this.#drawSyncState();
    } catch (err) {
      console.warn('Chronicle Sync | Chronicle sheet sync state unavailable', err);
    }
  }

  #model() {
    const j = this.document;
    const flags = j.flags?.[FLAG_SCOPE] ?? {};
    const category = flags.entityType || '';
    const folder = j.folder && j.folder.name !== category ? j.folder.name : null;
    const pages = j.pages.contents
      .filter((p) => p.testUserPermission(game.user, 'OBSERVER'))
      .map((p) => ({ id: p.id, name: p.name, type: p.type, sort: p.sort, isPlayerNotes: p.getFlag(FLAG_SCOPE, 'isPlayerNotes') === true }));
    const tags = (flags.tags || []).map((t) => (typeof t === 'string' ? t : t?.name));
    return {
      id: j.id,
      title: j.name,
      ...sheetModel({ category, folder, tags, facts: flags.facts, pages }, {
        overview: game.i18n.localize('CHRONICLE.Sheet.Overview'),
        playerNotes: game.i18n.localize('CHRONICLE.Sheet.PlayerNotes'),
      }),
    };
  }

  /** The sync dot in the title bar, as the signed mockup has it. */
  #drawSyncState() {
    const header = this.window?.header ?? this.element?.querySelector?.('.window-header');
    if (!header) return;
    let el = header.querySelector('.cs-sync');
    if (!el) {
      el = document.createElement('span');
      el.className = 'cs-sync';
      const title = header.querySelector('.window-title');
      (title ?? header.firstChild)?.after?.(el);
    }
    const linked = !!this.document.getFlag(FLAG_SCOPE, 'entityId');
    el.hidden = !linked;
    el.textContent = syncedAgo(this.document.getFlag(FLAG_SCOPE, 'lastSync'));
  }

  static #goTo(event, target) {
    const pageId = target?.dataset?.pageId;
    if (pageId) this.goToPage(pageId);
  }

  static #openInChronicle() {
    const url = entityUrl(this.document.getFlag(FLAG_SCOPE, 'entityId'));
    if (url) window.open(url, '_blank', 'noopener');
  }

  static async #useFoundrySheet() {
    if (!game.user.isGM) return;
    // "" is the default sheet; the offer flag stays, so it is not offered again.
    await this.document.update({ 'flags.core.sheetClass': '' }, syncOptions());
  }
} : null;

/**
 * Register the sheet for journals. Never the default: it is set per linked
 * journal, so unlinked journals and other modules' sheets are untouched.
 * @returns {boolean} whether it registered
 */
export function registerChronicleSheet() {
  if (!ChronicleJournalSheet) return false;
  const Config = foundry.applications?.apps?.DocumentSheetConfig ?? globalThis.DocumentSheetConfig;
  Config.registerSheet(JournalEntry, MODULE_ID, ChronicleJournalSheet, {
    makeDefault: false,
    label: 'CHRONICLE.Sheet.Name',
  });
  // Labels the stylesheet draws on secret blocks, in the user's language.
  const root = document.documentElement.style;
  for (const [name, key] of [['--cs-l-gm-only', 'GMOnly'], ['--cs-l-shown', 'Shown'], ['--cs-l-show', 'ShowPlayers'], ['--cs-l-hide', 'HideFromPlayers']]) {
    root.setProperty(name, JSON.stringify(game.i18n.localize(`CHRONICLE.Sheet.${key}`)));
  }
  return true;
}

/** Whether linked journals should get the sheet now. */
export function chronicleSheetEnabled() {
  if (!ChronicleJournalSheet) return false;
  // Monk's Enhanced Journal replaces journal sheets itself.
  if (game.modules.get('monks-enhanced-journal')?.active) return false;
  try {
    return getSetting('chronicleSheet') !== false;
  } catch {
    return false;
  }
}

/** Flags a new linked journal is created with, so it opens as a Chronicle page. */
export function newJournalSheetFlags() {
  return chronicleSheetEnabled()
    ? { core: { sheetClass: CHRONICLE_SHEET_CLASS }, [FLAG_SCOPE]: { [SHEET_OFFERED_FLAG]: true } }
    : {};
}

/**
 * Offer the sheet to linked journals, or take it back when the setting is
 * off. Active GM only; one batched write, marked as sync's own.
 * @returns {Promise<number>} journals changed
 */
export async function applyChronicleSheetSetting() {
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return 0;
  const journals = (game.journal?.contents ?? []).map((j) => ({
    id: j.id,
    linked: !!j.getFlag(FLAG_SCOPE, 'entityId'),
    sheetClass: j.getFlag('core', 'sheetClass') || '',
    offered: j.getFlag(FLAG_SCOPE, SHEET_OFFERED_FLAG) === true,
  }));
  const plan = sheetClassPlan(journals, chronicleSheetEnabled());
  if (!plan.length) return 0;
  await JournalEntry.updateDocuments(plan.map((u) => ({
    _id: u.id,
    'flags.core.sheetClass': u.sheetClass,
    [`flags.${FLAG_SCOPE}.${SHEET_OFFERED_FLAG}`]: u.offered,
  })), syncOptions());
  return plan.length;
}
