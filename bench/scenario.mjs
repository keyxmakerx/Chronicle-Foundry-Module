/**
 * What every bench scenario shares: the end-of-scenario health checks and
 * the scenario wrapper (fresh campaign, fresh world, checks, close).
 */
import assert from 'node:assert/strict';
import { seedCampaign } from './chronicle.mjs';
import { newWorld, closeWorld, settle, traffic } from './world.mjs';

export const FLAG = 'chronicle-sync';
export const linked = (world) => world.game.journal.contents.filter((j) => j.getFlag(FLAG, 'entityId'));
export const byEntity = (world, id) => world.game.journal.find((j) => j.getFlag(FLAG, 'entityId') === id);
// Sync-history reports are a log of the sync, not world data, so they never
// count as the module writing to Chronicle.
export const writes = (reqs) => reqs.filter((r) => r.method !== 'GET' && !r.url.startsWith('/sync/history'));
export const pageText = (j) => j.pages.contents.map((p) => p.text?.content || '').join('');

/** The checks every scenario must pass, whatever it did. */
export async function assertHealthy(world, seed, since = 0) {
  const entities = await seed.chronicle.allEntities();
  const names = entities.map((e) => e.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'no duplicate pages in Chronicle');
  const ids = linked(world).map((j) => j.getFlag(FLAG, 'entityId'));
  assert.deepEqual(ids.filter((n, i) => ids.indexOf(n) !== i), [], 'no two journals linked to one page');
  const actorIds = world.game.actors.contents.map((a) => a.getFlag(FLAG, 'entityId')).filter(Boolean);
  assert.deepEqual(actorIds.filter((n, i) => actorIds.indexOf(n) !== i), [], 'no two actors linked to one character');
  assert.deepEqual(actorIds.filter((id) => ids.includes(id)), [], 'no character is both an actor and a journal');
  // Server errors and dropped requests fail anything; a refused write fails
  // too, except a 409 (a version check doing its job). A 404 on a read is
  // normal (lookups, pages removed in Chronicle).
  const failed = traffic.requests.slice(since).filter((r) => r.status >= 500 || r.status === 0
    || (r.method !== 'GET' && r.status >= 400 && r.status !== 409));
  assert.deepEqual(failed.map((r) => `${r.method} ${r.url} ${r.status}`), [], 'no failed requests');
  assert.deepEqual(world.log.hookErrors.map((e) => `${e.name}: ${e.err?.message}`), [], 'no hook errors');
  assert.deepEqual(world.log.notifications.error, [], 'no error pop-ups');
  // Both sides agree on every linked page's name once things are quiet.
  const byId = new Map(entities.map((e) => [e.id, e]));
  const disagree = linked(world)
    .filter((j) => byId.has(j.getFlag(FLAG, 'entityId')) && byId.get(j.getFlag(FLAG, 'entityId')).name !== j.name)
    .map((j) => `${j.name} ≠ ${byId.get(j.getFlag(FLAG, 'entityId')).name}`);
  assert.deepEqual(disagree, [], 'both sides converge');
  return entities;
}

/** A page made in Chronicle by someone else, with body text. */
export async function chroniclePage(seed, name, html = `<p>${name} text</p>`) {
  const types = await seed.chronicle.entityTypes();
  const e = await seed.chronicle.post('/entities', { name, entity_type_id: types[0].id, is_private: false });
  if (html) await seed.chronicle.put(`/entities/${e.id}`, { entry: html });
  return e;
}

export async function scenario(label, fn, { settings } = {}) {
  const seed = await seedCampaign(label);
  const world = newWorld(seed, { settings });
  const since = traffic.requests.length;
  try {
    await fn({ seed, world });
    await settle();
    await assertHealthy(world, seed, since);
  } finally {
    await closeWorld(world);
  }
}
