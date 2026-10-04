/**
 * Pure rules for mirroring Chronicle's Draw Steel negotiation tracker onto
 * Foundry NPC actors (scripts/negotiation-mirror.mjs): which WebSocket
 * message counts, how the tracker's GM half maps onto the Draw Steel system's
 * `system.negotiation`, which actors belong to the page, and what actually
 * changed. No Foundry globals, so tools/test-negotiation-mirror.mjs pins it.
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

/**
 * Turn the tracker's GM half into an actor update. Impression is only sent
 * when the tracker has one, so a blank never wipes the sheet.
 * @param {object|null} gm
 * @returns {object|null} Update object, or null when there is nothing to mirror.
 */
export function toFoundryNegotiation(gm) {
  if (!gm || typeof gm !== 'object' || Array.isArray(gm) || !Object.keys(gm).length) return null;
  const update = {
    'system.negotiation.interest': clampPoints(gm.interest) ?? 0,
    'system.negotiation.patience': clampPoints(gm.patience) ?? 0,
    'system.negotiation.motivations': mapKeys(gm.motivations),
    'system.negotiation.pitfalls': mapKeys(gm.pitfalls),
  };
  if (Number.isInteger(gm.impression)) update['system.negotiation.impression'] = gm.impression;
  return update;
}

/**
 * Which NPC actors a page's negotiation belongs to. An explicit link wins
 * and takes every actor carrying it; otherwise exactly one NPC whose name
 * matches the page's. Heroes are never touched: character sync owns them.
 *
 * @param {{entityId: string, pageName: string, actors: Array<{id: string, name: string, type: string, isHero?: boolean, linkedEntityId?: string|null}>}} q
 * @returns {string[]} Actor ids.
 */
export function pickNegotiationActors({ entityId, pageName, actors }) {
  const npcs = (actors || []).filter((a) => a?.id && a.type === 'npc' && !a.isHero);
  const linked = npcs.filter((a) => a.linkedEntityId === entityId);
  if (linked.length) return linked.map((a) => a.id);
  // Another page's explicit link must not be stolen by a name coincidence.
  const want = normalizeName(pageName);
  if (!want) return [];
  const named = npcs.filter((a) => !a.linkedEntityId && normalizeName(a.name) === want);
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
