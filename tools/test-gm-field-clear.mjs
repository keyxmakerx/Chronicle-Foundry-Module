#!/usr/bin/env node
/**
 * GM-only character fields never land on a Foundry actor, and a copy an
 * earlier sync left there is cleared only when it is still Chronicle's text.
 *
 * Run: `node --test tools/test-gm-field-clear.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { clearableGmFields, planGmFieldClear, holdsGmFieldText } = await import('../scripts/_gm-field-clear.mjs');
const { createGenericAdapter } = await import('../scripts/adapters/generic-adapter.mjs');
const { creatureUpdate, seedPull, creaturePull } = await import('../scripts/_creature-fields.mjs');
const { treasureUpdate } = await import('../scripts/_treasure-item.mjs');

const SECRET = 'The mayor is the cult leader';

/** A character-fields answer as Chronicle sends it now. */
const FIELDS_NOW = [
  { key: 'might', label: 'Might', type: 'number', foundry_path: 'system.characteristics.might.value', foundry_writable: true },
  { key: 'backstory', label: 'Backstory', type: 'markdown', owner_only: true, foundry_path: 'system.biography.value', foundry_writable: true },
  { key: 'gm_notes', label: 'GM Notes', type: 'markdown', gm_only: true, foundry_writable: false, foundry_clear_path: 'system.biography.director' },
];

/** A Chronicle that still sends a path for the GM-only field. */
const FIELDS_MAPPED = FIELDS_NOW.map((f) => (f.gm_only
  ? { ...f, foundry_path: 'system.biography.director', foundry_writable: true }
  : f));

const ENTITY = { name: 'Tyne', fields_data: { might: 2, backstory: 'Born under ash', gm_notes: SECRET } };

const adapterFor = (fields) => createGenericAdapter({ get: async () => ({ preset_slug: 'drawsteel-character', fields }) }, 'drawsteel');

test('the hero update never writes a GM-only field', async (t) => {
  for (const [name, fields] of [['current Chronicle', FIELDS_NOW], ['Chronicle sending a path', FIELDS_MAPPED]]) {
    await t.test(name, async () => {
      const adapter = await adapterFor(fields);
      const update = adapter.fromChronicleFields(ENTITY);
      assert.equal(update['system.biography.director'], undefined);
      assert.ok(!JSON.stringify(update).includes(SECRET), `secret in update: ${JSON.stringify(update)}`);
      assert.equal(update['system.characteristics.might.value'], 2);
      assert.equal(update['system.biography.value'], 'Born under ash');
      assert.ok(!adapter.fieldDefs.some((f) => f.key === 'gm_notes'), 'gm_notes must not be mapped either way');
    });
  }
});

test('a player edit at the GM-only path is never pushed to Chronicle', async () => {
  const adapter = await adapterFor(FIELDS_MAPPED);
  const actor = { system: { characteristics: { might: { value: 2 } }, biography: { value: '', director: 'player wrote this' } }, items: { contents: [] } };
  assert.equal(adapter.toChronicleFieldsChanged(actor, { system: { biography: { director: 'player wrote this' } } }), null);
  assert.ok(!('gm_notes' in adapter.toChronicleFields(actor)));
});

test('creature and item updates skip a GM-only field even with a path', () => {
  const gm = { key: 'gm_notes', label: 'GM Notes', type: 'markdown', gm_only: true, foundry_path: 'system.biography.director' };
  const entity = { name: 'Goblin', fields_data: { gm_notes: SECRET } };
  assert.ok(!JSON.stringify(creatureUpdate({ entity, fields: [gm], choicesFor: () => null }).update).includes(SECRET));
  assert.deepEqual(seedPull({ entity, fields: [gm], pullKeys: ['gm_notes'], choicesFor: () => null }), {});
  assert.deepEqual(creaturePull({ system: { biography: { director: 'x' } } }, [gm], ['gm_notes']), {});
  const item = treasureUpdate({ entity, fields: [gm], choicesFor: () => null, showWords: true, clear: true });
  assert.ok(!('system.biography.director' in item.update) && !JSON.stringify(item.update).includes(SECRET));
});

test('clearableGmFields keeps only GM-only fields that name a path', () => {
  assert.deepEqual(clearableGmFields(FIELDS_NOW).map((f) => f.key), ['gm_notes']);
  assert.deepEqual(clearableGmFields([{ key: 'x', gm_only: true }, { key: 'y', foundry_clear_path: 'a.b' }]), []);
  assert.deepEqual(clearableGmFields(null), []);
});

test('planGmFieldClear', async (t) => {
  const hero = (director) => ({ system: { biography: { director } } });
  const cases = [
    { name: 'clears a copy that is still Chronicle\'s text', director: SECRET, want: { 'system.biography.director': '' }, kept: [] },
    { name: 'clears it despite spacing Foundry changed', director: `  The mayor is\nthe cult leader `, want: { 'system.biography.director': '' }, kept: [] },
    { name: 'keeps other text and names the field', director: 'Typed in Foundry', want: {}, kept: ['GM Notes'] },
    { name: 'does nothing to an empty path', director: '', want: {}, kept: [] },
    { name: 'does nothing to a missing path', director: undefined, want: {}, kept: [] },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const plan = planGmFieldClear({ actor: hero(c.director), entity: ENTITY, fields: FIELDS_NOW });
      assert.deepEqual(plan.update, c.want);
      assert.deepEqual(plan.kept, c.kept);
      assert.equal(plan.keptMark !== '', c.kept.length > 0);
      assert.ok(!plan.keptMark.includes('Typed'), 'the mark never holds the text itself');
    });
  }
  await t.test('text left when Chronicle has none is kept, not erased', () => {
    const plan = planGmFieldClear({ actor: hero('GM wrote this in Foundry'), entity: { fields_data: {} }, fields: FIELDS_NOW });
    assert.deepEqual(plan.update, {});
    assert.deepEqual(plan.kept, ['GM Notes']);
  });
  await t.test('the mark changes when the text does', () => {
    const a = planGmFieldClear({ actor: hero('one'), entity: ENTITY, fields: FIELDS_NOW }).keptMark;
    const b = planGmFieldClear({ actor: hero('two'), entity: ENTITY, fields: FIELDS_NOW }).keptMark;
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  });
});

test('holdsGmFieldText', () => {
  assert.equal(holdsGmFieldText({ system: { biography: { director: SECRET } } }, FIELDS_NOW), true);
  assert.equal(holdsGmFieldText({ system: { biography: { director: '   ' } } }, FIELDS_NOW), false);
  assert.equal(holdsGmFieldText({ system: {} }, FIELDS_NOW), false);
  assert.equal(holdsGmFieldText({ system: { biography: { director: SECRET } } }, []), false);
});

test('a field one page marks GM-only is not written for that page', async () => {
  const adapter = await adapterFor(FIELDS_NOW);
  const page = { ...ENTITY, field_overrides: { added: [{ key: 'backstory', gm_only: true }, { key: 'might' }] } };
  const update = adapter.fromChronicleFields(page);
  assert.equal(update['system.biography.value'], undefined);
  assert.equal(update['system.characteristics.might.value'], 2);
  assert.equal(adapter.fromChronicleFields(ENTITY)['system.biography.value'], 'Born under ash');
});

test('creature and item updates skip a field one page marks GM-only', () => {
  const lore = { key: 'lore', label: 'Lore', foundry_path: 'system.description.value' };
  const page = { name: 'Goblin', fields_data: { lore: SECRET }, field_overrides: { added: [{ key: 'lore', gm_only: true }] } };
  assert.ok(!JSON.stringify(creatureUpdate({ entity: page, fields: [lore], choicesFor: () => null }).update).includes(SECRET));
  const item = treasureUpdate({ entity: page, fields: [lore], choicesFor: () => null, showWords: true });
  assert.ok(!JSON.stringify(item.update).includes(SECRET), JSON.stringify(item.update));
  const open = { ...page, field_overrides: undefined };
  assert.ok(JSON.stringify(creatureUpdate({ entity: open, fields: [lore], choicesFor: () => null }).update).includes(SECRET));
});
