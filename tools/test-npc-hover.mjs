#!/usr/bin/env node
/**
 * What hovering a Draw Steel NPC's token shows, by viewer. A player must
 * never get a number or a motivation the Director hasn't given away, and the
 * hover switches must still turn everything off.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY, nameplateShown, npcHoverCard, hoverStamina } from '../scripts/_npc-hover.mjs';

const STATS = {
  sub: 'Level 3 · Leader · Support',
  stability: 2,
  freeStrike: 5,
  immunities: 'Fire 5',
  weaknesses: '',
  conditions: ['Slowed'],
  villain: { left: 2, total: 3, inFight: true },
  characteristics: [{ label: 'Might', value: -1 }, { label: 'Presence', value: 3 }],
};

const base = (over = {}) => ({
  isGM: false,
  isOwner: false,
  on: true,
  hidden: false,
  disposition: -1,
  art: 'art/goblin.webp',
  name: 'Goblin War Chief',
  displayName: DISPLAY.NONE,
  linked: false,
  talking: false,
  statBlock: true,
  stamina: { value: 84, max: 120, winded: 60, min: -60 },
  stats: STATS,
  negotiation: null,
  shown: false,
  ...over,
});

test('the nameplate rule follows Foundry\'s display modes', () => {
  const cases = [
    [DISPLAY.NONE, false, false], [DISPLAY.HOVER, false, true], [DISPLAY.ALWAYS, false, true],
    [DISPLAY.OWNER, false, false], [DISPLAY.OWNER, true, true], [DISPLAY.OWNER_HOVER, true, true],
    [DISPLAY.CONTROL, false, false], [DISPLAY.CONTROL, true, true],
  ];
  for (const [displayName, isOwner, want] of cases) {
    assert.equal(nameplateShown({ displayName, isGM: false, isOwner }), want, `mode ${displayName}, owner ${isOwner}`);
  }
  assert.equal(nameplateShown({ displayName: DISPLAY.NONE, isGM: true, isOwner: false }), true);
});

test('the Director sees the stat block at a glance', () => {
  const card = npcHoverCard(base({ isGM: true }));
  assert.equal(card.name, 'Goblin War Chief');
  assert.deepEqual([card.stamina.value, card.stamina.max, card.stamina.windedAt, card.stamina.band], [84, 120, 50, 'healthy']);
  assert.deepEqual(card.facts.map((f) => f.key), [
    'sub', 'CHRONICLE.NpcSheet.Hover.Stability', 'CHRONICLE.NpcSheet.Hover.FreeStrike', 'CHRONICLE.NpcSheet.Hover.Immune',
    'CHRONICLE.NpcSheet.Hover.Conditions', 'CHRONICLE.NpcSheet.Villain.Left',
  ]);
  assert.deepEqual(card.facts.at(-1).data, { left: 2, total: 3 });
  assert.equal(card.chars.length, 2);
  assert.equal(card.state, null);
});

test('villain actions left show only in a fight', () => {
  const card = npcHoverCard(base({ isGM: true, stats: { ...STATS, villain: { left: 3, total: 3, inFight: false } } }));
  assert.ok(!card.facts.some((f) => f.key === 'CHRONICLE.NpcSheet.Villain.Left'));
});

test('a player sees the picture, the name only with the nameplate, and never a number', () => {
  const card = npcHoverCard(base());
  assert.equal(card.art, 'art/goblin.webp');
  assert.equal(card.name, null);
  assert.equal(card.stamina, null);
  assert.deepEqual(card.facts, []);
  assert.deepEqual(card.chars, []);
  assert.equal(card.state, null);
  assert.equal(card.artOnly, true);
  assert.equal(npcHoverCard(base({ displayName: DISPLAY.HOVER })).name, 'Goblin War Chief');
  assert.equal(npcHoverCard(base({ displayName: DISPLAY.HOVER })).artOnly, false);
  assert.doesNotMatch(JSON.stringify(card), /84|120|Fire|Slowed|Leader/);
});

test('a player sees Winded or Dying in words, from the same thresholds as the sheet', () => {
  assert.equal(npcHoverCard(base({ stamina: { value: 60, max: 120, winded: 60, min: -60 } })).state, 'CHRONICLE.HeroSheet.Winded');
  assert.equal(npcHoverCard(base({ stamina: { value: 0, max: 120, winded: 60, min: -60 } })).state, 'CHRONICLE.HeroSheet.Dying');
  assert.equal(npcHoverCard(base({ stamina: { value: 61, max: 120, winded: 60, min: -60 } })).state, null);
  // No stat block: no Stamina to judge.
  assert.equal(npcHoverCard(base({ statBlock: false, stamina: { value: 0, max: 0 } })).state, null);
});

test('a hidden or Secret token, or a switched-off hover, shows a player nothing', () => {
  assert.equal(npcHoverCard(base({ hidden: true, displayName: DISPLAY.ALWAYS })), null);
  assert.equal(npcHoverCard(base({ disposition: -2, displayName: DISPLAY.ALWAYS })), null);
  assert.equal(npcHoverCard(base({ on: false })), null);
  assert.equal(npcHoverCard(base({ isGM: true, on: false })), null);
  // The Director still sees a hidden token's card.
  assert.ok(npcHoverCard(base({ isGM: true, hidden: true })));
});

test('nothing to show is no card at all', () => {
  assert.equal(npcHoverCard(base({ art: '', stamina: { value: 100, max: 120, winded: 60 } })), null);
});

const NEG = { interest: 3, patience: 2, motivations: ['Greed'], pitfalls: ['Freedom'] };

test('mid-talk, a player sees what the party has found, and the meters once shown', () => {
  const hidden = npcHoverCard(base({ statBlock: false, talking: true, linked: true, negotiation: NEG, shown: false }));
  assert.equal(hidden.meters, null);
  assert.deepEqual(hidden.motives, [{ label: 'Greed', kind: 'motivation' }, { label: 'Freedom', kind: 'pitfall' }]);
  const shown = npcHoverCard(base({ statBlock: false, talking: true, linked: true, negotiation: NEG, shown: true }));
  assert.equal(shown.meters.interest, 3);
  assert.deepEqual(shown.meters.patiencePips, [true, true, false, false, false]);
});

test('an unlinked NPC\'s actor holds the Director\'s whole list, so a player never sees it', () => {
  const card = npcHoverCard(base({ statBlock: false, talking: true, linked: false, negotiation: NEG, shown: true }));
  assert.equal(card.meters, null);
  assert.deepEqual(card.motives, []);
});

test('not talking: no negotiation on the card', () => {
  const card = npcHoverCard(base({ statBlock: false, talking: false, linked: true, negotiation: NEG, shown: true }));
  assert.equal(card.meters, null);
  assert.deepEqual(card.motives, []);
});

test('Stamina with no maximum is not drawn', () => {
  assert.equal(hoverStamina({ value: 0, max: 0 }), null);
  assert.equal(hoverStamina({ value: 10, max: 20, winded: 10 }).band, 'winded');
});
