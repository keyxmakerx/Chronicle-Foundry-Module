#!/usr/bin/env node
/**
 * The Chronicle NPC and monster sheet's rules (scripts/_npc-looks.mjs):
 * which shape an actor gets, which template a look draws, what the
 * negotiation shows to whom, the villain action marks, and the page's text,
 * where a Director's secret must never land in the open paragraphs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NPC_LOOK_DIR, SHAPES, allNpcLookTemplates, answerKey, hasStatBlock, meterPips, motiveKey, motiveRows,
  negotiationView, npcChanges, npcLook, npcLookTemplate, npcPageId, npcParts, npcTabs, openingTab, pageChips,
  pageText, peopleRows, sheetShape, villainKey, villainMarks, withVillainUse,
} from '../scripts/_npc-looks.mjs';

test('sheetShape: a hand pick wins, a creature page is a monster, a character page an NPC', () => {
  assert.equal(sheetShape({ flag: 'monster', pageId: 'p1' }), 'monster');
  assert.equal(sheetShape({ flag: 'npc', creatureId: 'c1' }), 'npc');
  assert.equal(sheetShape({ creatureId: 'c1', linkedId: 'c1' }), 'monster');
  assert.equal(sheetShape({ pageId: 'p1' }), 'npc');
  assert.equal(sheetShape({ linkedId: 'p2' }), 'npc');
  assert.equal(sheetShape({}), 'monster');
  assert.equal(sheetShape({ flag: 'boss' }), 'monster');
  assert.deepEqual([...SHAPES], ['npc', 'monster']);
});

test('npcPageId: the page character sync made it from, then the creature page, then a dropped link', () => {
  assert.equal(npcPageId({ pageId: 'a', creatureId: 'b', linkedId: 'c' }), 'a');
  assert.equal(npcPageId({ creatureId: 'b', linkedId: 'c' }), 'b');
  assert.equal(npcPageId({ linkedId: 'c' }), 'c');
  assert.equal(npcPageId({ pageId: '' }), null);
});

test('templates: a look without NPC templates draws the Chronicle look, shared panes stay shared', () => {
  assert.equal(npcLook('hall'), 'chronicle');
  assert.equal(npcLook('chronicle'), 'chronicle');
  assert.equal(npcLookTemplate('chronicle', 'npc', 'header'), `${NPC_LOOK_DIR}/chronicle/npc-header.hbs`);
  assert.equal(npcLookTemplate('sky', 'monster', 'card'), `${NPC_LOOK_DIR}/chronicle/monster-card.hbs`);
  assert.equal(npcLookTemplate('chronicle', 'npc', 'talk'), null);
  assert.equal(npcLookTemplate('chronicle', 'boss', 'header'), null);
  const all = allNpcLookTemplates();
  assert.ok(all.includes(`${NPC_LOOK_DIR}/talk.hbs`));
  assert.ok(all.includes(`${NPC_LOOK_DIR}/edit-stats.hbs`));
  assert.ok(all.includes(`${NPC_LOOK_DIR}/chronicle/stamina-box.hbs`));
  assert.equal(new Set(all).size, all.length);
});

test('npcTabs: no Stats tab, Talk first, People after Features; npcParts: boxes above the tabs', () => {
  const base = { primary: { tabs: ['stats', 'features', 'abilities', 'effects', 'biography'].map((id) => ({ id })), initial: 'stats', labelPrefix: 'X' } };
  const tabs = npcTabs(base);
  assert.deepEqual(tabs.primary.tabs.map((t) => t.id), ['talk', 'abilities', 'features', 'people', 'effects', 'biography']);
  assert.equal(tabs.primary.tabs[0].label, 'CHRONICLE.NpcSheet.Tabs.talk');
  assert.equal(tabs.primary.labelPrefix, 'X');
  const parts = npcParts({ header: 1, tabs: 2, stats: 3, features: 4, abilities: 5, effects: 6, biography: 7 }, { header: 'H', stats: 'S', card: 'C' });
  assert.deepEqual(Object.keys(parts), ['header', 'stats', 'tabs', 'talk', 'people', 'features', 'abilities', 'effects', 'biography', 'card']);
  assert.equal(parts.stats, 'S');
});

test('openingTab: an NPC opens on Talk, but in a fight both shapes open on Abilities', () => {
  assert.equal(openingTab('npc', false), 'talk');
  assert.equal(openingTab('npc', true), 'abilities');
  assert.equal(openingTab('monster', false), 'abilities');
});

test('meters: five pips, answers from Draw Steel\'s offers, clamped', () => {
  assert.deepEqual(meterPips(3), [true, true, true, false, false]);
  assert.deepEqual(meterPips(9), [true, true, true, true, true]);
  assert.deepEqual(meterPips(null), [false, false, false, false, false]);
  assert.equal(answerKey(3), 'CHRONICLE.NpcSheet.Answer.3');
  assert.equal(answerKey(0), 'CHRONICLE.NpcSheet.Answer.0');
  assert.equal(answerKey(8), 'CHRONICLE.NpcSheet.Answer.5');
  assert.equal(answerKey(undefined), null);
});

const label = (k) => k[0].toUpperCase() + k.slice(1);
const GM = {
  interest: 3, patience: 2, impression: 4, shown: false,
  motivations: ['greed', 'protection', 'legacy', 'higher-authority'], pitfalls: ['freedom', 'justice'],
  found: { motivations: ['greed', 'protection'], pitfalls: ['freedom'] },
  used: ['protection'],
  log: [{ at: '1', text: 'first' }, { at: '2', text: 'second' }, { text: '' }],
};

test('motiveRows: found, appealed to, not found yet; Chronicle\'s slugs in Draw Steel\'s keys', () => {
  const rows = motiveRows(GM, label);
  assert.deepEqual(rows.map((r) => [r.kind, r.key, r.state]), [
    ['motivation', 'greed', 'found'],
    ['motivation', 'protection', 'used'],
    ['motivation', 'legacy', 'hidden'],
    ['motivation', 'authority', 'hidden'],
    ['pitfall', 'freedom', 'found'],
    ['pitfall', 'justice', 'hidden'],
  ]);
  assert.equal(rows[0].label, 'Greed');
  assert.equal(motiveKey('higher-authority'), 'authority');
  assert.deepEqual(motiveRows({ motivations: new Set(['greed']) }, label, { allFound: true }).map((r) => r.state), ['found']);
});

test('negotiationView: the Director reads Chronicle live, every state, newest argument first', () => {
  const v = negotiationView({ linked: true, isGM: true, live: { gm: GM }, labelOf: label });
  assert.equal(v.source, 'chronicle');
  assert.equal(v.interest, 3);
  assert.equal(v.patience, 2);
  assert.equal(v.impression, 4);
  assert.equal(v.shown, false);
  assert.equal(v.answer, 'CHRONICLE.NpcSheet.Answer.3');
  assert.equal(v.rows.length, 6);
  assert.deepEqual(v.log.map((e) => e.text), ['second', 'first']);
});

test('negotiationView: a player reads the actor, and its meters only once shown', () => {
  const actorNeg = { interest: 5, patience: 5, impression: 1, motivations: new Set(['greed']), pitfalls: new Set(['freedom']) };
  const hidden = negotiationView({ linked: true, isGM: false, actorNeg, shownFlag: false, labelOf: label });
  assert.equal(hidden.source, 'players');
  assert.equal(hidden.interest, null, 'Draw Steel\'s starting 5 is never shown as the real Interest');
  assert.equal(hidden.answer, null);
  assert.equal(hidden.impression, null);
  assert.deepEqual(hidden.rows.map((r) => [r.key, r.state]), [['greed', 'found'], ['freedom', 'found']]);
  const shown = negotiationView({ linked: true, isGM: false, actorNeg: { ...actorNeg, interest: 2 }, shownFlag: true, labelOf: label });
  assert.equal(shown.interest, 2);
  assert.equal(shown.answer, 'CHRONICLE.NpcSheet.Answer.2');
  // Live data handed in on a player's screen is ignored.
  assert.equal(negotiationView({ linked: true, isGM: false, live: { gm: GM }, actorNeg, shownFlag: false }).source, 'players');
});

test('negotiationView: no tracker yet, Chronicle unreachable, and an actor with no page', () => {
  const actorNeg = { interest: 4, patience: 3, impression: 2, motivations: ['peace'], pitfalls: [] };
  assert.equal(negotiationView({ linked: true, isGM: true, live: { gm: null }, actorNeg }).has, false);
  const off = negotiationView({ linked: true, isGM: true, liveFailed: true, actorNeg, shownFlag: false });
  assert.equal(off.source, 'offline');
  assert.equal(off.interest, null);
  const own = negotiationView({ linked: false, isGM: true, actorNeg });
  assert.equal(own.source, 'actor');
  assert.equal(own.interest, 4);
  assert.equal(own.impression, 2);
  assert.equal(negotiationView({ linked: false, isGM: false, actorNeg }).impression, null);
});

test('villainMarks: in order, used, next is the first unused, count left', () => {
  const va = [{ id: 'a', name: 'War Cry' }, { id: 'b', name: 'Reinforcements' }, { id: 'c', name: 'Gambit' }];
  const m = villainMarks(va, ['a']);
  assert.deepEqual(m.marks.map((x) => [x.order, x.state]), [[1, 'used'], [2, 'next'], [3, 'unused']]);
  assert.equal(m.left, 2);
  assert.equal(m.total, 3);
  assert.deepEqual(villainMarks(va, ['b']).marks.map((x) => x.state), ['next', 'used', 'unused']);
  assert.deepEqual(villainMarks(va, ['a', 'b', 'c']).marks.map((x) => x.state), ['used', 'used', 'used']);
  assert.equal(villainMarks([], []).total, 0);
});

test('villain use on the combat: kept per actor uuid, toggled, empty entries dropped', () => {
  assert.equal(villainKey('Scene.s.Token.t.Actor.a'), 'Scene~s~Token~t~Actor~a');
  let map = withVillainUse(null, 'k', 'a');
  assert.deepEqual(map, { k: ['a'] });
  map = withVillainUse({ ...map, other: ['x'], empty: [] }, 'k', 'b', true);
  assert.deepEqual(map, { other: ['x'], k: ['a', 'b'] });
  map = withVillainUse(map, 'k', 'a');
  assert.deepEqual(map.k, ['b']);
  map = withVillainUse(map, 'k', 'b', false);
  assert.equal('k' in map, false);
});

test('hasStatBlock: Draw Steel\'s empty defaults are no stat block', () => {
  assert.equal(hasStatBlock({ staminaMax: 0, abilityCount: 0 }), false);
  assert.equal(hasStatBlock({ staminaMax: 120, abilityCount: 0 }), true);
  assert.equal(hasStatBlock({ staminaMax: 0, abilityCount: 2 }), true);
  assert.equal(hasStatBlock({}), false);
});

test('pageText: open paragraphs and secrets apart, never a secret in the open text', () => {
  const html = '<p>Owns most of the <b>salt</b> caravans.<span data-secret="true"> Holds half the debts.</span> Smiles a lot.</p>'
    + '<h2>Wants</h2><p>The salt to keep moving &amp; more.</p>'
    + '<section class="secret"><p>Would burn the wells.</p></section>'
    + '<figure class="ce-img ce-img--gm"><img src="x"><figcaption>A map of the hidden route</figcaption></figure>'
    + '<p>Line<br>break</p><!-- note -->';
  const { open, secrets } = pageText(html);
  assert.deepEqual(open, ['Owns most of the salt caravans. Smiles a lot.', 'Wants', 'The salt to keep moving & more.', 'Line break']);
  assert.deepEqual(secrets, ['Holds half the debts.', 'Would burn the wells.', 'A map of the hidden route']);
  assert.ok(!open.join(' ').includes('debts'));
  assert.deepEqual(pageText(null), { open: [], secrets: [] });
  assert.equal(pageText('<p>a</p><p>b</p><p>c</p>', { maxParagraphs: 2 }).open.length, 2);
  assert.deepEqual(pageText('<p>&lt;script&gt;x&lt;/script&gt; &#x2014; &#8212;</p>').open, ['<script>x</script> — —']);
});

test('pageChips: faction and tags, never a Director-only tag', () => {
  const chips = pageChips({ fields_data: { faction: ' Salt Guild ' }, tags: ['Ignited', { name: 'Secret', dmOnly: true }, { name: 'Saltreach' }] });
  assert.deepEqual(chips, [{ kind: 'Faction', name: 'Salt Guild' }, { kind: 'Tag', name: 'Ignited' }, { kind: 'Tag', name: 'Saltreach' }]);
  assert.deepEqual(pageChips(null), []);
});

test('peopleRows: named from this page\'s side, sorted, Director-only marked', () => {
  const rows = peopleRows({ data: [
    { sourceEntityId: 'p', targetEntityId: 'm', targetEntityName: 'Mara', relationType: 'owes him a favour', reverseRelationType: 'is owed by' },
    { sourceEntityId: 'x', targetEntityId: 'l', targetEntityName: 'Lastwell', relationType: 'bleeds for', reverseRelationType: 'drains', dmOnly: true },
    { targetEntityName: '' },
  ] }, 'p');
  assert.deepEqual(rows, [
    { id: 'l', name: 'Lastwell', how: 'drains', dmOnly: true },
    { id: 'm', name: 'Mara', how: 'owes him a favour', dmOnly: false },
  ]);
  assert.deepEqual(peopleRows(null, 'p'), []);
});

test('npcChanges: the hero moves, then villain action, Malice, winded, Interest, pitfall and reveal', () => {
  const before = { villainUsed: 0, malice: 3, band: 'healthy', interest: 2, motives: [{ kind: 'pitfall', key: 'justice', state: 'hidden' }, { kind: 'motivation', key: 'legacy', state: 'hidden' }] };
  const after = { villainUsed: 1, malice: 4, band: 'winded', interest: 3, motives: [{ kind: 'pitfall', key: 'justice', state: 'found' }, { kind: 'motivation', key: 'legacy', state: 'found' }] };
  assert.deepEqual(npcChanges(before, after, ['hit', 'level']), ['hit', 'va', 'malice', 'winded', 'up', 'pit', 'reveal']);
  assert.deepEqual(npcChanges({ ...before, interest: 3 }, { ...before, interest: 1 }), ['down']);
  assert.deepEqual(npcChanges(null, after), []);
  assert.deepEqual(npcChanges({ villainUsed: null, malice: null }, { villainUsed: 1, malice: 4 }), []);
});
