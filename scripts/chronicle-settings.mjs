/**
 * The Chronicle settings window: connection, what syncs, calendar messages,
 * players and advanced options in one tabbed window, opened from Foundry's
 * Configure Settings (a GM-only menu) or the Sync Dashboard. The save rules
 * live in _settings-form.mjs; this file only reads the form and writes.
 */

import { MODULE_ID } from './constants.mjs';
import { planSettingsSave, settingsView, SETTINGS_KEYS, SYNC_PARTS } from './_settings-form.mjs';
import { runConnectionTest, stepText } from './_connection-test.mjs';
import { noticeText } from './_escape-html.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TABS = [
  { id: 'connection', icon: 'fa-link', label: 'Connection' },
  { id: 'sync', icon: 'fa-right-left', label: 'Sync' },
  { id: 'calendar', icon: 'fa-calendar-days', label: 'Calendar' },
  { id: 'players', icon: 'fa-users', label: 'Players' },
  { id: 'advanced', icon: 'fa-screwdriver-wrench', label: 'Advanced' },
];
const PART_ICONS = { journals: 'fa-book', maps: 'fa-map', calendar: 'fa-calendar-days', characters: 'fa-user', shops: 'fa-store' };
const STEP_ICONS = { check: 'fa-circle-check', xmark: 'fa-circle-xmark', warn: 'fa-triangle-exclamation' };

const t = (key) => game.i18n.localize(`CHRONICLE.SettingsWindow.${key}`);

export class ChronicleSettingsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'chronicle-settings',
    classes: ['chronicle-settings'],
    tag: 'form',
    window: {
      title: 'CHRONICLE.SettingsWindow.Title',
      icon: 'fa-solid fa-book-open',
      contentClasses: ['chronicle-settings-content'],
    },
    position: { width: 580 },
    form: {
      handler: ChronicleSettingsWindow.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true,
    },
    actions: {
      testConnection: ChronicleSettingsWindow.#onTestConnection,
      openMembers: ChronicleSettingsWindow.#onOpenMembers,
    },
  };

  static PARTS = {
    body: { template: 'modules/chronicle-sync/templates/chronicle-settings.hbs' },
  };

  /** @type {string} */
  _activeTab = 'connection';

  /** @override */
  async _prepareContext() {
    const current = readCurrent();
    const view = settingsView(current);
    const dirLabels = { both: t('Both'), pull: t('Pull'), push: t('Push') };
    return {
      activeTab: this._activeTab,
      tabs: TABS.map((tab) => ({ ...tab, label: t(`Tabs.${tab.label}`), active: tab.id === this._activeTab })),
      view,
      connected: !!game.modules.get(MODULE_ID)?.api?.syncManager?._connectedAt,
      labels: { direction: t('Direction') },
      parts: view.parts.map((p) => ({
        ...p,
        icon: PART_ICONS[p.part],
        name: t(`Parts.${p.part}.Name`),
        hint: t(`Parts.${p.part}.Hint`),
        directions: ['both', 'pull', 'push'].map((value) => ({ value, label: dirLabels[value], checked: value === p.direction })),
      })),
      announce: Object.entries(view.announce).map(([key, on]) => ({
        key, on, label: t(`Announce.${key}`),
        hint: key === 'calendarAnnounceMoon' ? `${t('AnnounceHint')} ${t('MoonHint')}` : t('AnnounceHint'),
      })),
      ownership: [2, 1, 0, 3].map((value) => ({ value, label: t(`Ownership.${value}`), selected: value === view.defaultOwnership })),
      conflict: ['chronicle', 'foundry', 'newest'].map((value) => ({ value, label: t(`Conflict.${value}`), selected: value === view.conflictResolution })),
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    const tabs = [...el.querySelectorAll('.cs-tabs [role="tab"]')];
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => this.#showTab(tab.dataset.tab));
      // Arrow keys move between tabs, as the tab pattern expects.
      tab.addEventListener('keydown', (ev) => {
        const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        const next = tabs[(i + step + tabs.length) % tabs.length];
        this.#showTab(next.dataset.tab);
        next.focus();
      });
    });
    el.querySelectorAll('.cs-part input[type="checkbox"]').forEach((box) => {
      box.addEventListener('change', () => box.closest('.cs-part')?.classList.toggle('is-off', !box.checked));
    });
  }

  #showTab(id) {
    this._activeTab = id;
    const el = this.element;
    el.querySelectorAll('.cs-tabs [role="tab"]').forEach((tab) => {
      const on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    el.querySelectorAll('.cs-panel').forEach((panel) => {
      const on = panel.dataset.panel === id;
      panel.hidden = !on;
      if (on) { panel.classList.remove('cs-settle'); void panel.offsetWidth; panel.classList.add('cs-settle'); }
    });
  }

  static async #onTestConnection(_event, button) {
    const el = this.element;
    const list = el.querySelector('[data-steps]');
    const current = readCurrent();
    const value = (name) => el.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
    button.disabled = true;
    list.replaceChildren(stepItem('wait', game.i18n.localize('CHRONICLE.ConnectionTest.Testing')));
    try {
      const steps = await runConnectionTest({
        baseUrl: value('apiUrl') || current.apiUrl,
        apiKey: value('apiKey') || current.apiKey,
        campaignId: value('campaignId') || current.campaignId,
        foundrySystemId: game.system?.id,
        origin: window.location.origin,
        fetchImpl: (...args) => fetch(...args),
      });
      const format = (key, data) => game.i18n.format(key, data);
      list.replaceChildren(...steps.map((s) => stepItem(s.icon, stepText(s, format))));
    } finally {
      button.disabled = false;
    }
  }

  static async #onOpenMembers() {
    // A fresh dashboard opens on the saved tab; an open one switches to it.
    await game.settings.set(MODULE_ID, 'dashboardActiveTab', 'members');
    game.modules.get(MODULE_ID)?.api?.openDashboard?.()?._switchTab?.('members');
  }

  static async #onSubmit(_event, _form, formData) {
    const data = formData.object;
    const parts = {};
    for (const part of SYNC_PARTS) {
      parts[part] = { on: !!data[`part.${part}.on`], direction: data[`part.${part}.direction`] };
    }
    const form = {
      connectLine: data.connectLine, apiUrl: data.apiUrl, apiKey: data.apiKey, campaignId: data.campaignId,
      parts,
      defaultOwnership: data.defaultOwnership, conflictResolution: data.conflictResolution,
      excludedTags: data.excludedTags, excludedNamePattern: data.excludedNamePattern,
    };
    for (const key of ['syncEnabled', 'dmOnlyHidden', 'syncPermissions', 'autoSync', 'skipIncomingSanitization',
      'calendarAnnounceWeather', 'calendarAnnounceWorldstate', 'calendarAnnounceSeasonEra', 'calendarAnnounceMoon']) {
      form[key] = !!data[key];
    }
    try {
      const plan = planSettingsSave(form, readCurrent());
      for (const [key, value] of plan.writes) await game.settings.set(MODULE_ID, key, value);
      let reconnect = plan.connectionChanged;
      if (plan.connectLine) {
        const { applyConnectLine } = await import('./settings.mjs');
        reconnect = (await applyConnectLine(plan.connectLine)) || reconnect;
      }
      ui.notifications.info(t('Saved'));
      if (reconnect) ui.notifications.warn(t('ReloadToConnect'));
    } catch (err) {
      console.error('Chronicle Sync | Saving settings failed:', err?.message);
      ui.notifications.error(game.i18n.format('CHRONICLE.SettingsWindow.SaveFailed', { message: noticeText(err?.message ?? '') }));
    }
  }
}

function readCurrent() {
  return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, game.settings.get(MODULE_ID, key)]));
}

/** One test step as a list item; the text goes in as text, never markup. */
function stepItem(icon, text) {
  const li = document.createElement('li');
  li.className = `cs-step cs-step-${icon}`;
  const i = document.createElement('i');
  i.className = `fa-solid ${STEP_ICONS[icon] ?? 'fa-spinner fa-spin'}`;
  i.setAttribute('aria-hidden', 'true');
  li.append(i, document.createTextNode(text));
  return li;
}
