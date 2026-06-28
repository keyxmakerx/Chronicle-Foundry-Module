#!/usr/bin/env node
/**
 * Unit tests for the Sync Capability Inspector
 * (`scripts/capability-inspector.mjs`).
 *
 * Run: `node --test tools/test-capability-inspector.mjs`
 * Uses Node's built-in `node:test`; the inspected layers are pure (and the
 * "live actor" layer takes a plain test double), so no Foundry globals needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  walkSchema,
  captureActorSnapshot,
  buildCapabilityReport,
  renderCapabilityMarkdown,
  renderCapabilityJSON,
  CAP_STATUS,
} = await import('../scripts/capability-inspector.mjs');

// A Foundry-ish actor test double: system is a DataModel (has toObject), items
// and effects are collections (have .contents), flags is plain.
function makeActor() {
  return {
    id: 'a1',
    name: 'Orrin Goldwind',
    type: 'hero',
    system: {
      toObject() {
        return {
          characteristics: { might: { value: 2 }, agility: { value: 0 } },
          stamina: { value: 33, max: 33 },
          biography: 'Born beneath the broken peak of Cinderhold…',
        };
      },
    },
    items: {
      contents: [
        { type: 'ability', name: 'Ashfall Strike', system: { keywords: ['melee'] } },
        { type: 'kit', name: 'Mountain', system: {} },
      ],
    },
    effects: { contents: [{ type: 'condition' }, { type: 'condition' }] },
    flags: { 'chronicle-sync': { entityId: 'ent-1' } },
  };
}

const FIELD_DEFS = {
  preset_slug: 'drawsteel-character',
  foundry_actor_type: 'hero',
  fields: [
    { key: 'might', foundry_path: 'system.characteristics.might.value', type: 'number', foundry_writable: false },
    { key: 'stamina_current', foundry_path: 'system.stamina.value', type: 'number' },
    { key: 'abilities_json', type: 'string' }, // declared but no foundry_path
    { key: 'speed', foundry_path: 'system.movement.speed', type: 'number' }, // absent on actor
  ],
};

test('walkSchema flattens nested objects, summarizes arrays, caps depth', () => {
  const rows = walkSchema({ a: { b: { c: 1 } }, list: [1, 2, 3], s: 'hi', n: null }, 'system');
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(byPath['system.a.b.c'].type, 'number');
  assert.equal(byPath['system.list'].type, 'array');
  assert.equal(byPath['system.list'].sample, '[3]');
  assert.equal(byPath['system.s'].sample, 'hi');
  assert.equal(byPath['system.n'].type, 'null');
});

test('captureActorSnapshot reads system (via toObject), items, effects, flags', () => {
  const snap = captureActorSnapshot(makeActor());
  assert.equal(snap.ok, true);
  assert.equal(snap.actorType, 'hero');
  const paths = snap.system.map((r) => r.path);
  assert.ok(paths.includes('system.characteristics.might.value'));
  assert.ok(paths.includes('system.stamina.value'));
  assert.equal(snap.items.available, true);
  assert.equal(snap.items.count, 2);
  assert.deepEqual(snap.items.types.sort(), ['ability', 'kit']);
  assert.equal(snap.items.sample.name, 'Ashfall Strike');
  assert.equal(snap.effects.count, 2);
  assert.ok(snap.flags.some((r) => r.path === 'flags.chronicle-sync.entityId'));
});

test('captureActorSnapshot is defensive (null / throwing actor never throws)', () => {
  assert.equal(captureActorSnapshot(null).ok, false);
  const bad = { get system() { throw new Error('boom'); }, name: 'x' };
  assert.doesNotThrow(() => captureActorSnapshot(bad));
});

test('buildCapabilityReport classifies synced / mapped-missing / declared-unmapped / available-unmapped', () => {
  const report = buildCapabilityReport(captureActorSnapshot(makeActor()), FIELD_DEFS);
  assert.equal(report.ok, true);
  const byKey = Object.fromEntries(report.fields.filter((r) => r.key).map((r) => [r.key, r]));
  assert.equal(byKey.might.status, CAP_STATUS.SYNCED);
  assert.equal(byKey.might.sample, 2);
  assert.equal(byKey.might.writable, false);
  assert.equal(byKey.stamina_current.status, CAP_STATUS.SYNCED);
  assert.equal(byKey.abilities_json.status, CAP_STATUS.DECLARED_UNMAPPED);
  assert.equal(byKey.speed.status, CAP_STATUS.MAPPED_MISSING);

  // biography + stamina.max etc. are available but unmapped → candidates
  const unmapped = report.fields.filter((r) => r.status === CAP_STATUS.AVAILABLE_UNMAPPED).map((r) => r.foundry_path);
  assert.ok(unmapped.includes('system.biography'));
  assert.ok(unmapped.includes('system.stamina.max'));

  // collections surfaced (not pullable yet)
  assert.equal(report.collections.length, 2);
  assert.ok(report.collections.some((c) => c.source === 'actor.items' && c.count === 2));

  // summary
  assert.equal(report.summary.synced, 2);
  assert.equal(report.summary.declaredUnmapped, 1);
  assert.equal(report.summary.mappedMissing, 1);
  assert.ok(report.summary.availableUnmapped >= 2);
});

test('buildCapabilityReport: a foundry_collection field is collection-mapped, not declared-unmapped', () => {
  const defs = {
    preset_slug: 'drawsteel-character',
    foundry_actor_type: 'hero',
    fields: [
      { key: 'abilities_json', type: 'string', foundry_collection: 'items', foundry_item_type: ['ability'] },
      { key: 'class', type: 'string', foundry_collection: 'items', foundry_item_type: ['class'], foundry_item_single: true },
      { key: 'immunities', type: 'string' }, // genuinely unmapped (no path, no collection)
    ],
  };
  const report = buildCapabilityReport(captureActorSnapshot(makeActor()), defs);
  const byKey = Object.fromEntries(report.fields.filter((r) => r.key).map((r) => [r.key, r]));
  assert.equal(byKey.abilities_json.status, CAP_STATUS.COLLECTION_MAPPED);
  assert.equal(byKey.class.status, CAP_STATUS.COLLECTION_MAPPED);
  assert.match(byKey.class.foundry_path, /items\[class\] \(single\)/); // descriptor surfaced
  assert.equal(byKey.immunities.status, CAP_STATUS.DECLARED_UNMAPPED);
  assert.equal(report.summary.collectionMapped, 2);
  assert.equal(report.summary.declaredUnmapped, 1);
});

test('collections expose a sample item schema per type (enables item-field mapping)', () => {
  const report = buildCapabilityReport(captureActorSnapshot(makeActor()), FIELD_DEFS);
  const items = report.collections.find((c) => c.source === 'actor.items');
  assert.ok(items, 'expected actor.items collection');
  const byType = Object.fromEntries((items.samples || []).map((s) => [s.type, s]));
  assert.ok(byType.ability && byType.kit, 'expected one sample per distinct type');
  // the ability sample exposes its system fields (e.g. keywords) for projection
  assert.ok(byType.ability.schema.some((r) => r.path === 'system.keywords'));
  // and the markdown renders the per-type schema lines
  const md = renderCapabilityMarkdown(report);
  assert.match(md, /\*\*ability\*\* — e\.g\. "Ashfall Strike"/);
});

test('renderers produce a titled markdown report and valid JSON; bad input tolerated', () => {
  const report = buildCapabilityReport(captureActorSnapshot(makeActor()), FIELD_DEFS);
  const md = renderCapabilityMarkdown(report);
  assert.match(md, /# Sync Capability — drawsteel-character/);
  assert.match(md, /Synced: \*\*2\*\*/);
  assert.match(md, /actor\.items/);
  assert.doesNotThrow(() => JSON.parse(renderCapabilityJSON(report)));
  // bad input never throws
  assert.match(renderCapabilityMarkdown({ ok: false, error: 'x' }), /Could not build report/);
  assert.equal(buildCapabilityReport({ ok: false }, FIELD_DEFS).ok, false);
});
