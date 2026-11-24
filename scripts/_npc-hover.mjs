/**
 * Chronicle Sync - what hovering a Draw Steel NPC's token shows, by viewer (pure)
 *
 * The token art preview grows into a small card for Draw Steel NPC and
 * monster tokens, and what it holds depends on who is looking:
 * - The Director sees a stat block at a glance: level and role, Stamina with
 *   the winded mark, Stability, Free strike, immunities and weaknesses,
 *   conditions, villain actions left this fight and the characteristics.
 * - A player sees the picture, the name only where the token's nameplate
 *   would show it to them, and "Winded" or "Dying" (never the number), as the
 *   token's own status marks already say.
 * - Mid-talk, a player sees Interest and Patience once the Director has
 *   shown them, and the motivations and pitfalls the party has found. Only
 *   on an NPC from a Chronicle page, whose actor holds only the players'
 *   half; an unlinked NPC's actor holds the Director's whole list.
 * A hidden or Secret token shows a player nothing, and the hover switches
 * (world, personal, per token) turn the card off with the art.
 */

import { METER_MAX, meterPips } from './_npc-looks.mjs';
import { SECRET_DISPOSITION } from './_hover-art.mjs';
import { staminaView } from './_hero-looks.mjs';

/** Foundry's CONST.TOKEN_DISPLAY_MODES. */
export const DISPLAY = Object.freeze({ NONE: 0, CONTROL: 10, OWNER_HOVER: 20, HOVER: 30, OWNER: 40, ALWAYS: 50 });

/**
 * Whether this viewer would see the token's nameplate when hovering it.
 * @param {{displayName?: number, isGM: boolean, isOwner: boolean}} p
 */
export function nameplateShown({ displayName, isGM, isOwner }) {
  if (isGM) return true;
  if (displayName === DISPLAY.HOVER || displayName === DISPLAY.ALWAYS) return true;
  if (displayName === DISPLAY.CONTROL || displayName === DISPLAY.OWNER_HOVER || displayName === DISPLAY.OWNER) return !!isOwner;
  return false;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Stamina as the sheet's box reads it, or null with no maximum to measure against. */
export function hoverStamina(stamina = {}) {
  const view = staminaView(stamina);
  return view.value !== null && view.max !== null && view.max > 0 ? view : null;
}

/**
 * The card for one hover, or null when this viewer sees nothing.
 * @param {object} p
 * @param {boolean} p.isGM
 * @param {boolean} p.isOwner
 * @param {boolean} p.on - the world and personal switches are on and the token's isn't off
 * @param {boolean} p.hidden - the token is hidden from players
 * @param {number} [p.disposition]
 * @param {string} p.art - the picture this viewer may see ('' for none; from hoverArtFor)
 * @param {string} p.name
 * @param {number} [p.displayName]
 * @param {boolean} p.linked - the actor came from or is linked to a Chronicle page
 * @param {boolean} p.talking - the token's talking glow is on
 * @param {boolean} p.statBlock - the actor has a stat block (hasStatBlock)
 * @param {object} [p.stamina] - {value, max, winded, min}
 * @param {object} [p.stats] - the Director's figures: {sub, stability, freeStrike, immunities, weaknesses, conditions[], villain {left, total, inFight}, characteristics[] {label, value}}
 * @param {object} [p.negotiation] - the actor's {interest, patience, motivations, pitfalls}, labels already given
 * @param {boolean} [p.shown] - the Director has shown the meters (negotiationShown)
 * @returns {null|{art: string, artOnly: boolean, name: string|null, state: string|null, stamina: object|null, facts: {key: string, value: string|number, data?: object}[], chars: {label: string, value: number}[], meters: object|null, motives: {label: string, kind: string}[]}}
 */
export function npcHoverCard(p) {
  if (!p.on) return null;
  if (!p.isGM && (p.hidden || p.disposition === SECRET_DISPOSITION)) return null;
  const card = { art: p.art || '', name: nameplateShown(p) ? (p.name || null) : null, state: null, stamina: null, facts: [], chars: [], meters: null, motives: [] };

  if (p.isGM && p.statBlock) {
    const s = p.stats ?? {};
    card.stamina = hoverStamina(p.stamina);
    if (s.sub) card.facts.push({ key: 'sub', value: s.sub });
    if (num(s.stability) !== null) card.facts.push({ key: 'CHRONICLE.NpcSheet.Hover.Stability', value: s.stability });
    if (num(s.freeStrike) !== null) card.facts.push({ key: 'CHRONICLE.NpcSheet.Hover.FreeStrike', value: s.freeStrike });
    if (s.immunities) card.facts.push({ key: 'CHRONICLE.NpcSheet.Hover.Immune', value: s.immunities });
    if (s.weaknesses) card.facts.push({ key: 'CHRONICLE.NpcSheet.Hover.Weak', value: s.weaknesses });
    if (s.conditions?.length) card.facts.push({ key: 'CHRONICLE.NpcSheet.Hover.Conditions', value: s.conditions.join(', ') });
    if (s.villain?.inFight && s.villain.total > 0) {
      card.facts.push({ key: 'CHRONICLE.NpcSheet.Villain.Left', value: '', data: { left: s.villain.left, total: s.villain.total } });
    }
    card.chars = (s.characteristics ?? []).filter((c) => c && num(c.value) !== null);
  } else if (p.statBlock) {
    const band = hoverStamina(p.stamina)?.band;
    if (band === 'winded') card.state = 'CHRONICLE.HeroSheet.Winded';
    else if (band === 'dying' || band === 'dead') card.state = 'CHRONICLE.HeroSheet.Dying';
  }

  // Mid-talk: only an NPC from a Chronicle page holds just the players' half.
  if (p.talking && p.linked && p.negotiation) {
    const n = p.negotiation;
    if (p.shown === true) {
      card.meters = {
        interest: num(n.interest), patience: num(n.patience), max: METER_MAX,
        interestPips: meterPips(n.interest), patiencePips: meterPips(n.patience),
      };
    }
    for (const label of n.motivations ?? []) card.motives.push({ label, kind: 'motivation' });
    for (const label of n.pitfalls ?? []) card.motives.push({ label, kind: 'pitfall' });
  }

  const hasWords = card.name || card.state || card.stamina || card.facts.length
    || card.chars.length || card.meters || card.motives.length;
  if (!hasWords && !card.art) return null;
  // Only a picture: the plain art preview shows it larger.
  card.artOnly = !hasWords;
  return card;
}
