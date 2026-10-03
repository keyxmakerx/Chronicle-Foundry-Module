#!/usr/bin/env node
/**
 * NPC presence rules (scripts/_npc-presence.mjs): a token links to one
 * Chronicle page or none, a spotlight never plays for a viewer who can't see
 * the token, talking switches off after two quiet minutes, the glow eases to
 * still while the viewer is away, and revealing a token asks about the page
 * only when that page is still hidden. Also pins that the HUD wiring keeps
 * hero actors out and never reveals anything without the GM's yes.
 *
 * Run: node --test tools/test-npc-presence.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  TALK_TIMEOUT_MS, IDLE_MS, SPOT,
  normalizeName, matchPageByName, resolveTokenPage, spotlightAction,
  isTalkLive, spotlightRing, talkingRing, stepAmp, isResting, shouldAskReveal,
  chooseSpotlightToken,
} from '../scripts/_npc-presence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const glue = readFileSync(resolve(REPO_ROOT, 'scripts/npc-presence.mjs'), 'utf8');

const pages = [
  { entityId: 'e1', name: 'Captain Varra Ostin', typeName: 'NPCs' },
  { entityId: 'e2', name: 'The Gull', typeName: 'Characters' },
  { entityId: 'e3', name: 'Saltmarsh', typeName: 'Locations' },
  { entityId: 'e4', name: 'Saltmarsh', typeName: 'NPCs' },
  { entityId: 'e5', name: 'Twin', typeName: 'NPCs' },
  { entityId: 'e6', name: 'Twin', typeName: 'Creature' },
];

test('names match ignoring case and extra spaces', () => {
  assert.equal(normalizeName('  Captain   Varra OSTIN '), 'captain varra ostin');
  assert.equal(matchPageByName('captain varra ostin', pages), 'e1');
});

test('a name tie links only when one page is a person-like type', () => {
  assert.equal(matchPageByName('Saltmarsh', pages), 'e4');
  assert.equal(matchPageByName('Twin', pages), null);
  assert.equal(matchPageByName('Nobody', pages), null);
  assert.equal(matchPageByName('', pages), null);
});

test('an explicit link wins, a hero is left to character sync, a stale link falls back', () => {
  assert.equal(resolveTokenPage({ linkedEntityId: 'e2', names: ['Captain Varra Ostin'], pages }), 'e2');
  assert.equal(resolveTokenPage({ heroEntityId: 'h1', linkedEntityId: 'e2', names: ['The Gull'], pages }), null);
  assert.equal(resolveTokenPage({ linkedEntityId: 'gone', names: ['The Gull'], pages }), 'e2');
  assert.equal(resolveTokenPage({ names: ['Goblin 3', 'The Gull'], pages }), 'e2');
});

test('a spotlight plays only for viewers who can see the token', () => {
  const base = { sameScene: true, tokenFound: true, tokenHidden: false, visibleToMe: true };
  assert.equal(spotlightAction({ ...base, isGM: false }), 'play');
  assert.equal(spotlightAction({ ...base, isGM: false, visibleToMe: false }), 'skip');
  assert.equal(spotlightAction({ ...base, isGM: false, tokenHidden: true }), 'skip');
  assert.equal(spotlightAction({ ...base, isGM: true, tokenHidden: true }), 'note-hidden');
  assert.equal(spotlightAction({ ...base, isGM: true, sameScene: false }), 'note-elsewhere');
  assert.equal(spotlightAction({ ...base, isGM: false, sameScene: false }), 'skip');
});

test('talking stays live for two minutes after the last line', () => {
  assert.equal(TALK_TIMEOUT_MS, 120000);
  assert.equal(isTalkLive({ at: 1000 }, 1000 + TALK_TIMEOUT_MS - 1), true);
  assert.equal(isTalkLive({ at: 1000 }, 1000 + TALK_TIMEOUT_MS), false);
  assert.equal(isTalkLive(null, 5), false);
  assert.equal(isTalkLive({ at: 'x' }, 5), false);
});

test('the spotlight ring blooms in, holds, fades and ends', () => {
  assert.equal(spotlightRing(0).alpha, 0);
  const settled = spotlightRing(SPOT.BLOOM_AT + SPOT.BLOOM_MS + 10);
  assert.equal(settled.scale, 1);
  assert.equal(settled.alpha, 1);
  const end = SPOT.BLOOM_AT + SPOT.BLOOM_MS + SPOT.HOLD_MS + SPOT.FADE_MS;
  assert.equal(spotlightRing(end).done, true);
  assert.ok(spotlightRing(end - SPOT.FADE_MS / 2).alpha < 1);
  for (let t = 0; t < end; t += 37) {
    const r = spotlightRing(t);
    assert.ok(r.scale >= 1 && r.scale <= 2.4 && r.alpha >= 0 && r.alpha <= 1, `frame ${t}`);
  }
});

test('the talking glow is still when amplitude is zero', () => {
  for (const t of [0, 450, 900, 1350]) assert.equal(talkingRing(t, 0).scale, 1);
  assert.ok(talkingRing(900, 1).scale > 1.1);
});

test('stepping away eases the glow to still and back over about a second', () => {
  assert.equal(stepAmp(1, true, 500), 0.5);
  assert.equal(stepAmp(0.5, true, 2000), 0);
  assert.equal(stepAmp(0, false, 250), 0.25);
  assert.equal(stepAmp(0.9, false, 500), 1);
  assert.equal(isResting({ hidden: true, lastInput: 0, now: 0 }), true);
  assert.equal(isResting({ hidden: false, lastInput: 0, now: IDLE_MS - 1 }), false);
  assert.equal(isResting({ hidden: false, lastInput: 0, now: IDLE_MS }), true);
});

test('revealing a token asks only for a linked page that is still hidden', () => {
  assert.equal(shouldAskReveal({ wasHidden: true, nowHidden: false, entityId: 'e1', pagePrivate: true }), true);
  assert.equal(shouldAskReveal({ wasHidden: true, nowHidden: false, entityId: 'e1', pagePrivate: false }), false);
  assert.equal(shouldAskReveal({ wasHidden: true, nowHidden: false, entityId: null, pagePrivate: true }), false);
  assert.equal(shouldAskReveal({ wasHidden: false, nowHidden: true, entityId: 'e1', pagePrivate: true }), false);
});

test('the page is revealed only after the GM says yes', () => {
  const ask = glue.indexOf('confirmDialog({');
  const post = glue.indexOf("api.post(`/entities/${page.entityId}/reveal`");
  assert.ok(ask > 0 && post > ask, 'reveal call must follow the confirm');
  assert.ok(/if \(!ok\) return;/.test(glue.slice(ask, post)));
  assert.equal((glue.match(/\/reveal`/g) || []).length, 1, 'only one reveal call');
});

test('the drop link uses its own flag, so character sync never treats an NPC as a hero', () => {
  assert.match(glue, /export const LINK_FLAG = 'npcEntityId'/);
  assert.doesNotMatch(glue, /setFlag\(FLAG_SCOPE, 'entityId'/);
});

test('players never get the HUD tools', () => {
  assert.match(glue, /function _onRenderHud\(hud, html\) \{\n\s+if \(!game\.user\.isGM\) return;/);
});

test('only a spotlight sent by a GM plays, judged by Foundry\'s sender id', () => {
  assert.match(glue, /function _onSocket\(data, senderId\)/);
  assert.match(glue, /if \(!game\.users\?\.get\(senderId\)\?\.isGM\) return;/);
});

test('Show in Foundry picks a shown token for that page on this scene, else a hidden one, else none', () => {
  const tokens = [
    { id: 't1', entityId: 'e1', hidden: true },
    { id: 't2', entityId: 'e2', hidden: false },
    { id: 't3', entityId: 'e1', hidden: false },
    { id: 't4', entityId: null, hidden: false },
  ];
  assert.equal(chooseSpotlightToken(tokens, 'e1').id, 't3');
  assert.equal(chooseSpotlightToken(tokens.slice(0, 2), 'e1').id, 't1');
  assert.equal(chooseSpotlightToken(tokens, 'e9'), null);
  assert.equal(chooseSpotlightToken(tokens, ''), null);
  assert.equal(chooseSpotlightToken(null, 'e1'), null);
});

test('a Chronicle spotlight runs once, on the active GM, through the normal spotlight', () => {
  const relay = glue.slice(glue.indexOf('export const npcSpotlightRelay'));
  assert.match(relay, /msg\?\.type !== 'npc\.spotlight'/);
  assert.match(relay, /if \(!game\.user\.isGM \|\| !game\.users\?\.activeGM\?\.isSelf\) return;/);
  assert.match(relay.slice(relay.indexOf('function _spotlightFromChronicle')), /_spotlight\(token\);/);
});
