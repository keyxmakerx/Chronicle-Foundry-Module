#!/usr/bin/env node
/**
 * Pins scripts/_dm-screen-view.mjs: the DM Screen window must fold heroes
 * and word things as Chronicle's own panel does, from the JSON Chronicle's
 * GET /dm-screen sends (field names from dmscreen.View's JSON tags).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorKey, foldHero, plural, screenContext } from '../scripts/_dm-screen-view.mjs';

const VIEW = {
  campaign_id: 'camp 1',
  downtime: { open: false, can_toggle: true, pending: 2 },
  world: { calendar_id: 'cal-1', date_label: '3 Frostfall 1204', time_label: '14:00', weather: 'Light snow' },
  night: { name: 'Session 12', when: 'Fri 7pm', going: 3, maybe: 1, cant: 0, no_answer: 2 },
  foundry: { connected: true, never_seen: false },
  system_name: 'Draw Steel',
  party_filled: true,
  party: [{
    id: 'h1', name: 'Vex', player_name: 'Sam', subtitle: 'Shadow', conditions: ['Bleeding', 'Slowed'],
    meters: [
      { label: 'Stamina', current: '12', max: '30', has_max: true, percent: 40, low: true },
      { label: 'Insight', current: '3', max: '', has_max: false, percent: 0, low: false },
      { label: 'Recoveries', current: '6', max: '8', has_max: true, percent: 75, low: false },
    ],
  }],
  hidden: [{ id: 'n1', name: 'The Baron', type_name: 'Character', revealed: false }],
  conditions: [{ name: 'Bleeding', text: 'Lose stamina.' }],
};

test('foldHero: first meter with a max is the bar, no-max meters are chips, the rest fold', () => {
  const h = foldHero(VIEW.party[0]);
  assert.equal(h.bar.label, 'Stamina');
  assert.equal(h.bar.low, true);
  assert.deepEqual(h.chips.map((m) => m.label), ['Insight']);
  assert.deepEqual(h.rest.map((m) => m.label), ['Recoveries']);
  assert.equal(h.conditionList, 'Bleeding, Slowed');
  assert.equal(h.playerName, 'Sam');
  assert.equal(h.showWho, true);
});

test('foldHero: survives a hero with no meters or junk fields', () => {
  const h = foldHero({ name: 'Ash', meters: 'nope', conditions: [1, '', 'Prone'] });
  assert.equal(h.bar, null);
  assert.deepEqual(h.chips, []);
  assert.deepEqual(h.conditions, ['Prone']);
  assert.equal(h.showWho, false);
});

test('foldHero: percent is clamped for the bar width', () => {
  const h = foldHero({ meters: [{ label: 'HP', current: '50', max: '10', has_max: true, percent: 500 }] });
  assert.equal(h.bar.percent, 100);
});

test('screenContext: strip, world and links match the site panel', () => {
  const c = screenContext(VIEW, { apiUrl: 'https://chronicle.example/' });
  assert.equal(c.night.tally, '3 coming · 1 maybe · 2 no answer');
  assert.equal(c.world.date, '3 Frostfall 1204 · 14:00');
  assert.equal(c.world.calendarUrl, 'https://chronicle.example/campaigns/camp%201/calendars/cal-1');
  assert.equal(c.downtime.note, 'Moves need your OK. Shops are closed.');
  assert.equal(c.downtime.pending, '2 requests waiting on you');
  assert.equal(c.downtime.pendingUrl, 'https://chronicle.example/campaigns/camp%201/armory/stashes');
  assert.equal(c.worldEmpty, false);
  assert.equal(c.hasRules, true);
  assert.equal(c.partyNote, '');
  assert.deepEqual(c.hidden, [{ id: 'n1', name: 'The Baron', revealed: false }]);
});

test('screenContext: an empty or missing view still renders', () => {
  for (const v of [null, {}, { party: null, hidden: 'x' }]) {
    const c = screenContext(v, {});
    assert.equal(c.night, null);
    assert.equal(c.worldEmpty, true);
    assert.deepEqual(c.party, []);
    assert.equal(c.hasRules, false);
  }
});

test('screenContext: party without system numbers says why', () => {
  const base = { party: [{ id: 'h', name: 'A' }], party_filled: false };
  assert.equal(screenContext({ ...base, system_name: 'Draw Steel' }).partyNote, "Draw Steel doesn't fill in hero numbers yet.");
  assert.match(screenContext(base).partyNote, /Turn on a game system/);
});

test('plural', () => {
  assert.equal(plural(1, 'request', 'requests'), '1 request');
  assert.equal(plural(0, 'request', 'requests'), '0 requests');
});

test('errorKey: a 404 means Chronicle needs updating', () => {
  assert.equal(errorKey({ status: 404 }), 'NeedsUpdate');
  assert.equal(errorKey({ status: 401 }), 'BadKey');
  assert.equal(errorKey({ status: 403 }), 'NotAllowed');
  assert.equal(errorKey({ status: 500 }), 'Failed');
  assert.equal(errorKey(new Error('network')), 'Failed');
});

test('downtime switch asks first and says what starting it does', () => {
  const closed = screenContext({ downtime: { open: false, can_toggle: true, pending: 2 } }).downtime.confirm;
  assert.equal(closed.yes, 'Start downtime');
  assert.equal(closed.text, 'Start downtime? 2 waiting requests go through now and shops open.');
  const one = screenContext({ downtime: { open: false, pending: 1 } }).downtime.confirm;
  assert.match(one.text, /1 waiting request goes through now/);
  const none = screenContext({ downtime: { open: false, pending: 0 } }).downtime.confirm;
  assert.equal(none.text, 'Start downtime? Moves will happen at once and shops open.');
  const open = screenContext({ downtime: { open: true } }).downtime.confirm;
  assert.equal(open.yes, 'End downtime');
});
