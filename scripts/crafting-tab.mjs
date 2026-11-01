/**
 * Chronicle Sync - the Satchel's Crafting tab
 *
 * Runs Chronicle's own Crafting block (vendor/chronicle/crafting_*.js,
 * copied unchanged) for one hero, so the tab shows exactly what the block on
 * the hero's Chronicle page shows. Its calls reach Chronicle through
 * craftRequest; any other call (the Director's editors) is refused, since
 * those stay on Chronicle. Until the bench comes to Foundry, the block's
 * "Work at the bench" says where the bench is instead.
 */

import { getSetting } from './settings.mjs';
import { loadVendored, loadVendoredStyles } from './vendor-chronicle.mjs';
import { craftActionFor } from './_craft-relay.mjs';
import { craftRequest } from './crafting-relay.mjs';

const t = (key) => game.i18n.localize(`CHRONICLE.Crafting.${key}`);

const SCRIPTS = ['crafting_lib.js', 'crafting_tray.js', 'crafting_block.js'];
const STYLES = ['crafting.css', 'spoils.css'];

/** The bench on the hero's Chronicle page, or null when Chronicle isn't set up. */
function heroPageUrl(campaignId, entityId) {
  const apiUrl = String(getSetting('apiUrl') || '').replace(/\/+$/, '');
  if (!apiUrl) return null;
  return `${apiUrl}/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`;
}

/**
 * Draw the Crafting block for a hero into `pane`.
 * @param {HTMLElement} pane
 * @param {string} entityId - the hero's Chronicle page
 * @returns {Promise<{destroy: () => void}>}
 */
export async function mountCraftingTab(pane, entityId) {
  const campaignId = String(getSetting('campaignId') || '');
  const base = `/campaigns/${campaignId}/crafting`;
  const [shim] = await Promise.all([loadVendored(SCRIPTS), loadVendoredStyles(STYLES)]);

  shim.setRoute(`${base}/`, (url, method, body) => {
    const a = craftActionFor(base, url, method, body);
    if (!a) return { status: 405, body: { message: t('OnChronicle') } };
    // The tab is one hero's; nothing it sends may name another.
    if (a.characterId !== undefined && a.characterId !== entityId) return { status: 403, body: { message: t('NotOwner') } };
    return craftRequest({ ...a, characterId: entityId });
  });

  const wrap = document.createElement('div');
  wrap.className = 'cs-craft';
  const el = document.createElement('div');
  el.setAttribute('data-widget', 'crafting-block');
  el.setAttribute('data-campaign-id', campaignId);
  el.setAttribute('data-entity-id', entityId);
  wrap.append(el);
  pane.replaceChildren(wrap);

  const onMissing = (event) => {
    if (event.detail?.widget !== 'craft_bench') return;
    const box = event.target;
    const p = document.createElement('p');
    p.className = 'cra-fine';
    p.textContent = t('BenchOnChronicle');
    box.replaceChildren(p);
    const href = heroPageUrl(campaignId, entityId);
    if (href) {
      const a = document.createElement('a');
      a.className = 'btn btn-secondary btn-sm';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = t('OpenBench');
      box.append(a);
    }
  };
  wrap.addEventListener('chronicle:missing-widget', onMissing);
  shim.mountWidget(el);

  return {
    destroy() {
      wrap.removeEventListener('chronicle:missing-widget', onMissing);
      shim.destroyWidget(el);
      shim.setRoute(`${base}/`, null);
      wrap.remove();
    },
  };
}
