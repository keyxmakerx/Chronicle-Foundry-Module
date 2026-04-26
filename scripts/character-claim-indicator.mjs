/**
 * Chronicle Sync - Character Claim Indicator
 *
 * Adds a small "Chronicle: claimed by …" / "Chronicle: unclaimed" pill to the
 * header of any Actor sheet whose actor is linked to a Chronicle entity.
 *
 * The pill is read-only and informational. Clicking it opens the linked
 * chronicle entity page in a new tab.  Claim/unclaim actions live in chronicle
 * itself; this module only surfaces current state.
 *
 * Source of truth is the `chronicleOwnerUserId` actor flag, populated by
 * actor-sync.mjs on create/update.  Display name resolution falls back to
 * cached campaign members → Foundry user mapping → bare ID.
 */

import { getSetting } from './settings.mjs';
import { getUserMappings } from './settings.mjs';
import { FLAG_SCOPE, MODULE_ID } from './constants.mjs';

/**
 * Register the renderActorSheet hook.  Called once at module ready.
 * Hooks both the v12 `renderActorSheet` and the v13 `renderActorSheetV2`
 * events so the pill renders regardless of which sheet implementation a
 * given system uses.
 */
export function registerCharacterClaimIndicator() {
  Hooks.on('renderActorSheet', _onRenderActorSheet);
  Hooks.on('renderActorSheetV2', _onRenderActorSheet);
}

/**
 * Render the indicator into an actor sheet's header if the actor is linked
 * to a Chronicle entity.
 * @param {Application} app - The actor sheet application.
 * @param {jQuery|HTMLElement} html - v12 jQuery wrapper or v13 raw element.
 * @private
 */
function _onRenderActorSheet(app, html) {
  const actor = app?.actor ?? app?.document;
  if (!actor) return;

  const entityId = actor.getFlag(FLAG_SCOPE, 'entityId');
  if (!entityId) return;

  // Resolve the host element (jQuery in v12, HTMLElement in v13).
  const root = (html instanceof HTMLElement) ? html : html?.[0];
  if (!root) return;

  // Avoid stacking duplicates if the sheet re-renders.
  const existing = root.querySelector('.chronicle-claim-indicator');
  if (existing) existing.remove();

  const ownerUserId = actor.getFlag(FLAG_SCOPE, 'chronicleOwnerUserId') ?? null;
  const pill = _buildPill(ownerUserId, entityId);
  if (!pill) return;

  // Inject into the sheet header — fall back to the sheet root if we can't
  // find a header to attach to. Different sheet implementations use
  // different selectors; try the most common ones in order.
  const headerSelectors = ['.window-header', '.sheet-header', 'header'];
  let host = null;
  for (const sel of headerSelectors) {
    host = root.querySelector(sel);
    if (host) break;
  }
  (host ?? root).appendChild(pill);
}

/**
 * Build the pill DOM element.
 * @param {string|null} ownerUserId
 * @param {string} entityId
 * @returns {HTMLElement|null}
 * @private
 */
function _buildPill(ownerUserId, entityId) {
  const pill = document.createElement('a');
  pill.className = 'chronicle-claim-indicator';
  pill.dataset.entityId = entityId;
  pill.title = 'Open in Chronicle';

  const link = _buildEntityUrl(entityId);
  if (link) {
    pill.href = link;
    pill.target = '_blank';
    pill.rel = 'noopener noreferrer';
  }

  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-link';
  pill.appendChild(icon);

  const label = document.createElement('span');
  if (ownerUserId) {
    pill.classList.add('claimed');
    const name = _resolveOwnerDisplayName(ownerUserId);
    label.textContent = `Chronicle: claimed by ${name}`;
  } else {
    pill.classList.add('unclaimed');
    label.textContent = 'Chronicle: unclaimed';
  }
  pill.appendChild(label);

  return pill;
}

/**
 * Resolve a Chronicle user ID to a display name.  Order of preference:
 *   1. The campaign-member display_name cached on the SyncManager.
 *   2. The Foundry user name mapped via userMappings.
 *   3. A truncated form of the ID.
 * @param {string} chronicleUserId
 * @returns {string}
 * @private
 */
function _resolveOwnerDisplayName(chronicleUserId) {
  const module = game.modules?.get(MODULE_ID);
  const syncManager = module?.api?.syncManager;
  const member = syncManager?.getMembers?.().find((m) => m.user_id === chronicleUserId);
  if (member?.display_name) return member.display_name;

  const mappings = getUserMappings();
  const foundryUserId = mappings[chronicleUserId];
  const foundryUser = foundryUserId ? game.users?.get(foundryUserId) : null;
  if (foundryUser?.name) return foundryUser.name;

  return chronicleUserId.slice(0, 8) + '…';
}

/**
 * Build a deep-link URL to the chronicle entity page.
 * Returns null if apiUrl/campaignId are not configured.
 * @param {string} entityId
 * @returns {string|null}
 * @private
 */
function _buildEntityUrl(entityId) {
  const apiUrl = getSetting('apiUrl')?.replace(/\/+$/, '');
  const campaignId = getSetting('campaignId');
  if (!apiUrl || !campaignId) return null;
  return `${apiUrl}/campaigns/${campaignId}/entities/${entityId}`;
}
