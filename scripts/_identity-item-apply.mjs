/**
 * Carries out one identity-item swap from `_identity-item-plan.mjs`: finds the
 * named item in the world or a compendium, embeds it on the actor and removes
 * the actor's old item of that type. Takes `game` as a parameter so tests can
 * pass a fake world.
 */
import { FLAG_SCOPE, syncOptions, APPLY_OPTION } from './constants.mjs';
import { findEntry, entryItemFill } from './_campaign-entry-item.mjs';
import { mentionLookup } from './_entry-text.mjs';

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Marks these writes as sync's own so no item or actor hook pushes them back. */
const writeOptions = () => syncOptions({ [APPLY_OPTION]: true });

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
 * a failed create leaves the sheet as it was. A Foundry item of that name wins
 * over the campaign's entry, since it may carry the system's own advancements.
 * @param {Array<object>} [entries] - the campaign's entries for this field
 * @param {object} [entryFields] - the field's `foundry_entry_fields`
 * @param {object} [entryEffects] - the field's `foundry_entry_effects`
 * @returns {Promise<'found'|'made'>}
 */
export async function applyIdentityItem(actor, step, game, entries, entryFields, entryEffects) {
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
    const fill = entryItemFill(findEntry(entries, step.wantName), { mentionId: journalMentions(game), entryFields, entryEffects });
    if (fill) Object.assign(data, fill);
  }
  await actor.createEmbeddedDocuments('Item', [data], writeOptions());
  if (step.removeIds.length) {
    await actor.deleteEmbeddedDocuments('Item', step.removeIds, writeOptions());
  }
  return source ? 'found' : 'made';
}

/**
 * Chronicle page ids by journal name, for the mentions in an entry's text.
 * @returns {(name: string) => string|null}
 */
export function journalMentions(game) {
  const journals = [];
  for (const j of game?.journal ?? []) {
    const entityId = j?.getFlag?.(FLAG_SCOPE, 'entityId');
    if (entityId) journals.push({ name: j.name, entityId });
  }
  return mentionLookup(journals);
}

/**
 * Apply a whole plan; one failed step does not stop the rest.
 * @param {Record<string, Array<object>>} [entriesByField]
 * @param {Record<string, object>} [entryFieldsByField] - each field's `foundry_entry_fields`
 * @param {Record<string, object>} [entryEffectsByField] - each field's `foundry_entry_effects`
 * @returns {Promise<{done: string[], failed: string[]}>} field keys
 */
export async function applyIdentityPlan(actor, plan, game, entriesByField, entryFieldsByField, entryEffectsByField) {
  const done = [];
  const failed = [];
  for (const step of plan) {
    try {
      await applyIdentityItem(actor, step, game, entriesByField?.[step.fieldKey], entryFieldsByField?.[step.fieldKey], entryEffectsByField?.[step.fieldKey]);
      done.push(step.fieldKey);
    } catch (err) {
      console.error(`Chronicle: could not set ${step.fieldKey} "${step.wantName}" on "${actor.name}"`, err);
      failed.push(step.fieldKey);
    }
  }
  return { done, failed };
}

/**
 * Rewrite the text of items sync made whose campaign entry changed
 * (`planEntryRefresh`), one write for all of them, then each item's own
 * effect. Only the effect sync put there is rewritten or taken off.
 * @returns {Promise<string[]>} the field keys refreshed
 */
export async function applyEntryRefresh(actor, refresh) {
  if (!refresh.length) return [];
  await actor.updateEmbeddedDocuments('Item', refresh.map((r) => r.update), writeOptions());
  for (const { itemId, effect } of refresh) {
    const item = effect && actor.items?.get?.(itemId);
    if (!item) continue;
    if (effect.create) await item.createEmbeddedDocuments('ActiveEffect', [effect.create], writeOptions());
    if (effect.update) await item.updateEmbeddedDocuments('ActiveEffect', [effect.update], writeOptions());
    if (effect.remove) await item.deleteEmbeddedDocuments('ActiveEffect', [effect.remove], writeOptions());
  }
  return refresh.map((r) => r.fieldKey);
}
