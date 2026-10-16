/**
 * Chronicle Sync's Settings section: connection, what syncs, calendar
 * messages, players and advanced options. It is drawn inside the Chronicle
 * Sync window, and Foundry's Configure Settings menu opens that window at
 * this section. The save rules live in _settings-form.mjs; this file reads
 * the form and writes.
 */

import { MODULE_ID, FLAG_SCOPE } from './constants.mjs';
import { planSettingsSave, settingsView, SETTINGS_KEYS, SYNC_PARTS } from './_settings-form.mjs';
import { runConnectionTest, stepText } from './_connection-test.mjs';
import { noticeText } from './_escape-html.mjs';
import { buildMemberRows, memberKey } from './_member-mapping.mjs';
import { pickJournalCreateType } from './_journal-create.mjs';

const { ApplicationV2 } = foundry.applications.api;

const TABS = [
  { id: 'connection', icon: 'fa-link', label: 'Connection' },
  { id: 'sync', icon: 'fa-right-left', label: 'Sync' },
  { id: 'calendar', icon: 'fa-calendar-days', label: 'Calendar' },
  { id: 'players', icon: 'fa-users', label: 'Players' },
  { id: 'advanced', icon: 'fa-screwdriver-wrench', label: 'Advanced' },
];
const PART_ICONS = { journals: 'fa-book', maps: 'fa-map', calendar: 'fa-calendar-days', characters: 'fa-user', shops: 'fa-store' };
const STEP_ICONS = { check: 'fa-circle-check', xmark: 'fa-circle-xmark', warn: 'fa-triangle-exclamation' };
const SWITCHES = ['syncEnabled', 'syncCreatures', 'dmOnlyHidden', 'syncPermissions', 'autoSync', 'skipIncomingSanitization',
  'calendarAnnounceWeather', 'calendarAnnounceWorldstate', 'calendarAnnounceSeasonEra', 'calendarAnnounceMoon'];

const t = (key) => game.i18n.localize(`CHRONICLE.SettingsWindow.${key}`);

/**
 * What the Settings section remembers between renders of its window: the
 * page types fetched once, and the fields changed but not yet saved, so a
 * re-render of the window never throws away what the GM was typing.
 */
export function newSettingsState() {
  return { pageTypes: null, pageTypesTried: false, draft: new Map() };
}

/**
 * The template's context.
 * @param {ReturnType<typeof newSettingsState>} state
 */
export async function settingsContext(state) {
  const current = readCurrent();
  const view = settingsView(current);
  const syncManager = game.modules.get(MODULE_ID)?.api?.syncManager;
  // Fetched once per window, failure included, so a slow or unreachable
  // Chronicle doesn't hold up every re-render of the window.
  if (!state.pageTypesTried && syncManager?.api) {
    state.pageTypesTried = true;
    try { state.pageTypes = unwrapList(await syncManager.api.get('/entity-types')); } catch { state.pageTypes = null; }
  }
  const typeId = state.pageTypes ? pickJournalCreateType(state.pageTypes, current.journalCreateTypeId) : null;
  const dirLabels = { both: t('Both'), pull: t('Pull'), push: t('Push') };
  return {
    tabs: TABS.map((tab) => ({ ...tab, label: t(`Tabs.${tab.label}`) })),
    view,
    connected: !!syncManager?._connectedAt,
    pageTypes: (state.pageTypes ?? [])
      .filter((pt) => pt && Number(pt.id) > 0 && pt.enabled !== false)
      .map((pt) => ({ id: pt.id, name: pt.name_plural || pt.name, selected: Number(pt.id) === typeId })),
    members: memberRows(syncManager),
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

/**
 * Wire what Foundry's click actions don't: the draft kept across re-renders,
 * a switched-off part greying out, Undo, and Save.
 * @param {HTMLFormElement} form
 * @param {ReturnType<typeof newSettingsState>} state
 * @param {() => void} onSaved - redraws the window, so the form's saved
 *   values (what Undo returns to) and every section reflect the save
 */
export function wireSettingsForm(form, state, onSaved) {
  if (!form) return;
  restoreDraft(form, state.draft);
  const greyParts = () => form.querySelectorAll('.cs-part input[type="checkbox"]').forEach((box) => {
    box.closest('.cs-part')?.classList.toggle('is-off', !box.checked);
  });
  greyParts();
  const remember = (ev) => {
    const el = ev.target;
    if (el.type === 'radio' && !el.checked) return;
    if (el.name) state.draft.set(el.name, el.type === 'checkbox' ? { checked: el.checked } : { value: el.value });
    else if (el.dataset?.memberKey) state.draft.set(`member:${el.dataset.memberKey}`, { value: el.value });
  };
  form.addEventListener('input', remember);
  form.addEventListener('change', (ev) => { remember(ev); greyParts(); });
  // The browser resets the fields after this event, so grey the parts once it has.
  form.addEventListener('reset', () => { state.draft.clear(); setTimeout(greyParts, 0); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const saved = await saveSettingsForm(form);
    if (!saved) return;
    state.draft.clear();
    onSaved?.();
  });
}

/** The Test connection button: tries the typed values, else the saved ones. */
export async function testConnection(root, button) {
  const list = root.querySelector('[data-steps]');
  const current = readCurrent();
  const value = (name) => root.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
  button.disabled = true;
  list?.replaceChildren(stepItem('wait', game.i18n.localize('CHRONICLE.ConnectionTest.Testing')));
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
    list?.replaceChildren(...steps.map((s, n) => stepItem(s.icon, stepText(s, format), n)));
  } finally {
    button.disabled = false;
  }
}

/** The Players tab's Refresh button: fetch Chronicle's members again. */
export async function refreshMembers(button) {
  button.disabled = true;
  try {
    await game.modules.get(MODULE_ID)?.api?.syncManager?.fetchAndCacheMembers?.();
  } finally {
    button.disabled = false;
  }
}

/** The Setup Wizard button. */
export async function startImport() {
  const { ImportWizard } = await import('./import-wizard.mjs');
  // The wizard reaches Chronicle through the sync manager it is bound to.
  const wizard = ImportWizard.instance;
  wizard.bind(game.modules.get(MODULE_ID)?.api?.syncManager);
  wizard.render({ force: true });
}

/**
 * Save the form.
 * @param {HTMLFormElement} form
 * @returns {Promise<boolean>} whether it saved
 */
export async function saveSettingsForm(form) {
  const data = readForm(form);
  const parts = {};
  for (const part of SYNC_PARTS) {
    parts[part] = { on: !!data[`part.${part}.on`], direction: data[`part.${part}.direction`] };
  }
  const values = {
    connectLine: data.connectLine, apiUrl: data.apiUrl, apiKey: data.apiKey, campaignId: data.campaignId,
    parts,
    defaultOwnership: data.defaultOwnership, conflictResolution: data.conflictResolution,
    excludedTags: data.excludedTags, excludedNamePattern: data.excludedNamePattern,
    journalCreateTypeId: data.journalCreateTypeId,
    members: changedMemberLinks(form),
  };
  for (const key of SWITCHES) values[key] = !!data[key];
  try {
    const plan = planSettingsSave(values, readCurrent());
    for (const [key, value] of plan.writes) await game.settings.set(MODULE_ID, key, value);
    if (plan.writes.some(([key]) => key === 'userMappings')) {
      game.modules.get(MODULE_ID)?.api?.syncManager?.logActivity?.('link', 'Player links changed in Chronicle settings');
    }
    let reconnect = plan.connectionChanged;
    if (plan.connectLine) {
      const { applyConnectLine } = await import('./settings.mjs');
      reconnect = (await applyConnectLine(plan.connectLine)) || reconnect;
    }
    ui.notifications.info(t('Saved'));
    if (reconnect) ui.notifications.warn(t('ReloadToConnect'));
    return true;
  } catch (err) {
    console.error('Chronicle Sync | Saving settings failed:', err?.message);
    ui.notifications.error(game.i18n.format('CHRONICLE.SettingsWindow.SaveFailed', { message: noticeText(err?.message ?? '') }));
    return false;
  }
}

/**
 * Foundry's Configure Settings menu entry. Foundry renders the class it is
 * given; this one opens the Chronicle Sync window at Settings instead of a
 * window of its own.
 */
export class ChronicleSettingsMenu extends ApplicationV2 {
  /** @override */
  async render() {
    openChronicleSettings();
    return this;
  }
}

/**
 * Open Chronicle Sync at its Settings section.
 * @param {string} [tab] - connection, sync, calendar, players or advanced
 */
export function openChronicleSettings(tab) {
  return game.modules.get(MODULE_ID)?.api?.openDashboard?.(tab ? `settings:${tab}` : 'settings');
}

/**
 * Only the member dropdowns the GM changed, so opening and saving the
 * window never rewrites a link nobody touched.
 * @param {HTMLElement} el
 */
function changedMemberLinks(el) {
  const changed = {};
  for (const select of el?.querySelectorAll?.('select[data-member-key]') ?? []) {
    const initial = [...select.options].find((o) => o.defaultSelected)?.value ?? '';
    if (select.value !== initial) changed[select.dataset.memberKey] = select.value;
  }
  return changed;
}

/** The form's named fields: switches as booleans, a radio group as its picked value. */
function readForm(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
    else data[el.name] = el.value;
  }
  return data;
}

/** Put back what the GM had changed before the window re-rendered. */
function restoreDraft(form, draft) {
  for (const [name, saved] of draft) {
    const els = name.startsWith('member:')
      ? form.querySelectorAll(`select[data-member-key="${CSS.escape(name.slice(7))}"]`)
      : form.querySelectorAll(`[name="${CSS.escape(name)}"]`);
    for (const el of els) {
      if (el.type === 'checkbox') el.checked = saved.checked;
      else if (el.type === 'radio') el.checked = el.value === saved.value;
      else el.value = saved.value;
    }
  }
}

/** A list answer is a bare array or `{data: [...]}`. */
function unwrapList(raw) {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.data) ? raw.data : [];
}

/** The Players tab's rows: one per Chronicle member, with its Foundry player. */
function memberRows(syncManager) {
  const members = syncManager?.getMembers?.() ?? [];
  let mappings = {};
  try { mappings = JSON.parse(game.settings.get(MODULE_ID, 'userMappings')) || {}; } catch { /* unreadable: show unlinked */ }
  const foundryUsers = (game.users?.contents ?? []).map((u) => ({ id: u.id, name: u.name }));
  const claimantKeys = (game.actors?.contents ?? [])
    .filter((a) => a.getFlag?.(FLAG_SCOPE, 'entityId'))
    .map((a) => a.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId'))
    .filter(Boolean);
  return buildMemberRows({ members, mappings, foundryUsers, keyOf: memberKey, claimantKeys }).rows;
}

function readCurrent() {
  return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, game.settings.get(MODULE_ID, key)]));
}

/** One test step as a list item; the text goes in as text, never markup. */
function stepItem(icon, text, order = 0) {
  const li = document.createElement('li');
  li.className = `cs-step cs-step-${icon} cs-peek`;
  // The results land together; a small stagger reads them in as one by one.
  li.style.animationDelay = `${order * 70}ms`;
  const i = document.createElement('i');
  i.className = `fa-solid ${STEP_ICONS[icon] ?? 'fa-spinner fa-spin'}`;
  i.setAttribute('aria-hidden', 'true');
  li.append(i, document.createTextNode(text));
  return li;
}
