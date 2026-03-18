/**
 * Chronicle Sync - Foundry VTT Module Entry Point
 *
 * Registers settings, initializes the sync manager, and connects to the
 * Chronicle backend on the 'ready' hook. All sync features are coordinated
 * through the SyncManager which owns the WebSocket connection.
 */

import { registerSettings } from './settings.mjs';
import { SyncManager } from './sync-manager.mjs';
import { JournalSync } from './journal-sync.mjs';
import { MapSync } from './map-sync.mjs';
import { ShopWidget } from './shop-widget.mjs';
import { CalendarSync } from './calendar-sync.mjs';
import { ActorSync } from './actor-sync.mjs';
import { ItemSync } from './item-sync.mjs';
import { SyncDashboard } from './sync-dashboard.mjs';

/** @type {SyncManager|null} */
let syncManager = null;

/** @type {SyncDashboard|null} */
let dashboard = null;

/**
 * Module initialization — register settings.
 * This runs before the game is fully ready.
 */
Hooks.once('init', () => {
  console.debug('Chronicle Sync | Initializing');
  registerSettings();

  // Register Handlebars helpers used by dashboard/shop templates.
  Handlebars.registerHelper('eq', (a, b) => a === b);
  Handlebars.registerHelper('neq', (a, b) => a !== b);
  Handlebars.registerHelper('lt', (a, b) => a < b);
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

  // Start the sync manager (connects WebSocket, performs initial sync).
  await syncManager.start();

  // Create the sync dashboard (singleton, rendered on demand).
  dashboard = new SyncDashboard();
  dashboard.bind(syncManager);

  // Add sync status indicator to the UI.
  _addStatusIndicator();
});

/**
 * Add a Chronicle Sync button to Foundry's scene controls toolbar.
 * Visible only to GMs. Opens the Sync Dashboard on click.
 */
Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user.isGM) return;

  const controlData = {
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
      onClick: () => {
        if (dashboard) dashboard.render({ force: true });
      },
    }],
  };

  // v13: controls is a keyed object; v12: controls is an array.
  if (Array.isArray(controls)) {
    controls.push(controlData);
  } else {
    controls['chronicle-sync'] = controlData;
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
  indicator.innerHTML = `
    <span class="status-dot"></span>
    <span class="status-text">Chronicle</span>
  `;

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
    } else if (dashboard) {
      dashboard.render({ force: true });
    }
  });

  // Right-click always opens the dashboard (even when disconnected).
  indicator.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (dashboard) dashboard.render({ force: true });
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
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.prepend(indicator);
  }
}

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
      dashboard,
      getAPI: () => syncManager?.api,
      openDashboard: () => dashboard?.render({ force: true }),
    };
  }
});
