/**
 * Chronicle Sync - Foundry VTT Module Entry Point
 *
 * Registers settings, initializes the sync manager, and connects to the
 * Chronicle backend on the 'ready' hook. All sync features are coordinated
 * through the SyncManager which owns the WebSocket connection.
 */

import { registerSettings, migrateApiKeyToClientScope } from './settings.mjs';
import { SyncManager } from './sync-manager.mjs';
import { JournalSync } from './journal-sync.mjs';
import { MapSync } from './map-sync.mjs';
import { ShopWidget } from './shop-widget.mjs';
import { CalendarSync } from './calendar-sync.mjs';
import { ActorSync } from './actor-sync.mjs';
import { ItemSync } from './item-sync.mjs';
import { NoteSync } from './note-sync.mjs';
import { SyncDashboard } from './sync-dashboard.mjs';
import { MapViewerSheet } from './map-viewer.mjs';
import { registerCharacterClaimIndicator } from './character-claim-indicator.mjs';
import { surfaceManifestRecoveryIfNeeded } from './update-info.mjs';
import { openSyncCalendar } from './sync-calendar.mjs';

/** @type {SyncManager|null} */
let syncManager = null;

/** @type {SyncDashboard|null} */
let dashboard = null;

/** @type {HTMLElement|null} Sidebar status indicator, re-attached on re-render. */
let _statusIndicatorEl = null;

/**
 * Open the Sync Dashboard, recreating the singleton if it isn't currently
 * rendered. An ApplicationV2 instance can be left in a non-re-renderable state
 * after a close (notably when the close interrupts an in-flight render), which
 * made the dashboard intermittently fail to reopen. Mirrors the SyncCalendar
 * singleton helper: bring an already-open window to the front; otherwise build,
 * (re)bind, and render a fresh instance. `bind()` only sets a reference, so
 * recreating leaks nothing.
 * @returns {SyncDashboard|null}
 */
function openDashboard() {
  if (dashboard && dashboard.rendered) {
    dashboard.bringToFront?.();
    return dashboard;
  }
  dashboard = new SyncDashboard();
  if (syncManager) dashboard.bind(syncManager);
  dashboard.render({ force: true });
  return dashboard;
}

/**
 * Module initialization — register settings.
 * This runs before the game is fully ready.
 */
Hooks.once('init', () => {
  console.debug('Chronicle Sync | Initializing');
  registerSettings();

  // Register Chronicle Map Viewer as an alternate sheet for image journal pages.
  DocumentSheetConfig.registerSheet(JournalEntryPage, 'chronicle-sync', MapViewerSheet, {
    types: ['image'],
    makeDefault: false,
    label: 'Chronicle Map Viewer',
  });

  // Register Handlebars helpers used by dashboard/shop templates.
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('neq', (a, b) => a !== b);
  Handlebars.registerHelper('lt', (a, b) => a < b);
  // PR 3 (Sync Calendar): serialize a value as JSON for embedding in a
  // data-* attribute. The recurrence preset buttons stash their
  // `paramsTemplate` object here so the click handler can decode it.
  Handlebars.registerHelper('json', (v) => new Handlebars.SafeString(JSON.stringify(v ?? {})));
  Handlebars.registerHelper('timeAgo', (isoString) => {
    if (!isoString) return 'Never';
    const diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'Just now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  });
});

/**
 * Game ready — start the sync manager and connect to Chronicle.
 * Only GMs run the full sync; players just get passive updates via
 * Foundry's native document sync.
 */
Hooks.once('ready', async () => {
  console.debug('Chronicle Sync | Ready');

  syncManager = new SyncManager();

  // Register all sync modules.
  syncManager.registerModule(new JournalSync());
  syncManager.registerModule(new MapSync());
  syncManager.registerModule(new ShopWidget());
  syncManager.registerModule(new CalendarSync());
  syncManager.registerModule(new ActorSync());
  syncManager.registerModule(new ItemSync());
  syncManager.registerModule(new NoteSync());

  // Create UI first so it's always available, even if start() fails.
  dashboard = new SyncDashboard();
  dashboard.bind(syncManager);
  _addStatusIndicator();
  registerCharacterClaimIndicator();

  // FM-SEC-KEY-SCOPE: move a world-scoped API key into this GM's client
  // scope and delete the world copy BEFORE start() reads the setting. GM
  // only — players never held a legitimate copy and must not write one.
  if (game.user.isGM) {
    try {
      await migrateApiKeyToClientScope();
    } catch (err) {
      console.error('Chronicle Sync | API key scope migration failed', err);
    }
  }

  // Start the sync manager (connects WebSocket, performs initial sync).
  // Failure is non-fatal; the dashboard remains accessible for diagnostics.
  try {
    await syncManager.start();

    // Surface a positive confirmation when maps materialized so the
    // operator isn't left wondering whether anything happened. Silent
    // when zero — the dashboard / error log carries that case.
    if (game.user.isGM) {
      const mapSync = syncManager._modules?.find((m) => m.constructor?.name === 'MapSync');
      const count = mapSync?._materializedThisStartup || 0;
      if (count > 0) {
        ui.notifications.info(`Chronicle: synced ${count} map(s) from Chronicle.`);
      }
    }
  } catch (err) {
    console.error('Chronicle Sync | Failed to start sync manager', err);
    ui.notifications.error('Chronicle Sync: Connection failed. Open the dashboard to diagnose.');
  }

  // Fire-and-forget manifest health probe (GM only). Surfaces a sticky
  // `ui.notifications.error` if Foundry's install-time URL no longer
  // authenticates — typically because Chronicle rotated its signing
  // secret or the campaign owner reset the token. Recovery path is
  // reinstall from a fresh URL; the banner says so. Companion to
  // cordinator Issue #17.
  if (game.user.isGM) {
    surfaceManifestRecoveryIfNeeded().catch((err) => {
      console.warn('Chronicle Sync | Manifest recovery probe failed', err);
    });

    // FM-SEC-CHUNK-7: descriptor schema runtime re-validation (D2=b
    // defense-in-depth per FM-SECURITY-AUDIT §0.5). CI catches drift
    // at build time; this catches drift when CI is bypassed (hand-
    // edited release, ad-hoc deployment). GM-only so the surface area
    // matches the recovery probe's audience.
    _runtimeValidateDescriptor().catch((err) => {
      console.warn('Chronicle Sync | Descriptor runtime check failed', err);
    });
  }
});

/**
 * Runtime re-validation of `chronicle-package.json` against the same
 * rules `tools/check-package-descriptor.mjs` enforces at CI. Defense-
 * in-depth per FM-SEC-CHUNK-7 / FM-SECURITY-AUDIT §0.5 D2=(b).
 *
 * Fetches the deployed descriptor from the module's static-asset path
 * (`modules/chronicle-sync/chronicle-package.json`), runs
 * `validateDescriptor`, and on drift logs `console.error` + surfaces a
 * sticky `ui.notifications.error` so the operator sees it.
 *
 * Failures here are non-fatal — the module continues to run on whatever
 * the descriptor's fallback semantics provide. The signal is "your
 * release is malformed; check it" rather than "stop sync."
 *
 * @private
 * @returns {Promise<void>}
 */
async function _runtimeValidateDescriptor() {
  let descriptor = null;
  let moduleJson = null;
  try {
    const [descResp, modResp] = await Promise.all([
      fetch('modules/chronicle-sync/chronicle-package.json', { cache: 'no-store' }),
      fetch('modules/chronicle-sync/module.json', { cache: 'no-store' }),
    ]);
    // Chronicle deliberately strips chronicle-package.json from the module
    // zips it serves (Chronicle foundry_vtt/handler.go) — the descriptor is
    // Chronicle-side metadata, not part of the installed module. A 404 here
    // is therefore the NORMAL served-install case, not schema drift: skip the
    // check silently. (It still fires for a genuinely malformed descriptor
    // that WAS shipped — a hand-edited / ad-hoc release — which is the
    // FM-SEC-CHUNK-7 purpose.)
    if (!descResp.ok) {
      console.debug(
        `Chronicle Sync | chronicle-package.json not served (HTTP ${descResp.status}) — `
        + 'skipping descriptor runtime check (expected for Chronicle-served installs).'
      );
      return;
    }
    descriptor = await descResp.json();
    if (modResp.ok) moduleJson = await modResp.json();
  } catch (err) {
    console.warn('Chronicle Sync | Descriptor runtime fetch failed (skipping check)', err);
    return;
  }

  const { validateDescriptor } = await import('./_descriptor-validator.mjs');
  const { errors, warnings } = validateDescriptor(descriptor, moduleJson);

  for (const w of warnings) {
    console.warn(`Chronicle Sync | descriptor warning: ${w}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`Chronicle Sync | descriptor ERROR: ${e}`);
    }
    const summary = `Chronicle Sync: chronicle-package.json failed runtime validation (${errors.length} error${errors.length === 1 ? '' : 's'}). Check the browser console for details. The deployed module's descriptor may have drifted from the schema; reinstall from a fresh release.`;
    try {
      ui?.notifications?.error?.(summary, { permanent: true });
    } catch { /* notifications not ready */ }
  } else {
    console.debug(`Chronicle Sync | descriptor runtime check OK (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);
  }
}

/**
 * Add a Chronicle Sync button to Foundry's scene controls toolbar.
 * Visible only to GMs. Opens the Sync Dashboard on click.
 */
Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user.isGM) return;

  // openDashboard() is the module-level helper above: it recreates the
  // dashboard when a prior close left the instance non-re-renderable, fixing
  // the intermittent "can't reopen the dashboard" bug.
  // FM-CAL-DASHBOARD-LINK: surface SyncCalendarApplication as a second
  // tool in the Chronicle Sync scene-control group. The singleton helper
  // is GM-only by contract; the outer GM guard above is also enforced.
  const launchSyncCalendar = () => { openSyncCalendar(); };
  const syncCalendarTitle = game.i18n.localize('CHRONICLE.SceneControl.SyncCalendar');

  // v13: controls and tools are keyed objects with onChange callback.
  // v12: controls and tools are arrays with onClick callback.
  if (Array.isArray(controls)) {
    controls.push({
      name: 'chronicle-sync',
      title: 'Chronicle Sync',
      icon: 'fa-solid fa-rotate',
      layer: 'controls',
      visible: true,
      tools: [{
        name: 'dashboard',
        title: 'Open Chronicle Sync Dashboard',
        icon: 'fa-solid fa-rotate',
        button: true,
        onClick: openDashboard,
      }, {
        name: 'sync-calendar',
        title: syncCalendarTitle,
        icon: 'fa-solid fa-calendar-days',
        button: true,
        onClick: launchSyncCalendar,
      }],
    });
  } else {
    // v13 requires activeTool even for button-only controls, and does not
    // use the v12 `layer` property. See foundryvtt/foundryvtt#12803.
    controls['chronicle-sync'] = {
      name: 'chronicle-sync',
      title: 'Chronicle Sync',
      icon: 'fa-solid fa-rotate',
      visible: true,
      activeTool: 'dashboard',
      tools: {
        dashboard: {
          name: 'dashboard',
          title: 'Open Chronicle Sync Dashboard',
          icon: 'fa-solid fa-rotate',
          button: true,
          onChange: openDashboard,
        },
        'sync-calendar': {
          name: 'sync-calendar',
          title: syncCalendarTitle,
          icon: 'fa-solid fa-calendar-days',
          button: true,
          onChange: launchSyncCalendar,
        },
      },
    };
  }
});

/**
 * Clean up when the module is deactivated.
 */
Hooks.on('closeGame', () => {
  if (syncManager) {
    syncManager.stop();
    syncManager = null;
  }
});

/**
 * Add a sync status indicator to Foundry's sidebar.
 * Shows connection state (green/yellow/red dot) with click-to-reconnect
 * and event-driven updates (no polling).
 * @private
 */
function _addStatusIndicator() {
  if (!syncManager) return;

  const indicator = document.createElement('div');
  indicator.className = 'chronicle-sync-status disconnected';

  const dot = document.createElement('span');
  dot.className = 'status-dot';
  const text = document.createElement('span');
  text.className = 'status-text';
  text.textContent = 'Chronicle';
  indicator.append(dot, text);

  // Update indicator based on WebSocket state.
  const updateState = (state) => {
    if (!state) state = syncManager.api.state;
    indicator.className = `chronicle-sync-status ${state}`;
    indicator.title = _statusTooltip(state);

    const text = indicator.querySelector('.status-text');
    switch (state) {
      case 'connected':
        text.textContent = 'Chronicle: Connected';
        break;
      case 'connecting':
        text.textContent = 'Chronicle: Connecting...';
        break;
      case 'reconnecting':
        text.textContent = 'Chronicle: Reconnecting...';
        break;
      default:
        text.textContent = 'Chronicle: Disconnected';
    }
  };

  // Event-driven state updates (no polling).
  let wasConnected = false;
  syncManager.api.onStateChange((state) => {
    updateState(state);
    // Notify on disconnect (only if we were previously connected).
    if (state === 'disconnected' && wasConnected) {
      ui.notifications.warn('Chronicle: Connection lost. Reconnecting automatically...');
    }
    if (state === 'connected') {
      if (wasConnected) {
        // Reconnected after a disconnect.
        ui.notifications.info('Chronicle: Reconnected.');
      }
      wasConnected = true;
    }
  });
  updateState();

  // Click to open the sync dashboard, or reconnect if disconnected.
  indicator.addEventListener('click', () => {
    if (syncManager.api.state === 'disconnected') {
      syncManager.api.connect();
      ui.notifications.info('Chronicle: Reconnecting...');
    } else {
      openDashboard();
    }
  });

  // Right-click always opens the dashboard (even when disconnected).
  indicator.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDashboard();
  });

  // Flash the dot briefly when a WS message arrives (activity indicator).
  // Throttled to avoid excessive DOM manipulation under high message volume.
  let activityThrottled = false;
  syncManager.api.on('*', () => {
    if (activityThrottled) return;
    activityThrottled = true;
    const dot = indicator.querySelector('.status-dot');
    if (dot && syncManager.api.state === 'connected') {
      dot.classList.add('activity');
      setTimeout(() => {
        dot.classList.remove('activity');
        activityThrottled = false;
      }, 300);
    } else {
      activityThrottled = false;
    }
  });

  // Append to sidebar header or player list.
  _statusIndicatorEl = indicator;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.prepend(indicator);
  }
}

/**
 * Re-attach the sidebar status indicator after the sidebar re-renders.
 *
 * Foundry v13+ rebuilt the sidebar as an ApplicationV2 that re-renders (and
 * wipes injected nodes) on tab changes, so the one-shot injection in
 * `_addStatusIndicator` does not persist — the indicator (a primary entry
 * point to the dashboard and its diagnostics) silently vanishes, which reads
 * to the operator as "the debug button is gone." This handler is purely
 * additive and fully guarded: if the hook never fires or the DOM shape differs
 * on a future Foundry version, behavior degrades to "no indicator" rather than
 * throwing. A version-independent path to diagnostics is also exposed on the
 * module API (`game.modules.get('chronicle-sync').api.copyDebug()` /
 * `.openDashboard()`).
 */
Hooks.on('renderSidebar', () => {
  try {
    if (!_statusIndicatorEl || _statusIndicatorEl.isConnected) return;
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.contains(_statusIndicatorEl)) sidebar.prepend(_statusIndicatorEl);
  } catch (err) {
    console.debug('Chronicle Sync | status-indicator re-attach skipped', err);
  }
});

/**
 * Return tooltip text for the connection status indicator.
 * @param {string} state
 * @returns {string}
 * @private
 */
function _statusTooltip(state) {
  switch (state) {
    case 'connected':
      return 'Connected to Chronicle. Click to open dashboard.';
    case 'connecting':
      return 'Connecting to Chronicle...';
    case 'reconnecting':
      return 'Connection lost. Reconnecting automatically...';
    default:
      return 'Disconnected from Chronicle. Click to reconnect. Right-click for dashboard.';
  }
}

/**
 * Expose the sync manager globally for debugging and integration.
 * Access via `game.modules.get('chronicle-sync').api`.
 */
Hooks.once('ready', () => {
  const module = game.modules.get('chronicle-sync');
  if (module) {
    module.api = {
      syncManager,
      // Getter (not a snapshot): openDashboard() may recreate the instance, so
      // expose the live reference rather than the one captured at ready time.
      get dashboard() { return dashboard; },
      getAPI: () => syncManager?.api,
      openDashboard: () => openDashboard(),
      // Version-independent diagnostics escape hatch. Lets an operator always
      // produce the System Debug snapshot from the console even if the toolbar
      // button or sidebar indicator regress on a Foundry upgrade. DOM-
      // independent (builds from game state) and returns the report string in
      // addition to copying it to the clipboard.
      copyDebug: () => dashboard?.copyDebugReport(),
    };
  }
});
