/**
 * Pure rules for mirroring Chronicle's Draw Steel negotiation tracker onto
 * Foundry NPC actors (scripts/negotiation-mirror.mjs): which WebSocket
 * message counts, which part of the tracker may be saved on the Draw Steel
 * system's `system.negotiation`, which actors belong to the page, and what
 * actually changed. No Foundry globals, so tools/test-negotiation-mirror.mjs
 * pins it.
 *
 * Only what players may already know is saved: an actor document reaches
 * players' browsers, and Draw Steel's Limited view prints the negotiation.
 * So the actor gets the found motivations and pitfalls, and the meters once
 * the Director has shown them, as Chronicle's own public half does. The rest
 * stays in Chronicle for the Director's screen.
 */

import { normalizeName } from './_npc-presence.mjs';

/** Chronicle's slug for a motivation that Foundry's system spells differently. */
const SLUG_TO_FOUNDRY = Object.freeze({ 'higher-authority': 'authority' });

/** Motivation and pitfall keys the Draw Steel system accepts. */
const FOUNDRY_KEYS = new Set([
  'authority', 'benevolence', 'discovery', 'freedom', 'greed', 'justice',
  'legacy', 'peace', 'power', 'protection', 'revelry', 'vengeance',
]);

/**
 * Whether a WebSocket message is the Draw Steel negotiation tracker changing.
 * @param {object} msg
 * @returns {boolean}
 */
export function isNegotiationMessage(msg) {
  return msg?.type === 'system_state.updated'
    && !!msg.resourceId
    && msg.payload?.systemId === 'drawsteel'
    && msg.payload?.key === 'negotiation';
}

function clampPoints(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(0, Math.trunc(n)));
}

/** Map tracker slugs to the system's keys; unknown ones are dropped. */
function mapKeys(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const slug of list) {
    const key = SLUG_TO_FOUNDRY[slug] ?? slug;
    if (typeof key === 'string' && FOUNDRY_KEYS.has(key)) out.add(key);
  }
  return [...out].sort();
}

/** The found slugs that are still on the NPC's own list. */
function foundOnList(found, list) {
  const on = new Set(Array.isArray(list) ? list : []);
  return (Array.isArray(found) ? found : []).filter((slug) => on.has(slug));
}

/**
 * Turn the tracker's GM half into the actor update players may see: found
 * motivations and pitfalls always, so lists saved by an older mirror are
 * replaced, and interest and patience only once the Director has shown them.
 * Impression and unfound entries never leave Chronicle.
 * @param {object|null} gm
 * @returns {object|null} Update object, or null when there is nothing to mirror.
 */
export function toFoundryNegotiation(gm) {
  if (!gm || typeof gm !== 'object' || Array.isArray(gm) || !Object.keys(gm).length) return null;
  const found = gm.found && typeof gm.found === 'object' ? gm.found : {};
  const update = {
    'system.negotiation.motivations': mapKeys(foundOnList(found.motivations, gm.motivations)),
    'system.negotiation.pitfalls': mapKeys(foundOnList(found.pitfalls, gm.pitfalls)),
  };
  if (gm.shown === true) {
    update['system.negotiation.interest'] = clampPoints(gm.interest) ?? 0;
    update['system.negotiation.patience'] = clampPoints(gm.patience) ?? 0;
  }
  return update;
}

/**
 * Which NPC actors a page's negotiation belongs to. An NPC actor character
 * sync made from this page, or one linked to it by a dropped journal, wins
 * and takes every such actor; otherwise exactly one NPC whose name matches
 * the page's. Hero actors are never touched: character sync owns them.
 *
 * @param {{entityId: string, pageName: string, actors: Array<{id: string, name: string, type: string, pageId?: string|null, linkedEntityId?: string|null}>}} q
 * @returns {string[]} Actor ids.
 */
export function pickNegotiationActors({ entityId, pageName, actors }) {
  const npcs = (actors || []).filter((a) => a?.id && a.type === 'npc');
  const linked = npcs.filter((a) => a.linkedEntityId === entityId || (a.pageId && a.pageId === entityId));
  if (linked.length) return linked.map((a) => a.id);
  // Another page's link or synced actor must not be taken by a name coincidence.
  const want = normalizeName(pageName);
  if (!want) return [];
  const named = npcs.filter((a) => !a.linkedEntityId && !a.pageId && normalizeName(a.name) === want);
  return named.length === 1 ? [named[0].id] : [];
}

function asList(v) {
  return [...(v ?? [])].sort();
}

/**
 * The part of an update that differs from the actor's current negotiation,
 * so an unchanged tracker causes no actor write.
 * @param {object} update - From toFoundryNegotiation.
 * @param {object|null} current - `actor.system.negotiation` (Sets allowed).
 * @returns {object|null} Changed fields, or null when nothing differs.
 */
export function negotiationChanges(update, current) {
  if (!update) return null;
  const out = {};
  for (const [path, next] of Object.entries(update)) {
    const field = path.slice('system.negotiation.'.length);
    const have = current?.[field];
    const same = Array.isArray(next)
      ? JSON.stringify(asList(have)) === JSON.stringify(next)
      : have === next;
    if (!same) out[path] = next;
  }
  return Object.keys(out).length ? out : null;
}
