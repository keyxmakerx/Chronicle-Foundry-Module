#!/usr/bin/env node
/**
 * Creature forms: reading a stored form, laying it over the page, the
 * Stamina rule on a change of form, and what Chronicle is told afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_FLAG, appliedVersion, cleanForm, formChoices, formEntity, formIndex, formKey, isFormsKey,
  publicAfterChange, staminaAfter,
} from '../scripts/_creature-forms.mjs';

const ART = '0b8a3f1e-1111-4222-8333-444455556666';
const TOKEN = '0b8a3f1e-1111-4222-8333-777788889999';
const PAGE = {
  id: 'e1',
  name: 'The Hollow Queen',
  updated_at: '2026-10-17T10:00:00Z',
  image_path: `2026/10/${ART}.webp`,
  fields_data: {
    stamina: 300, speed: 6, token_image: TOKEN,
    abilities_json: JSON.stringify([{ name: 'Thorn Lash', tier1: '7 damage' }, { name: 'Court Command' }]),
    traits: 'Glamour: hard to look at.',
  },
};

test('a stored form is cleaned the way the stat block cleans it', () => {
  assert.equal(cleanForm(null), null);
  assert.equal(cleanForm({ id: 'Bad Id' }), null);
  const f = cleanForm({
    id: 'swarm', name: '', stamina: 'nope', art: 'x', token: TOKEN,
    changes: { stamina: 120, image_path: 'evil', speed: { x: 1 } },
    lists: { abilities_json: { drop: ['Court Command'], add: [{ name: 'Bite' }, 'x'] }, bogus: { drop: ['a'] } },
  });
  assert.equal(f.name, 'Unnamed form');
  assert.equal(f.stamina, 'carry');
  assert.equal(f.art, '');
  assert.equal(f.token, TOKEN);
  assert.deepEqual(f.changes, { stamina: 120 });
  assert.deepEqual(Object.keys(f.lists), ['abilities_json']);
  assert.deepEqual(f.lists.abilities_json.add, [{ name: 'Bite' }]);
});

test('the page as a form: changes laid over, changed abilities in place, pictures borrowed', () => {
  const form = cleanForm({
    id: 'unmasked', changes: { speed: 8 },
    lists: { abilities_json: { drop: ['Thorn Lash', 'Court Command'], add: [{ name: 'Thorn Lash', tier1: '9 damage' }, { name: 'Shriek' }] } },
  });
  const v = formEntity(PAGE, form);
  assert.equal(v.fields_data.speed, 8);
  assert.equal(v.fields_data.stamina, 300);
  assert.deepEqual(JSON.parse(v.fields_data.abilities_json), [{ name: 'Thorn Lash', tier1: '9 damage' }, { name: 'Shriek' }]);
  assert.equal(v.fields_data.traits, PAGE.fields_data.traits, 'an untouched list is left as stored');
  assert.equal(v.image_path, ART);
  assert.equal(v.fields_data.token_image, TOKEN);
  assert.equal(PAGE.fields_data.speed, 6, 'the page itself is not changed');
  assert.equal(formEntity(PAGE, null), PAGE);
});

test('a form with its own art and no token lets the art be the token', () => {
  const v = formEntity(PAGE, cleanForm({ id: 'a', art: TOKEN }));
  assert.equal(v.image_path, TOKEN);
  assert.equal(v.fields_data.token_image, '');
});

test('an edited form, or another form, is a new version to apply', () => {
  const a = cleanForm({ id: 'a', changes: { speed: 8 } });
  const b = cleanForm({ id: 'a', changes: { speed: 9 } });
  assert.equal(appliedVersion('t1', null), 't1');
  assert.notEqual(appliedVersion('t1', a), 't1');
  assert.notEqual(appliedVersion('t1', a), appliedVersion('t1', b));
  assert.equal(appliedVersion('t1', a), appliedVersion('t1', cleanForm({ id: 'a', changes: { speed: 8 } })));
});

test('Stamina: damage carries over, or the form starts fresh', () => {
  const cases = [
    ['carry', { oldMax: 300, oldValue: 205, newMax: 120, mode: 'carry' }, 25],
    ['carry past zero stays at zero', { oldMax: 300, oldValue: 100, newMax: 120, mode: 'carry' }, 0],
    ['default is carry', { oldMax: 50, oldValue: 40, newMax: 80 }, 70],
    ['fresh', { oldMax: 300, oldValue: 5, newMax: 120, mode: 'fresh' }, 120],
    ['no new maximum', { oldMax: 300, oldValue: 5, newMax: undefined, mode: 'fresh' }, null],
  ];
  for (const [name, input, want] of cases) assert.equal(staminaAfter(input), want, name);
});

test('the picker lists the first form, then the director’s order, marking the current one', () => {
  const rows = formChoices('The Hollow Queen', [{ id: 'a', name: 'Unmasked' }, { id: 'b', name: 'The Swarm' }], 'a');
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.current]), [['', 'The Hollow Queen', false], ['a', 'Unmasked', true], ['b', 'The Swarm', false]]);
  assert.equal(formChoices('Q', [], '')[0].current, true);
});

test('players’ page follows the change: seen when a token was visible, current only once seen', () => {
  const index = formIndex({ gm: { order: ['a', 'b'] }, public: { shown: ['a'], current: 'a', note: 'kept' } });
  assert.deepEqual(publicAfterChange(index, 'b', true), { shown: ['a', 'b'], current: 'b', note: 'kept', v: 1 });
  assert.deepEqual(publicAfterChange(index, 'b', false), { shown: ['a'], current: '', note: 'kept', v: 1 });
  assert.deepEqual(publicAfterChange(index, '', true), { shown: ['a'], current: '', note: 'kept', v: 1 });
});

test('the forms documents are recognised by key', () => {
  assert.equal(isFormsKey('forms'), true);
  assert.equal(isFormsKey(formKey('abc')), true);
  assert.equal(isFormsKey('form-'), false);
  assert.equal(isFormsKey('foundry'), false);
  assert.equal(FORM_FLAG, 'creatureForm');
});

// CreatureSync.changeForm against stubbed Foundry globals and a fake Chronicle.
async function harness({ hidden = false, shown = [] } = {}) {
  const flags = {};
  const calls = [];
  const docs = {
    forms: { gm: { order: ['swarm'] }, public: { shown, current: '' } },
    'form-swarm': { gm: { id: 'swarm', name: 'The Swarm', stamina: 'carry', changes: { stamina: 120 } }, public: {} },
  };
  const tokenActor = { system: { stamina: { max: 300, value: 205 } }, update: async (u) => { calls.push(['stamina', u]); tokenActor.system.stamina.value = u['system.stamina.value']; } };
  const actor = {
    id: 'a1', name: 'The Hollow Queen', prototypeToken: { texture: { src: 'worlds/w/new-token.webp' } },
    getFlag: (_s, k) => (k === 'creatureEntityId' ? 'e1' : flags[k]),
    update: async (u) => { calls.push(['actor', u]); for (const [k, v] of Object.entries(u)) { const key = k.split('.').pop(); if (key.startsWith('-=')) delete flags[key.slice(2)]; else flags[key] = v; } },
  };
  const tokenDoc = { id: 't1', name: 'The Hollow Queen', actorId: 'a1', baseActor: actor, actor: tokenActor, hidden, texture: { src: 'old.webp' }, update: async (u) => calls.push(['token', u]) };
  const scene = { id: 's1', tokens: { contents: [tokenDoc] } };
  tokenDoc.parent = scene;
  globalThis.game = {
    user: { id: 'gm', isGM: true, active: true }, users: { activeGM: null },
    settings: { get: (_m, k) => k === 'syncCreatures' || undefined },
    actors: { get: () => actor, find: () => actor, filter: () => [actor] },
  };
  game.users.activeGM = game.user;
  globalThis.canvas = { scene };
  // Enough of Foundry for the import chain; the app classes are never used here.
  globalThis.foundry = {
    utils: { getProperty: (o, p) => p.split('.').reduce((x, k) => x?.[k], o) },
    applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (c) => c, DialogV2: null } },
  };
  const { CreatureSync } = await import('../scripts/creature-sync.mjs');
  const sync = new CreatureSync();
  sync._defs = { system_id: 'drawsteel', fields: [{ key: 'stamina', foundry_path: 'system.stamina.max' }, { key: 'stamina_current', foundry_path: 'system.stamina.value' }] };
  sync._api = {
    get: async (path) => {
      calls.push(['get', path]);
      if (path === '/entities/e1') return { ...PAGE };
      const key = path.split('/').pop();
      if (docs[key]) return JSON.parse(JSON.stringify(docs[key]));
      const e = new Error('nf'); e.status = 404; throw e;
    },
    put: async (path, body) => { calls.push(['put', path.split('/').pop(), body]); },
  };
  // Applying the form is the upsert's job; here it raises the actor's maximum.
  sync._upsert = async () => { tokenActor.system.stamina.max = flags.creatureForm ? 120 : 300; return true; };
  return { sync, tokenDoc, calls, flags };
}

test('changing form: actor flagged, token repainted, damage carried, Chronicle told in order', async () => {
  const { sync, tokenDoc, calls, flags } = await harness();
  const out = await sync.changeForm(tokenDoc, 'swarm');
  assert.equal(flags.creatureForm, 'swarm');
  assert.deepEqual(calls.find((c) => c[0] === 'token')[1], { 'texture.src': 'worlds/w/new-token.webp' });
  assert.deepEqual(calls.find((c) => c[0] === 'stamina')[1], { 'system.stamina.value': 25 });
  assert.deepEqual(out.stamina, [{ name: 'The Hollow Queen', value: 25, max: 120 }]);
  assert.equal(out.formName, 'The Swarm');
  assert.equal(out.recorded, true);
  const puts = calls.filter((c) => c[0] === 'put');
  assert.deepEqual(puts.map((p) => p[1]), ['form-swarm', 'forms'], 'the public copy lands before the index lists it');
  assert.equal(puts[0][2].public.name, 'The Swarm');
  assert.ok(!('gm' in puts[0][2]) && !('gm' in puts[1][2]), 'the director’s halves are never written from here');
  assert.deepEqual(puts[1][2].public, { shown: ['swarm'], current: 'swarm', v: 1 });
});

test('a change behind a hidden token tells players nothing', async () => {
  const { sync, tokenDoc, calls } = await harness({ hidden: true });
  await sync.changeForm(tokenDoc, 'swarm');
  const puts = calls.filter((c) => c[0] === 'put');
  assert.deepEqual(puts.map((p) => p[1]), ['forms']);
  assert.deepEqual(puts[0][2].public, { shown: [], current: '', v: 1 });
});

test('back to the first form clears the flag', async () => {
  const { sync, tokenDoc, flags } = await harness({ shown: ['swarm'] });
  await sync.changeForm(tokenDoc, 'swarm');
  sync._formsCache.clear();
  await sync.changeForm(tokenDoc, '');
  assert.equal(flags.creatureForm, undefined);
});

test('an older Chronicle without the write route still changes form here', async () => {
  const { sync, tokenDoc, flags } = await harness();
  sync._api.put = async () => { const e = new Error('nf'); e.status = 404; throw e; };
  const out = await sync.changeForm(tokenDoc, 'swarm');
  assert.equal(flags.creatureForm, 'swarm');
  assert.equal(out.recorded, false);
});
