/**
 * Chronicle Sync - Draw Steel negotiation mirror (Chronicle to Foundry).
 *
 * When the Draw Steel negotiation tracker changes on a Chronicle NPC page,
 * the active GM's client copies interest, patience, motivations, pitfalls
 * and impression onto that NPC's actor, on Draw Steel worlds only. Edits on
 * the Foundry sheet are not sent back. A failure is logged for the GM, never
 * shown to players. Pure rules live in _negotiation-mirror.mjs.
 */

import { FLAG_SCOPE } from './constants.mjs';
import { log } from './logger.mjs';
import { LINK_FLAG, syncedPages, onNpcLinked } from './npc-presence.mjs';
import {
  isNegotiationMessage,
  toFoundryNegotiation,
  pickNegotiationActors,
  negotiationChanges,
} from './_negotiation-mirror.mjs';

const SYSTEM_ID = 'draw-steel';

/** True on the one client that should write: the active GM, on Draw Steel. */
function _shouldAct() {
  return !!game.user?.isGM
    && !!game.users?.activeGM?.isSelf
    && game.system?.id === SYSTEM_ID;
}

/**
 * Fetch the page's tracker and write it onto its NPC actors.
 * @param {{get: Function}|null} api
 * @param {string} entityId
 */
async function mirrorEntity(api, entityId) {
  if (!api || !_shouldAct()) return;
  try {
    let doc;
    try {
      doc = await api.get(`/entities/${entityId}/system-state/drawsteel/negotiation`);
    } catch (err) {
      // An older Chronicle, or a page that is gone: nothing to mirror.
      if (err?.status === 404) return;
      throw err;
    }
    const update = toFoundryNegotiation(doc?.gm);
    if (!update) return;

    const page = syncedPages().find((p) => p.entityId === entityId);
    const actors = [...(game.actors ?? [])].map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      isHero: !!a.getFlag(FLAG_SCOPE, 'entityId'),
      linkedEntityId: a.getFlag(FLAG_SCOPE, LINK_FLAG) ?? null,
    }));
    for (const id of pickNegotiationActors({ entityId, pageName: page?.name, actors })) {
      const actor = game.actors.get(id);
      const changes = negotiationChanges(update, actor?.system?.negotiation);
      // SetField values are updated with arrays; Foundry casts them to Sets.
      if (changes) await actor.update(changes);
    }
  } catch (err) {
    log.warn('Negotiation mirror failed', err);
  }
}

/** SyncManager module for `system_state.updated` of the negotiation tracker. */
export const negotiationMirror = {
  _api: null,
  _listening: false,
  init(api) {
    this._api = api;
    // Linking a page by dropping its journal on a token mirrors once.
    // Registered once even if the manager restarts and calls init again.
    if (!this._listening) {
      this._listening = true;
      onNpcLinked((entityId) => mirrorEntity(this._api, entityId));
    }
  },
  destroy() { this._api = null; },
  onMessage(msg) {
    if (!isNegotiationMessage(msg)) return;
    mirrorEntity(this._api, msg.resourceId);
  },
};
