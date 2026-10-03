/**
 * Pure rules behind NPC presence (scripts/npc-presence.mjs): which Chronicle
 * page a token belongs to, who plays a spotlight, when a talking glow is
 * still live, the shape of both animations, and when revealing a token asks
 * about the page too. No Foundry globals here, so tools/test-npc-presence.mjs
 * can pin every rule off-DOM.
 */

/** A talking glow with no new line for this long switches itself off. */
export const TALK_TIMEOUT_MS = 2 * 60 * 1000;

/** A viewer with no input for this long is treated as stepped away. */
export const IDLE_MS = 60 * 1000;

/** Spotlight timings, in ms: camera glide, ring bloom start, total length. */
export const SPOT = Object.freeze({ PAN_MS: 1100, BLOOM_AT: 700, BLOOM_MS: 900, HOLD_MS: 3600, FADE_MS: 600 });

/** Type names that read as a person, used only to break a name tie. */
const PERSON_TYPE = /charact|npc|creature|monster|person|people|villain|ally/i;

/**
 * Normalise a name for matching: trimmed, case-folded, inner spaces collapsed.
 * @param {string} s
 * @returns {string}
 */
export function normalizeName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Find the one synced Chronicle page whose name matches a token's name.
 * Several pages with that name are a tie; a tie is broken only when exactly
 * one of them is a person-like type. Anything else is no match, because
 * linking the wrong page would spotlight or reveal the wrong NPC.
 *
 * @param {string} name - Token or actor name.
 * @param {Array<{entityId: string, name: string, typeName?: string}>} pages
 * @returns {string|null} The entity id, or null.
 */
export function matchPageByName(name, pages) {
  const want = normalizeName(name);
  if (!want) return null;
  const hits = (pages || []).filter((p) => p?.entityId && normalizeName(p.name) === want);
  if (hits.length === 1) return hits[0].entityId;
  const people = hits.filter((p) => PERSON_TYPE.test(p.typeName || ''));
  return people.length === 1 ? people[0].entityId : null;
}

/**
 * Decide which Chronicle page a token belongs to. A hero actor already
 * linked by character sync is left alone; an explicit link (a journal
 * dropped on the token) wins over a name match.
 *
 * @param {{heroEntityId?: string|null, linkedEntityId?: string|null, names: string[], pages: Array}} t
 * @returns {string|null}
 */
export function resolveTokenPage({ heroEntityId, linkedEntityId, names, pages }) {
  if (heroEntityId) return null;
  const known = new Set((pages || []).map((p) => p.entityId));
  if (linkedEntityId && known.has(linkedEntityId)) return linkedEntityId;
  for (const n of names || []) {
    const id = matchPageByName(n, pages);
    if (id) return id;
  }
  return null;
}

/**
 * What one client does with a spotlight. Players play it only when they can
 * see the token, so a spotlight never pans anyone to a hidden or unseen NPC.
 * The GM always learns why nothing played.
 *
 * @param {{isGM: boolean, sameScene: boolean, tokenFound: boolean, tokenHidden: boolean, visibleToMe: boolean}} s
 * @returns {'play'|'note-elsewhere'|'note-hidden'|'skip'}
 */
export function spotlightAction({ isGM, sameScene, tokenFound, tokenHidden, visibleToMe }) {
  if (!sameScene || !tokenFound) return isGM ? 'note-elsewhere' : 'skip';
  if (tokenHidden) return isGM ? 'note-hidden' : 'skip';
  if (!isGM && !visibleToMe) return 'skip';
  return 'play';
}

/**
 * Which token a "Show in Foundry" press from Chronicle spotlights: one
 * linked to that page on the scene the GM is viewing, a shown one before a
 * hidden one. A hidden pick still goes through spotlightAction, which only
 * tells the GM.
 *
 * @param {Array<{id: string, entityId: string|null, hidden: boolean}>} tokens
 * @param {string} entityId
 * @returns {{id: string, entityId: string, hidden: boolean}|null}
 */
export function chooseSpotlightToken(tokens, entityId) {
  if (!entityId) return null;
  const mine = (tokens || []).filter((t) => t?.id && t.entityId === entityId);
  return mine.find((t) => !t.hidden) ?? mine[0] ?? null;
}

/**
 * Whether a talking flag is still live.
 * @param {{at?: number}|null|undefined} flag
 * @param {number} now
 * @returns {boolean}
 */
export function isTalkLive(flag, now) {
  const at = Number(flag?.at);
  if (!Number.isFinite(at)) return false;
  return now - at < TALK_TIMEOUT_MS;
}

/**
 * Spotlight ring at `t` ms after the spotlight started: it blooms in from a
 * wide circle, overshoots a little, settles with a glow, holds, then fades.
 * Plays once.
 *
 * @param {number} t
 * @returns {{scale: number, alpha: number, glow: number, done: boolean}}
 */
export function spotlightRing(t) {
  const { BLOOM_AT, BLOOM_MS, HOLD_MS, FADE_MS } = SPOT;
  const end = BLOOM_AT + BLOOM_MS + HOLD_MS + FADE_MS;
  if (t >= end) return { scale: 1, alpha: 0, glow: 0, done: true };
  if (t < BLOOM_AT) return { scale: 2.4, alpha: 0, glow: 0, done: false };
  const b = t - BLOOM_AT;
  if (b < BLOOM_MS) {
    const p = b / BLOOM_MS;
    if (p < 0.4) {
      const q = p / 0.4;
      return { scale: 2.4 - 1.4 * easeOut(q), alpha: q, glow: 0, done: false };
    }
    const q = (p - 0.4) / 0.6;
    return { scale: 1 + 0.12 * Math.sin(Math.PI * q), alpha: 1, glow: q, done: false };
  }
  const f = t - BLOOM_AT - BLOOM_MS - HOLD_MS;
  if (f < 0) return { scale: 1, alpha: 1, glow: 1, done: false };
  const a = 1 - f / FADE_MS;
  return { scale: 1, alpha: a, glow: a, done: false };
}

/**
 * Talking ring at phase `t` ms: a slow breath (1.8 s). `amp` (0..1) scales
 * the motion so the glow can ease to still while the viewer is away.
 *
 * @param {number} t
 * @param {number} amp
 * @returns {{scale: number, glow: number}}
 */
export function talkingRing(t, amp) {
  const s = (1 - Math.cos((2 * Math.PI * t) / 1800)) / 2;
  return { scale: 1 + 0.13 * s * amp, glow: 0.35 + 0.65 * s * amp };
}

/**
 * Ease `amp` toward 0 while resting and toward 1 when active, over about a
 * second, so the glow slows to still instead of freezing mid-breath.
 *
 * @param {number} amp
 * @param {boolean} resting
 * @param {number} dtMs
 * @returns {number}
 */
export function stepAmp(amp, resting, dtMs) {
  const step = Math.max(0, dtMs) / 1000;
  return resting ? Math.max(0, amp - step) : Math.min(1, amp + step);
}

/**
 * Whether this viewer has stepped away: the tab is hidden, or no input for
 * IDLE_MS.
 * @param {{hidden: boolean, lastInput: number, now: number}} s
 * @returns {boolean}
 */
export function isResting({ hidden, lastInput, now }) {
  return hidden || now - lastInput >= IDLE_MS;
}

/**
 * Whether revealing a token should ask about its Chronicle page: the token
 * went from hidden to shown, it belongs to an NPC page, and that page is
 * still hidden from players.
 *
 * @param {{wasHidden: boolean, nowHidden: boolean, entityId: string|null, pagePrivate: boolean}} s
 * @returns {boolean}
 */
export function shouldAskReveal({ wasHidden, nowHidden, entityId, pagePrivate }) {
  return !!(wasHidden && nowHidden === false && entityId && pagePrivate);
}

function easeOut(x) {
  return 1 - Math.pow(1 - x, 3);
}
