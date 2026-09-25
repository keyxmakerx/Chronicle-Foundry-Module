/**
 * Chronicle Sync - Module Settings Registration
 *
 * Registers all module settings in Foundry's settings API.
 * Settings are stored per-world and only editable by GMs.
 */

import { MODULE_ID } from './constants.mjs';
import { UpdateInfoApplication } from './update-info.mjs';
import { SyncCalendarApplication } from './sync-calendar.mjs';

/**
 * Register all Chronicle Sync module settings.
 * Called once during the 'init' hook.
 */
export function registerSettings() {
  // Chronicle instance URL.
  game.settings.register(MODULE_ID, 'apiUrl', {
    name: game.i18n.localize('CHRONICLE.Settings.ApiUrl.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.ApiUrl.Hint'),
    scope: 'world',
    config: true,
    type: String,
    default: '',
    requiresReload: true,
  });

  // CLIENT scope, deliberately: a world-scoped setting syncs to every
  // connected client (config:false only hides it from the UI), which would
  // hand the campaign's Bearer token to any player's console. Sync runs
  // GM-only, so client scope is sufficient. migrateApiKeyToClientScope()
  // moves a legacy world-scoped value into the GM's browser and deletes the
  // world document so it stops syncing to players.
  game.settings.register(MODULE_ID, 'apiKey', {
    name: game.i18n.localize('CHRONICLE.Settings.ApiKey.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.ApiKey.Hint'),
    scope: 'client',
    config: true,
    type: String,
    default: '',
    requiresReload: true,
  });

  // Campaign UUID.
  game.settings.register(MODULE_ID, 'campaignId', {
    name: game.i18n.localize('CHRONICLE.Settings.CampaignId.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.CampaignId.Hint'),
    scope: 'world',
    config: true,
    type: String,
    default: '',
    requiresReload: true,
  });

  // Master sync toggle.
  game.settings.register(MODULE_ID, 'syncEnabled', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncEnabled.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncEnabled.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  // Per-feature toggles.
  game.settings.register(MODULE_ID, 'syncJournals', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncJournals.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncJournals.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'syncMaps', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncMaps.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncMaps.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'syncCalendar', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncCalendar.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncCalendar.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  // Notes sync toggle.
  game.settings.register(MODULE_ID, 'syncNotes', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncNotes.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncNotes.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  // Character sync toggle (requires matching game system).
  game.settings.register(MODULE_ID, 'syncCharacters', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncCharacters.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncCharacters.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  // Defense-in-depth layer on top of Chronicle's server-side sanitization
  // and Foundry's render-time sanitization: see _html-sanitizer.mjs.
  // Default false = sanitization ON; an operator can set true for
  // high-trust deployments where it strips legitimate inline styling.
  game.settings.register(MODULE_ID, 'skipIncomingSanitization', {
    name: game.i18n.localize('CHRONICLE.Settings.SkipIncomingSanitization.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SkipIncomingSanitization.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  // Calendar sub-resource chat announcements: Chronicle broadcasts weather /
  // world-state / season / era / moon-phase changes, surfaced as GM-ONLY
  // whispers, never public chat (re-broadcasting a dm_only payload publicly
  // would launder a server-side permission decision — see
  // CalendarSync._announceToGM). Season/era and weather default ON since
  // they change rarely; moon phases default OFF since they change every
  // few in-world days and would flood the log. All four toggle
  // independently of the dashboard panel.
  game.settings.register(MODULE_ID, 'calendarAnnounceWeather', {
    name: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceWeather.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceWeather.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'calendarAnnounceWorldstate', {
    name: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceWorldstate.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceWorldstate.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'calendarAnnounceSeasonEra', {
    name: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceSeasonEra.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceSeasonEra.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'calendarAnnounceMoon', {
    name: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceMoon.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.CalendarAnnounceMoon.Hint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  // Internal: detected Chronicle system ID matched from Foundry's game.system.id.
  game.settings.register(MODULE_ID, 'detectedSystem', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  });

  // Internal: last sync timestamp (not shown in UI).
  game.settings.register(MODULE_ID, 'lastSyncTime', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  });

  // Internal: Chronicle user → Foundry user ID mapping (not shown in settings UI).
  // Stored as JSON: { "chronicle-user-uuid": "foundry-user-id", ... }
  game.settings.register(MODULE_ID, 'userMappings', {
    scope: 'world',
    config: false,
    type: String,
    default: '{}',
  });

  // Internal: per-type and per-entity sync exclusions (not shown in settings UI).
  // Stored as JSON: { excludedTypes: [typeId, ...], excludedEntities: ["entityId", ...] }
  game.settings.register(MODULE_ID, 'syncExclusions', {
    scope: 'world',
    config: false,
    type: String,
    default: '{"excludedTypes":[],"excludedEntities":[]}',
  });

  // Internal: per-calendar sync opt-out. JSON array of Calendaria calendar ids
  // the operator has chosen NOT to sync to Chronicle (toggled from the Sync
  // Calendar editor). Empty by default → every active calendar syncs as before.
  game.settings.register(MODULE_ID, 'calendarSyncExclusions', {
    scope: 'world',
    config: false,
    type: String,
    default: '[]',
  });

  // -----------------------------------------------------------------------
  // Sync Configuration settings (managed via Config tab in dashboard)
  // -----------------------------------------------------------------------

  // Per-type sync direction: JSON map of sync type → direction.
  // Directions: "both" (bidirectional), "pull" (Chronicle→Foundry), "push" (Foundry→Chronicle), "off".
  game.settings.register(MODULE_ID, 'syncDirections', {
    scope: 'world',
    config: false,
    type: String,
    default: '{"journals":"both","maps":"both","calendar":"both","characters":"both","shops":"both","notes":"both"}',
  });

  // Permission mapping: sync Chronicle visibility to Foundry ownership levels.
  game.settings.register(MODULE_ID, 'syncPermissions', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: true,
  });

  // Default Foundry ownership level for player-visible synced documents.
  // Values: 0 (NONE), 1 (LIMITED), 2 (OBSERVER), 3 (OWNER).
  // Read by `_ownership.defaultLevelForVisibility`.
  game.settings.register(MODULE_ID, 'defaultOwnership', {
    scope: 'world',
    config: false,
    type: Number,
    default: 2,
  });

  // Whether DM-only entities should be hidden in Foundry (ownership NONE).
  game.settings.register(MODULE_ID, 'dmOnlyHidden', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: true,
  });

  // Conflict resolution strategy: "chronicle", "foundry", or "newest".
  game.settings.register(MODULE_ID, 'conflictResolution', {
    scope: 'world',
    config: false,
    type: String,
    default: 'chronicle',
  });

  // Auto-sync on change (true) vs manual-only (false).
  game.settings.register(MODULE_ID, 'autoSync', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: true,
  });

  // Tag-based exclusions: JSON array of tag names to exclude from sync.
  game.settings.register(MODULE_ID, 'excludedTags', {
    scope: 'world',
    config: false,
    type: String,
    default: '[]',
  });

  // Name pattern exclusion: entities matching this substring are excluded.
  game.settings.register(MODULE_ID, 'excludedNamePattern', {
    scope: 'world',
    config: false,
    type: String,
    default: '',
  });

  // Whether the import wizard has been completed at least once.
  game.settings.register(MODULE_ID, 'wizardCompleted', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  });

  // Dashboard layout preferences (per-user, per-browser).
  game.settings.register(MODULE_ID, 'dashboardActiveTab', {
    scope: 'client',
    config: false,
    type: String,
    default: 'entities',
  });

  game.settings.register(MODULE_ID, 'dashboardCollapsedTypes', {
    scope: 'client',
    config: false,
    type: String,
    default: '[]',
  });

  // "Update Source" panel — surfaces the install-time manifest URL Foundry
  // uses for module updates, lets the operator confirm whether the install
  // is wired to Chronicle (per-campaign signed URL) or still pointing at
  // GitHub, and provides a manual "Check Chronicle for updates" button.
  game.settings.registerMenu(MODULE_ID, 'updateInfo', {
    name: game.i18n.localize('CHRONICLE.Settings.UpdateInfo.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.UpdateInfo.Hint'),
    label: game.i18n.localize('CHRONICLE.Settings.UpdateInfo.Label'),
    icon: 'fa-solid fa-circle-info',
    type: UpdateInfoApplication,
    restricted: true,
  });

  // "Sync Calendar" — GM-only view of the active Calendaria calendar with
  // an always-on validation panel. i18n keys live under
  // `CHRONICLE.Settings.SyncCalendarMenu.*`, distinct from
  // `CHRONICLE.Settings.SyncCalendar.*` (the `syncCalendar` boolean
  // toggle's own hint/name).
  game.settings.registerMenu(MODULE_ID, 'syncCalendarMenu', {
    name: game.i18n.localize('CHRONICLE.Settings.SyncCalendarMenu.Name'),
    hint: game.i18n.localize('CHRONICLE.Settings.SyncCalendarMenu.Hint'),
    label: game.i18n.localize('CHRONICLE.Settings.SyncCalendarMenu.Label'),
    icon: 'fa-solid fa-calendar-days',
    type: SyncCalendarApplication,
    restricted: true,
  });
}

/**
 * Get a Chronicle Sync setting value.
 * @param {string} key - Setting key without module prefix.
 * @returns {*} The setting value.
 */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * One-time migration: move a legacy world-scoped API key into the GM's
 * client scope and delete the world-side Setting document. Deleting it is
 * the load-bearing step — otherwise the value stays in the world settings
 * collection every client receives, regardless of the key's registered
 * scope now.
 *
 * Runs GM-only, before the sync manager starts. Idempotent: with no legacy
 * document it does nothing and returns false.
 *
 * @returns {Promise<boolean>} true if a legacy world value was found and handled
 */
export async function migrateApiKeyToClientScope() {
  const worldStore = game.settings?.storage?.get?.('world');
  const legacy = worldStore?.getSetting?.(`${MODULE_ID}.apiKey`);
  if (!legacy) return false;

  let value = '';
  try {
    // Setting#value is the parsed value on v12+; fall back to the raw field.
    value = typeof legacy.value === 'string' ? legacy.value : String(legacy.value ?? '');
  } catch (_) { value = ''; }

  if (value && !game.settings.get(MODULE_ID, 'apiKey')) {
    await game.settings.set(MODULE_ID, 'apiKey', value);
  }
  if (typeof legacy.delete === 'function') await legacy.delete();

  console.info('Chronicle Sync | API key moved out of world settings (which every player could read) into this browser only.');
  ui?.notifications?.warn?.(
    'Chronicle Sync: your API key now lives in THIS browser only, not in the world. '
    + 'Other GMs (or this GM on another machine) must re-enter it in Module Settings. '
    + 'Consider rotating the key in Chronicle: it was readable by every player until now.',
    { permanent: true }
  );
  return true;
}

/**
 * Set a Chronicle Sync setting value.
 * @param {string} key - Setting key without module prefix.
 * @param {*} value - The value to set.
 */
export async function setSetting(key, value) {
  await game.settings.set(MODULE_ID, key, value);
}

/**
 * Get sync exclusions (excluded types and entities).
 * @returns {{ excludedTypes: number[], excludedEntities: string[] }}
 */
export function getSyncExclusions() {
  try {
    return JSON.parse(getSetting('syncExclusions'));
  } catch {
    return { excludedTypes: [], excludedEntities: [] };
  }
}

/**
 * Save sync exclusions.
 * @param {{ excludedTypes: number[], excludedEntities: string[] }} exclusions
 */
export async function setSyncExclusions(exclusions) {
  await setSetting('syncExclusions', JSON.stringify(exclusions));
}

/**
 * Get the list of Calendaria calendar ids the operator has opted OUT of syncing
 * to Chronicle. Empty array (default) means every active calendar syncs.
 * @returns {string[]}
 */
export function getCalendarSyncExclusions() {
  try {
    const parsed = JSON.parse(getSetting('calendarSyncExclusions'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Check if the module is properly configured (URL + key + campaign).
 * @returns {boolean}
 */
export function isConfigured() {
  const url = getSetting('apiUrl');
  const key = getSetting('apiKey');
  const campaign = getSetting('campaignId');
  if (!url || !key || !campaign) return false;
  // Validate URL is a proper HTTP(S) URL.
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Get sync directions config (per sync type).
 * @returns {{ journals: string, maps: string, calendar: string, characters: string, shops: string }}
 */
export function getSyncDirections() {
  try {
    return JSON.parse(getSetting('syncDirections'));
  } catch {
    return { journals: 'both', maps: 'both', calendar: 'both', characters: 'both', shops: 'both' };
  }
}

/**
 * Save sync directions config.
 * @param {object} directions
 */
export async function setSyncDirections(directions) {
  await setSetting('syncDirections', JSON.stringify(directions));
}

/**
 * Get excluded tags list.
 * @returns {string[]}
 */
export function getExcludedTags() {
  try {
    return JSON.parse(getSetting('excludedTags'));
  } catch {
    return [];
  }
}

/**
 * Save excluded tags list.
 * @param {string[]} tags
 */
export async function setExcludedTags(tags) {
  await setSetting('excludedTags', JSON.stringify(tags));
}

/**
 * Get user mappings (Chronicle user ID → Foundry user ID).
 * @returns {Object<string, string>}
 */
export function getUserMappings() {
  try {
    return JSON.parse(getSetting('userMappings'));
  } catch {
    return {};
  }
}

/**
 * Save user mappings.
 * @param {Object<string, string>} mappings
 */
export async function setUserMappings(mappings) {
  await setSetting('userMappings', JSON.stringify(mappings));
}

/**
 * Mask the API key input in the module settings dialog.
 * Foundry doesn't have a native password input type for settings,
 * so we convert it after the settings form renders.
 */
Hooks.on('renderSettingsConfig', (app, html) => {
  // v13: html is an HTMLElement; v12: html is a jQuery object.
  const root = html instanceof HTMLElement ? html : html[0] ?? html;
  const keyInput = root?.querySelector?.(`input[name="${MODULE_ID}.apiKey"]`);
  if (keyInput) {
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
  }
});
