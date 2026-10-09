/**
 * Carries out one identity-item swap from `_identity-item-plan.mjs`: finds the
 * named item in the world or a compendium, embeds it on the actor and removes
 * the actor's old item of that type. Takes `game` as a parameter so tests can
 * pass a fake world.
 */
import { FLAG_SCOPE, SYNC_OPTIONS, APPLY_OPTION } from './constants.mjs';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Marks these writes as sync's own so no item or actor hook pushes them back. */
const WRITE_OPTIONS = Object.freeze({ ...SYNC_OPTIONS, [APPLY_OPTION]: true });

/** Item compendiums, the game system's own first. */
function itemPacks(game) {
  const packs = Array.from(game?.packs ?? []).filter(
    (p) => (p?.documentName ?? p?.metadata?.type) === 'Item',
  );
  const rank = (p) => (p?.metadata?.packageType === 'system' ? 0 : 1);
  return packs.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
}

/**
 * Find an Item of this type and name: the world's items first, then
 * compendiums. The pack index is read with only `type` so packs are not loaded
 * whole.
 * @returns {Promise<object|null>} an Item document, or null
 */
export async function findIdentityItem(game, itemType, name) {
  const want = norm(name);
  const inWorld = Array.from(game?.items ?? []).find((it) => it.type === itemType && norm(it.name) === want);
  if (inWorld) return inWorld;
  for (const pack of itemPacks(game)) {
    let index;
    try {
      index = await pack.getIndex({ fields: ['type'] });
    } catch (err) {
      console.warn(`Chronicle: could not read compendium "${pack.collection}" for "${name}"`, err);
      continue;
    }
    const entry = Array.from(index ?? []).find((e) => e.type === itemType && norm(e.name) === want);
    if (!entry) continue;
    try {
      const doc = await pack.getDocument(entry._id);
      if (doc) return doc;
    } catch (err) {
      console.warn(`Chronicle: could not load "${name}" from compendium "${pack.collection}"`, err);
    }
  }
  return null;
}

/**
 * Apply one planned swap. The new item is created before the old ones go, so
 * a failed create leaves the sheet as it was.
 * @returns {Promise<'found'|'made'>}
 */
export async function applyIdentityItem(actor, step, game) {
  const source = await findIdentityItem(game, step.itemType, step.wantName);
  let data;
  if (source) {
    data = typeof source.toObject === 'function' ? source.toObject() : { ...source };
    // A fresh id, and no folder or ownership belonging to the source's world or pack.
    delete data._id;
    delete data.folder;
    delete data.ownership;
  } else {
    // A campaign's own entry has no Foundry item to copy; the flag marks it as made here.
    data = { name: step.wantName, type: step.itemType, flags: { [FLAG_SCOPE]: { chronicleMade: true } } };
  }
  await actor.createEmbeddedDocuments('Item', [data], { ...WRITE_OPTIONS });
  if (step.removeIds.length) {
    await actor.deleteEmbeddedDocuments('Item', step.removeIds, { ...WRITE_OPTIONS });
  }
  return source ? 'found' : 'made';
}

/**
 * Apply a whole plan; one failed step does not stop the rest.
 * @returns {Promise<{done: string[], failed: string[]}>} field keys
 */
export async function applyIdentityPlan(actor, plan, game) {
  const done = [];
  const failed = [];
  for (const step of plan) {
    try {
      await applyIdentityItem(actor, step, game);
      done.push(step.fieldKey);
    } catch (err) {
      console.error(`Chronicle: could not set ${step.fieldKey} "${step.wantName}" on "${actor.name}"`, err);
      failed.push(step.fieldKey);
    }
  }
  return { done, failed };
}
