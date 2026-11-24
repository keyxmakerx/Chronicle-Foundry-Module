/**
 * Chronicle Sync - switching a linked actor between hero and NPC
 *
 * An actor made as the wrong type (an NPC page's actor made as a hero before
 * sync told them apart, or a page that later became a hero) is switched only
 * when the GM says yes. Actors arriving together are asked about in one
 * question per direction; a No is remembered per actor and direction, so the
 * GM is not asked about that actor again. Only the active GM is asked. What a
 * switch keeps and drops is planned in `_npc-character.mjs`.
 */

import { confirmDialog } from './_dialogs.mjs';
import { escapeHtml, noticeText } from './_escape-html.mjs';
import { getSetting, setSetting } from './settings.mjs';
import { syncOptions, APPLY_OPTION } from './constants.mjs';
import { isAnsweringGM } from './_stash-relay.mjs';
import { planTypeSwitch, carriedSystem } from './_npc-character.mjs';

/** How long after the last offer the question waits for more to arrive. */
const ASK_WAIT_MS = 400;

/** At most this many names are listed; the rest are counted. */
const LIST_MAX = 20;

/** Options marking a write as sync's own, a fresh object per write. */
function applyOptions(extra = {}) {
  return syncOptions({ [APPLY_OPTION]: true, ...extra });
}

/**
 * The update that changes the type and replaces the system data whole, as
 * a type change requires: `_replace` where Foundry has it, else the older
 * `==system` key.
 */
function typeUpdate(toType, system) {
  if (typeof globalThis._replace === 'function') return { type: toType, system: globalThis._replace(system) };
  return { type: toType, '==system': system };
}

/**
 * Switch an actor to `toType`. Items the new type cannot hold are removed
 * first; for Draw Steel a hero's basic actions go with them, and come back
 * when the actor becomes a hero. The actor's name, pictures, tokens,
 * ownership, folder, flags, notes and other items stay. Every write is
 * marked as sync's own, so no hook sends it to Chronicle.
 * @param {Actor} actor
 * @param {string} toType
 * @param {{heroType: string}} opts
 */
export async function switchActorType(actor, toType, { heroType }) {
  const items = (actor.items?.contents ?? Array.from(actor.items ?? [])).map((i) => ({ id: i.id, type: i.type }));
  const plan = planTypeSwitch({
    items,
    toType,
    heroType,
    invalidTypesOf: (t) => globalThis.CONFIG?.Item?.dataModels?.[t]?.metadata?.invalidActorTypes,
    basicUuids: [...(globalThis.ds?.CONFIG?.hero?.defaultItems ?? [])],
  });
  if (plan.removeIds.length) await actor.deleteEmbeddedDocuments('Item', plan.removeIds, applyOptions());
  const plain = typeof actor.system?.toObject === 'function' ? actor.system.toObject() : actor.system;
  // Written whole (`diff: false`), the way Draw Steel's own type migrations
  // write a type change.
  await actor.update(typeUpdate(toType, carriedSystem(plain)), applyOptions({ diff: false }));
  if (!plan.addUuids.length) return;
  const found = await Promise.all(plan.addUuids.map((u) => Promise.resolve(globalThis.fromUuid?.(u)).catch(() => null)));
  const data = found.filter(Boolean).map((d) => game.items.fromCompendium(d, { keepId: true, clearFolder: true }));
  if (data.length) await actor.createEmbeddedDocuments('Item', data, applyOptions({ keepId: true }));
}

/**
 * Collects actors offered for a switch and asks the GM once per burst.
 */
export class ActorTypeSwitch {
  /**
   * @param {{heroType: string, npcType: string,
   *   run: (actor: Actor, toType: string, entity: object) => Promise<void>,
   *   delayMs?: number}} opts - `run` switches one actor (and applies its page after).
   */
  constructor({ heroType, npcType, run, delayMs = ASK_WAIT_MS }) {
    this._heroType = heroType;
    this._npcType = npcType;
    this._run = run;
    this._delayMs = delayMs;
    /** @type {Map<string, {actor: Actor, toType: string, entity: object}>} */
    this._queued = new Map();
    /** Actor ids in the question on screen now. */
    this._asking = new Set();
    this._timer = null;
    /** Each burst's question waits for the one before it to be answered. */
    this._chain = Promise.resolve();
  }

  /** Whether the GM already said No to this actor becoming `toType`. */
  declined(actorId, toType) {
    return this._declinedMap()[actorId] === toType;
  }

  /** @private */
  _declinedMap() {
    const v = getSetting('actorTypeDeclined');
    return v && typeof v === 'object' ? v : {};
  }

  /**
   * Offer one actor for a switch to `toType`. Ignored on any client but the
   * active GM's, and for an actor declined or already being asked about.
   * @param {Actor} actor
   * @param {string} toType
   * @param {object} entity - the actor's Chronicle page
   * @returns {boolean} whether it was queued for the question
   */
  offer(actor, toType, entity) {
    if (!actor?.id || !toType || !isAnsweringGM(game.user, game.users?.activeGM)) return false;
    if (this._asking.has(actor.id) || this.declined(actor.id, toType)) return false;
    this._queued.set(actor.id, { actor, toType, entity });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.flush(); }, this._delayMs);
    return true;
  }

  /**
   * Ask about everything queued now. Resolves once answered and done.
   * @returns {Promise<void>}
   */
  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    const batch = [...this._queued.values()];
    this._queued.clear();
    for (const e of batch) this._asking.add(e.actor.id);
    this._chain = this._chain.then(() => this._answer(batch)).catch((err) => {
      console.warn('Chronicle: could not ask about switching actor types', err);
    }).finally(() => {
      for (const e of batch) this._asking.delete(e.actor.id);
    });
    return this._chain;
  }

  /** @private */
  async _answer(batch) {
    for (const toType of [this._npcType, this._heroType]) {
      const group = batch.filter((e) => e.toType === toType && game.actors?.get?.(e.actor.id));
      if (!group.length) continue;
      const yes = await this._ask(toType, group);
      if (!yes) {
        await this._decline(group);
        continue;
      }
      let done = 0;
      const failed = [];
      for (const e of group) {
        try {
          await this._run(e.actor, toType, e.entity);
          done++;
        } catch (err) {
          console.error(`Chronicle: could not switch "${e.actor.name}" to ${toType}`, err);
          failed.push(e.actor.name);
        }
      }
      const doneKey = toType === this._npcType ? 'CHRONICLE.ActorType.ToNpcDone' : 'CHRONICLE.ActorType.ToHeroDone';
      if (done) ui.notifications?.info?.(game.i18n.format(doneKey, { count: done }));
      if (failed.length) ui.notifications?.warn?.(game.i18n.format('CHRONICLE.ActorType.Failed', { names: noticeText(failed.join(', ')) }));
    }
  }

  /** @private */
  async _ask(toType, group) {
    const kind = toType === this._npcType ? 'ToNpc' : 'ToHero';
    const shown = group.slice(0, LIST_MAX).map((e) => `<li>${escapeHtml(e.actor.name)}</li>`).join('');
    const more = group.length > LIST_MAX
      ? `<li>${escapeHtml(game.i18n.format('CHRONICLE.ActorType.More', { count: group.length - LIST_MAX }))}</li>`
      : '';
    return confirmDialog({
      title: game.i18n.localize(`CHRONICLE.ActorType.${kind}Title`),
      content: game.i18n.format(`CHRONICLE.ActorType.${kind}Body`, { count: group.length, list: `<ul>${shown}${more}</ul>` }),
      defaultYes: true,
    });
  }

  /** Remember a No, so these actors are not offered again. @private */
  async _decline(group) {
    const next = { ...this._declinedMap() };
    for (const e of group) next[e.actor.id] = e.toType;
    await setSetting('actorTypeDeclined', next);
    const count = group.length;
    ui.notifications?.info?.(game.i18n.format('CHRONICLE.ActorType.Declined', { count }));
  }
}
